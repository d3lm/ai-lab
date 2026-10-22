"""Runs the mutation-test-review skill headlessly over every eval case and grades it.

Each (case, rep) gets a fresh fixture repo outside this checkout with the skill
copied into .claude/skills/. The runner invokes `claude -p "/mutation-test-review
<args>"`, saves the transcript, checks that the fixture tree is unchanged, and has
the judge grade the final report against the case's answer key.

Full output (per variant, gitignored) goes to runs/<variant>/:
  results.jsonl   one row per scored (case, rep), with the report and the judge's reasoning
  errors.jsonl    attempts that produced nothing scorable (timeouts, crashes, judge failures)
  traces/<case>_rep<k>.json

When a run or regrade finishes, the variant's scores are exported to the committed results/:
  state.json      train/test split, approved harness digest, one-line change note per variant
  scores.csv      one row per (variant, case, rep): grades, cost, latency

Usage:
  python3 run_eval.py approve-harness              # the user's step: record the harness digest
  python3 run_eval.py run --variant baseline [--cases a b] [--reps 1] [--split train|test] [-j 4]
  python3 run_eval.py regrade --variant v1 [--cases a b]
  python3 run_eval.py export [--variant v1]        # rewrite results/ from runs/ (all variants by default)
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import random
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import fixture
import judge

RUNS_DIR = fixture.EVAL_DIR / "runs"
RESULTS_DIR = fixture.EVAL_DIR / "results"
STATE = RESULTS_DIR / "state.json"
SCORES = RESULTS_DIR / "scores.csv"
GRADE_FIELDS = ("score", "recall", "verified", "actionable", "verdict_ok", "top_fix_ok", "false_claims", "tree_clean")
PERF_FIELDS = ("cost_usd", "judge_cost_usd", "latency_s", "tool_calls", "num_turns")
SCORE_FIELDS = ("variant", "case", "split", "rep", *GRADE_FIELDS, *PERF_FIELDS, "skill_sha")
MODEL = "claude-opus-5-5"
WORK_ROOT = Path(tempfile.gettempdir()) / "mtr-eval"
HARNESS_FILES = ["run_eval.py", "judge.py", "fixture.py"]

USAGE_KEYS = (
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
)

SNAPSHOT_KEYS = (
  "head",
  "branch",
  "status",
  "diff_sha",
  "stash",
  "worktrees",
  "branches",
)

_lock = threading.Lock()


def harness_digest() -> str:
  digest = hashlib.sha256()
  paths = [fixture.EVAL_DIR / name for name in HARNESS_FILES]
  paths += sorted(path for path in fixture.CASES_DIR.rglob("*") if path.is_file())

  for path in paths:
    digest.update(str(path.relative_to(fixture.EVAL_DIR)).encode())
    digest.update(path.read_bytes())

  return digest.hexdigest()


def load_state() -> dict:
  return json.loads(STATE.read_text()) if STATE.exists() else {}


def check_gate() -> None:
  approved = load_state().get("harness_sha")

  if approved != harness_digest():
    sys.exit(
      "harness changed since it was last approved (runner, judge, fixture builder, or cases).\n"
      "Review the change, then run: python3 evals/mutation-test-review/run_eval.py approve-harness"
    )


def scope_diff(repo: Path, case: dict) -> str:
  if case["mode"] == "branch":
    return fixture.git(repo, "diff", "main...feature")

  tmp_index = repo / ".git" / "eval-index"
  env = {**os.environ, "GIT_INDEX_FILE": str(tmp_index)}
  shutil.copy(repo / ".git" / "index", tmp_index)

  subprocess.run(["git", "add", "-N", "."], cwd=repo, env=env, check=True, capture_output=True)
  diff = subprocess.run(
    ["git", "diff", "HEAD"],
    cwd=repo,
    env=env,
    check=True,
    capture_output=True,
    text=True,
  ).stdout

  tmp_index.unlink()

  return diff


def stream_to_trace(prompt: str, events: list[dict]) -> tuple[list[dict], int]:
  """Converts claude stream-json events to the report's trace format."""
  trace: list[dict] = [{"role": "user", "content": prompt}]
  tool_calls = 0

  for event in events:
    if event.get("type") == "assistant":
      pending_thinking = None

      for block in event["message"].get("content", []):
        kind = block.get("type")

        if kind == "thinking" and block.get("thinking"):
          pending_thinking = block["thinking"]
        elif kind == "text" and block.get("text", "").strip():
          turn = {"role": "assistant", "content": block["text"]}

          if pending_thinking:
            turn["thinking"], pending_thinking = pending_thinking, None

          trace.append(turn)
        elif kind == "tool_use":
          tool_calls += 1
          turn = {
            "role": "tool_call",
            "name": block.get("name", ""),
            "content": json.dumps(block.get("input", {}), indent=2),
          }

          if pending_thinking:
            turn["thinking"], pending_thinking = pending_thinking, None

          trace.append(turn)
    elif event.get("type") == "user":
      content = event.get("message", {}).get("content", [])

      if isinstance(content, list):
        for block in content:
          if block.get("type") == "tool_result":
            body = block.get("content")

            if isinstance(body, list):
              body = "\n".join(part.get("text", "") for part in body if isinstance(part, dict))

            trace.append({"role": "tool_result", "content": str(body)})

  return trace, tool_calls


