"""Pushes known-good and known-bad reports through the judge (eval-audit oracle/null check)."""

import json
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import fixture
import judge
import run_eval


def oracle_report(case: dict) -> str:
  if case.get("control"):
    return (
      "# Mutation test review\n\nThese tests are strong: every mutant in the changed code was killed, "
      "they pin exact values, every error variant, and the boundaries. Nothing needs adding."
    )

  lines = [
    "# Mutation test review",
    "",
    "The tests would miss realistic bugs. Gaps, most important first:",
    "",
  ]

  for defect in case["defects"]:
    lines.append(f"- {defect['description']}")

  return "\n".join(lines)


WRONG = (
  "# Mutation test review\n\nThe tests would miss realistic bugs. The biggest gap is in `src/http/client.rs`: "
  "`Client::send` never checks the TLS certificate chain, and the mutant replacing `verify_peer` with `true` "
  "survives. Add `assert_eq!(client.send(req).unwrap_err(), TlsError::BadCert)`."
)

NULLS = {"empty": "", "dont_know": "I don't know.", "wrong_code": WRONG}


def run(case_id: str, label: str, report: str, trace: list | None = None) -> tuple:
  trace = trace or []
  case = fixture.load_case(case_id)

  with tempfile.TemporaryDirectory() as tmp:
    repo = Path(tmp) / "repo"
    fixture.build(case_id, repo, skill_dir=None, node_modules=False)
    diff = run_eval.scope_diff(repo, case)
    graded = judge.grade(case, repo, diff, report, trace)

  grade = run_eval.score_row(case, graded["verdict"], True, graded["verification"])

  return (
    case_id,
    label,
    grade["score"],
    grade["verified"],
    grade["false_claims"],
    graded["verdict"]["verdict_ok"],
    graded["cost_usd"],
  )


if __name__ == "__main__":
  cases = sys.argv[1:] or ["rust-token-bucket", "ts-retry", "rust-control-semver"]

  jobs = [(case_id, "oracle", oracle_report(fixture.load_case(case_id))) for case_id in cases]
  jobs += [(case_id, label, report) for case_id in cases for label, report in NULLS.items()]

  vdir = run_eval.RUNS_DIR / "baseline"
  withheld = [{"role": "user", "content": "(transcript withheld)"}]

  if (vdir / "results.jsonl").exists():
    for line in (vdir / "results.jsonl").read_text().splitlines():
      row = json.loads(line)
      trace_path = vdir / "traces" / f"{row['prompt_id']}_rep{row['rep']}.json"
      trace = json.loads(trace_path.read_text())
      report = row["meta"]["report"]

      jobs.append((row["prompt_id"], "real+trace", report, trace))
      jobs.append((row["prompt_id"], "real-no-trace", report, withheld))

  with ThreadPoolExecutor(6) as pool:
    for case_id, label, score, verified, false_claims, verdict_ok, cost in pool.map(lambda job: run(*job), jobs):
      print(
        f"{case_id:<22} {label:<14} score={score:.2f} verified={verified:.2f} "
        f"major_false={false_claims:.0f} verdict_ok={verdict_ok} ${cost:.3f}"
      )