def run_skill(repo: Path, case: dict, timeout_s: int, log_path: Path) -> dict:
  prompt = f"/mutation-test-review {case['args']}".rstrip()

  cmd = [
    "claude",
    "-p",
    prompt,
    "--model",
    MODEL,
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
    "--no-session-persistence",
    "--settings",
    json.dumps({"fastMode": False}),
  ]

  env = {name: value for name, value in os.environ.items() if name not in ("CARGO_TARGET_DIR",)}

  start = time.monotonic()

  with open(log_path, "w") as log:
    proc = subprocess.Popen(
      cmd,
      cwd=repo,
      stdout=log,
      stderr=subprocess.STDOUT,
      env=env,
      start_new_session=True,
    )

    try:
      proc.wait(timeout=timeout_s)
    except subprocess.TimeoutExpired:
      os.killpg(proc.pid, 9)
      proc.wait()

      return {"timeout": True, "latency_s": time.monotonic() - start}

  latency = time.monotonic() - start
  events = []

  for line in log_path.read_text().splitlines():
    try:
      events.append(json.loads(line))
    except json.JSONDecodeError:
      pass

  result = next((event for event in reversed(events) if event.get("type") == "result"), None)
  trace, tool_calls = stream_to_trace(prompt, events)

  return {
    "timeout": False,
    "latency_s": latency,
    "result": result,
    "trace": trace,
    "tool_calls": tool_calls,
    "returncode": proc.returncode,
    "prompt": prompt,
  }


VERIFY_CREDIT = {"yes": 1.0, "not_claimed": 1.0, "partial": 0.5, "no": 0.0}


def verified_share(verification: dict | None) -> float:
  """Share of suggested tests whose verification claims the transcript backs (1.0 when none suggested)."""
  tests = (verification or {}).get("tests", [])

  if not tests:
    return 1.0

  def credit(test: dict) -> float:
    if test["kills_supported"] == "not_claimed":
      return 1.0

    return VERIFY_CREDIT[test["kills_supported"]] if test["executed"] else 0.0

  return sum(map(credit, tests)) / len(tests)


def score_row(case: dict, verdict: dict, tree_clean: bool, verification: dict | None = None) -> dict:
  defects = verdict["defects"]
  defect_count = len(defects)
  found = sum(defect["identified"] for defect in defects)
  fixed = sum(defect["identified"] and defect["fix_proposed"] for defect in defects)
  major_claims = sum(claim["severity"] == "major" for claim in verdict["false_claims"])

  if case.get("control"):
    recall = actionable = 1.0 if (verdict["verdict_ok"] and major_claims == 0) else 0.0
  else:
    recall = found / defect_count
    actionable = fixed / defect_count

  verified = verified_share(verification)

  return {
    "score": recall * verified,
    "recall": recall,
    "verified": verified,
    "actionable": actionable,
    "verdict_ok": float(verdict["verdict_ok"]),
    "top_fix_ok": float(verdict["top_fix_targets_key_defect"]),
    "false_claims": float(major_claims),
    "tree_clean": float(tree_clean),
  }


def explanation(verdict: dict, verification: dict | None = None) -> dict:
  tests = [
    f"{test['name']}: executed={test['executed']} kills={test['kills_supported']} -- {test['evidence']}"
    for test in (verification or {}).get("tests", [])
  ]

  lines = [
    f"{'FOUND' if defect['identified'] else 'missed'}"
    f"{' +fix' if defect['fix_proposed'] else ''} "
    f"{defect['id']}: {defect['evidence']}"
    for defect in verdict["defects"]
  ]

  claims = [f"[{claim['severity']}] {claim['claim']} -- {claim['why_wrong']}" for claim in verdict["false_claims"]]

  return {
    "score": "\n".join(lines) or "(control)",
    "false_claims": "\n".join(claims) or "none",
    "verdict_ok": verdict["verdict_reason"],
    "verified": "\n".join(tests) or "no tests suggested",
  }


def append(path: Path, row: dict) -> None:
  with _lock, open(path, "a") as file:
    file.write(json.dumps(row) + "\n")


def run_one(
  variant: str,
  vdir: Path,
  skill_dir: Path,
  case_id: str,
  rep: int,
  timeout_s: int,
  keep: bool,
) -> str:
  case = fixture.load_case(case_id)
  work = WORK_ROOT / variant / f"{case_id}_rep{rep}"

  if work.exists():
    shutil.rmtree(work)

  work.mkdir(parents=True)

  repo = work / "repo"
  fixture.build(case_id, repo, skill_dir)
  diff = scope_diff(repo, case)
  before = fixture.snapshot(repo)
  run = run_skill(repo, case, timeout_s, work / "stream.jsonl")
  errors_path = vdir / "errors.jsonl"
  base_err = {"prompt_id": case_id, "rep": rep, "variant": variant, "work": str(work)}
  label = f"{case_id} rep{rep}"

  if run["timeout"]:
    append(
      errors_path,
      {**base_err, "failure_class": "timeout", "latency_s": run["latency_s"]},
    )

    return f"{label}: TIMEOUT"

  result = run["result"]

  if not result or result.get("is_error") or result.get("subtype") != "success":
    append(
      errors_path,
      {
        **base_err,
        "failure_class": "harness_or_serving",
        "detail": (result or {}).get("subtype") or f"exit {run['returncode']}",
        "usage": (result or {}).get("usage"),
        "cost_usd": (result or {}).get("total_cost_usd"),
      },
    )

    return f"{label}: ERROR {(result or {}).get('subtype')}"

  models = result.get("modelUsage") or {}

  if MODEL not in models:
    append(
      errors_path,
      {
        **base_err,
        "failure_class": "served_model_mismatch",
        "models": list(models),
      },
    )

    return f"{label}: MODEL MISMATCH {list(models)}"

  after = fixture.snapshot(repo)
  changed = [key for key in SNAPSHOT_KEYS if before[key] != after[key]]
  tree_clean = not changed
  report = result.get("result") or ""

  try:
    graded = judge.grade(case, repo, diff, report, run["trace"])
  except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as error:
    append(
      errors_path,
      {
        **base_err,
        "failure_class": "grader_error",
        "detail": str(error)[-2000:],
        "cost_usd": result.get("total_cost_usd"),
        "usage": result.get("usage"),
      },
    )

    return f"{label}: JUDGE ERROR"

  traces = vdir / "traces"
  traces.mkdir(exist_ok=True)
  (traces / f"{case_id}_rep{rep}.json").write_text(json.dumps(run["trace"], indent=1))
  grade = score_row(case, graded["verdict"], tree_clean, graded["verification"])
  usage = result.get("usage") or {}

  row = {
    "prompt_id": case_id,
    "rep": rep,
    "prompt": f"{run['prompt']}\n\n{case['summary']}",
    "tags": [case["lang"], "control" if case.get("control") else case["mode"]],
    "status": "ok",
    "stop_reason": result.get("stop_reason"),
    "grade": grade,
    "explanation": explanation(graded["verdict"], graded["verification"]),
    "model": MODEL,
    "usage": {key: usage.get(key, 0) for key in USAGE_KEYS},
    "cost_usd": round(result.get("total_cost_usd") or 0, 4),
    "judge_cost_usd": round(graded["cost_usd"] or 0, 4),
    "judge_model": graded["model"],
    "judge_usage": graded["usage"],
    "latency_s": round(run["latency_s"], 1),
    "tool_calls": run["tool_calls"],
    "num_turns": result.get("num_turns"),
    "meta": {
      "models_used": {model: round(model_usage.get("costUSD", 0), 4) for model, model_usage in models.items()},
      "judge": graded["verdict"],
      "verification": graded["verification"],
      "report": report,
      "new_ignored_paths": sorted(set(after["ignored"]) - set(before["ignored"])),
      "tree_changes": {key: {"before": before[key], "after": after[key]} for key in changed},
      "work": str(work),
      "skill_sha": skill_digest(skill_dir),
    },
  }

  if not (row["cost_usd"] > 0 and row["usage"]["output_tokens"] > 0 and report.strip()):
    append(
      errors_path,
      {
        **base_err,
        "failure_class": "harness_or_serving",
        "detail": "empty usage or report",
      },
    )

    return f"{label}: EMPTY RESULT"

  append(vdir / "results.jsonl", row)

  if not keep:
    shutil.rmtree(work, ignore_errors=True)

  return (
    f"{label}: score={grade['score']:.2f} recall={grade['recall']:.2f} "
    f"verified={grade['verified']:.2f} fc={grade['false_claims']:.0f} "
    f"clean={grade['tree_clean']:.0f} "
    f"${row['cost_usd']:.2f}+{row['judge_cost_usd']:.2f} {row['latency_s']:.0f}s"
  )


def skill_digest(skill_dir: Path) -> str:
  digest = hashlib.sha256()

  for path in sorted(skill_dir.rglob("*")):
    if path.is_file() and "__pycache__" not in path.parts:
      digest.update(str(path.relative_to(skill_dir)).encode())
      digest.update(path.read_bytes())

  return digest.hexdigest()[:12]


def done_keys(vdir: Path) -> set[tuple[str, int]]:
  path = vdir / "results.jsonl"

  if not path.exists():
    return set()

  lines = filter(str.strip, path.read_text().splitlines())

  return {(row["prompt_id"], row["rep"]) for row in map(json.loads, lines)}


def variant_order(variant: str) -> int:
  return -1 if variant == "baseline" else int(variant[1:])


def load_runs(variant: str) -> list[dict]:
  path = RUNS_DIR / variant / "results.jsonl"

  if not path.exists():
    return []

  return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def load_scores() -> list[dict]:
  if not SCORES.exists():
    return []

  with open(SCORES, newline="") as file:
    return list(csv.DictReader(file))


def export(variant: str) -> None:
  """Replaces the variant's rows in results/scores.csv with its scored runs and records its change note."""
  runs = load_runs(variant)

  if not runs:
    print(f"{variant}: no scored runs in {RUNS_DIR / variant}, results/ left as is")

    return

  state = load_state()
  splits = {case_id: split for split in ("train", "test") for case_id in state.get(f"{split}_ids", [])}
  rows = [row for row in load_scores() if row["variant"] != variant]

  for run in runs:
    rows.append(
      {
        "variant": variant,
        "case": run["prompt_id"],
        "split": splits.get(run["prompt_id"], ""),
        "rep": run["rep"],
        **{field: round(run["grade"][field], 4) for field in GRADE_FIELDS},
        **{field: run.get(field) for field in PERF_FIELDS},
        "skill_sha": run["meta"].get("skill_sha", ""),
      }
    )

  rows.sort(key=lambda row: (variant_order(row["variant"]), row["case"], int(row["rep"])))

  RESULTS_DIR.mkdir(parents=True, exist_ok=True)

  with open(SCORES, "w", newline="") as file:
    writer = csv.DictWriter(file, fieldnames=SCORE_FIELDS)
    writer.writeheader()
    writer.writerows(rows)

  change = RUNS_DIR / variant / "change.md"

  if change.exists():
    note = next((line.strip("# ").strip() for line in change.read_text().splitlines() if line.strip()), "")
    state.setdefault("changes", {})[variant] = note
    STATE.write_text(json.dumps(state, indent=2) + "\n")

  print(f"{variant}: exported {len(runs)} rows to {SCORES.relative_to(fixture.EVAL_DIR)}")


def regrade(variant: str, cases: list[str] | None, jobs: int) -> None:
  """Re-runs only the judge on stored reports and transcripts; keeps tree_clean from the original run."""
  vdir = RUNS_DIR / variant
  path = vdir / "results.jsonl"
  rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]

  def regrade_row(row: dict) -> dict:
    if cases and row["prompt_id"] not in cases:
      return row

    case = fixture.load_case(row["prompt_id"])
    trace_path = vdir / "traces" / f"{row['prompt_id']}_rep{row['rep']}.json"
    trace = json.loads(trace_path.read_text())

    with tempfile.TemporaryDirectory() as tmp:
      repo = Path(tmp) / "repo"
      fixture.build(case["id"], repo, skill_dir=None, node_modules=False)
      graded = judge.grade(case, repo, scope_diff(repo, case), row["meta"]["report"], trace)

    tree_clean = bool(row["grade"]["tree_clean"])
    row["grade"] = score_row(case, graded["verdict"], tree_clean, graded["verification"])
    row["explanation"] = explanation(graded["verdict"], graded["verification"])
    row["judge_cost_usd"] = round(graded["cost_usd"] or 0, 4)
    row["judge_usage"] = graded["usage"]
    row["meta"]["judge"] = graded["verdict"]
    row["meta"]["verification"] = graded["verification"]
    row["meta"]["regraded_harness"] = harness_digest()[:12]

    print(
      f"{row['prompt_id']} rep{row['rep']}: score={row['grade']['score']:.2f} verified={row['grade']['verified']:.2f}",
      flush=True,
    )

    return row

  with ThreadPoolExecutor(jobs) as pool:
    new_rows = list(pool.map(regrade_row, rows))

  shutil.copy(path, vdir / f"results.jsonl.bak-{int(time.time())}")
  path.write_text("".join(json.dumps(row) + "\n" for row in new_rows))
  export(variant)


def main() -> None:
  parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  subparsers = parser.add_subparsers(dest="cmd", required=True)
  subparsers.add_parser("approve-harness", help="record the current harness digest (the user's step)")

  run_parser = subparsers.add_parser("run")
  run_parser.add_argument("--variant", required=True, help="baseline or v<N>")
  run_parser.add_argument("--skill-dir", type=Path, default=fixture.DEFAULT_SKILL_DIR)
  run_parser.add_argument("--cases", nargs="*")
  run_parser.add_argument("--split", choices=["train", "test"])
  run_parser.add_argument("--reps", type=int, default=1)
  run_parser.add_argument("--timeout-s", type=int, default=2400)
  run_parser.add_argument("-j", type=int, default=4)
  run_parser.add_argument("--keep", action="store_true", help="keep fixture repos after scoring")

  regrade_parser = subparsers.add_parser("regrade", help="re-judge stored outputs of a variant in place")
  regrade_parser.add_argument("--variant", required=True)
  regrade_parser.add_argument("--cases", nargs="*")
  regrade_parser.add_argument("-j", type=int, default=4)

  export_parser = subparsers.add_parser("export", help="rewrite results/ from runs/")
  export_parser.add_argument("--variant", help="one variant (default: every variant in runs/)")

  args = parser.parse_args()

  if args.cmd == "regrade":
    check_gate()
    regrade(args.variant, args.cases, args.j)

    return

  if args.cmd == "export":
    found = [path.name for path in RUNS_DIR.iterdir() if (path / "results.jsonl").exists()] if RUNS_DIR.exists() else []

    for variant in [args.variant] if args.variant else sorted(found, key=variant_order):
      export(variant)

    return

  if args.cmd == "approve-harness":
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    state = load_state()
    state["harness_sha"] = harness_digest()
    STATE.write_text(json.dumps(state, indent=2) + "\n")
    print(f"approved harness {state['harness_sha'][:12]}")

    return

  check_gate()

  variant = args.variant

  if variant != "baseline" and not (variant.startswith("v") and variant[1:].isdigit()):
    sys.exit("variant must be 'baseline' or v<N>")

  cases = args.cases or fixture.list_cases()

  if args.split:
    split_ids = load_state().get(f"{args.split}_ids", [])
    cases = [case_id for case_id in cases if case_id in split_ids]

  vdir = RUNS_DIR / variant
  vdir.mkdir(parents=True, exist_ok=True)
  done = done_keys(vdir)
  todo = [(case_id, rep) for case_id in cases for rep in range(args.reps) if (case_id, rep) not in done]
  random.Random(0).shuffle(todo)

  print(
    f"{variant}: {len(todo)} attempts to run ({len(done)} already scored), skill {skill_digest(args.skill_dir)}",
    flush=True,
  )

  started = time.monotonic()
  skill_dir = args.skill_dir.resolve()

  with ThreadPoolExecutor(args.j) as pool:
    futures = [
      pool.submit(
        run_one,
        variant,
        vdir,
        skill_dir,
        case_id,
        rep,
        args.timeout_s,
        args.keep,
      )
      for case_id, rep in todo
    ]

    for future in futures:
      try:
        print(future.result(), flush=True)
      except Exception as error:  # noqa: BLE001 -- one crashed attempt must not abort the rest of the run
        print(f"attempt crashed: {type(error).__name__}: {error}", flush=True)

  export(variant)
  rows = [row for row in load_runs(variant) if row["prompt_id"] in cases]

  if not rows:
    return

  scores = [row["grade"]["score"] for row in rows]
  mean = sum(scores) / len(scores)
  variance = sum((score - mean) ** 2 for score in scores) / max(1, len(scores) - 1)
  half_width = 1.96 * variance**0.5 / len(scores) ** 0.5
  cost = sum(row["cost_usd"] + row["judge_cost_usd"] for row in rows)
  recall = sum(row["grade"]["recall"] for row in rows) / len(rows)
  false_claims = sum(row["grade"]["false_claims"] for row in rows)
  tree_clean = sum(row["grade"]["tree_clean"] for row in rows)
  wall = time.monotonic() - started

  print(
    f"\n{variant}: score {mean:.3f} ± {half_width:.3f} (95% CI, n={len(scores)}) "
    f"| recall {recall:.3f} | false claims {false_claims:.0f} "
    f"| tree clean {tree_clean:.0f}/{len(rows)} | ${cost:.2f} | wall {wall:.0f}s"
  )


if __name__ == "__main__":
  main()
