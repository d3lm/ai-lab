#!/usr/bin/env python3

"""Run each named test alone against each mutant and print a test x mutant kill matrix.

Use it to verify suggested tests. It first runs every test alone on the real code, then
applies each mutant in turn (hand faults, cargo-mutants outcomes, or Stryker results),
runs every test alone again, and restores the file. The output gives one line per test
listing exactly the mutants that test kills, which is the claim the report may make.

Runners: cargo (`cargo test -- --exact <name>`) and vitest (`vitest run <file> -t <name>`).
Run it only in a scratch worktree. Every mutated file is restored, even on Ctrl-C.
"""

import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time

CODES = {"pass": ".", "killed": "K", "timeout": "T", "error": "E"}
BASELINE = {"pass": "PASS", "killed": "FAILS", "timeout": "HANGS", "error": "ERROR"}


def run(cmd, cwd, timeout, env=None):
  """Run a command in its own process group and return (returncode or None on timeout, output, seconds)."""
  start = time.time()
  proc = subprocess.Popen(
    cmd,
    cwd=cwd,
    env=env,
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
    start_new_session=True,
  )

  try:
    out, _ = proc.communicate(timeout=timeout)
    return proc.returncode, out, time.time() - start
  except subprocess.TimeoutExpired:
    os.killpg(proc.pid, signal.SIGKILL)
    out, _ = proc.communicate()
    return None, out or "", time.time() - start
  except BaseException:
    os.killpg(proc.pid, signal.SIGKILL)
    raise


class Cargo:
  def __init__(self, tree, extra_args):
    self.tree = tree
    self.args = extra_args
    self.env = dict(os.environ, CARGO_TERM_COLOR="never")

  def build(self):
    code, out, _ = run(
      ["cargo", "test", *self.args, "--no-run"], self.tree, 1800, self.env
    )
    return code == 0, out

  def resolve(self, names):
    code, out, _ = run(
      ["cargo", "test", *self.args, "--", "--list"], self.tree, 1800, self.env
    )

    if code != 0:
      sys.exit(f"cargo test --list failed:\n{out[-3000:]}")

    listed = [
      line[: -len(": test")] for line in out.splitlines() if line.endswith(": test")
    ]
    resolved = []

    for name in names:
      matches = sorted(
        {full for full in listed if full == name or full.endswith("::" + name)}
      )

      if len(matches) != 1 or listed.count(matches[0]) != 1:
        found = ", ".join(matches) or "none"
        sys.exit(
          f"test {name!r} must match exactly one test (found {found}); narrow it or pass --cargo-args"
        )

      resolved.append(
        {"spec": name, "name": matches[0], "short": matches[0].rsplit("::", 1)[-1]}
      )

    return resolved

  def run_test(self, test, timeout):
    code, out, seconds = run(
      ["cargo", "test", *self.args, "--", "--exact", test["name"]],
      self.tree,
      timeout,
      self.env,
    )

    if code is None:
      return "timeout", seconds

    ran = sum(int(n) for n in re.findall(r"^running (\d+) tests?$", out, re.MULTILINE))

    if "error[" in out or "could not compile" in out:
      return "error", seconds

    if ran != 1:
      sys.exit(
        f"expected exactly one test to run for {test['name']}, saw {ran}:\n{out[-2000:]}"
      )

    return ("pass" if code == 0 else "killed"), seconds


class Vitest:
  def __init__(self, tree, extra_args):
    self.tree = tree
    self.args = extra_args
    local = os.path.join(tree, "node_modules", ".bin", "vitest")
    self.bin = [local] if os.path.exists(local) else ["npx", "vitest"]
    self.report = os.path.join(tempfile.mkdtemp(prefix="kill-matrix-"), "vitest.json")

  def build(self):
    return True, ""

  def resolve(self, names):
    resolved = []

    for spec in names:
      if "::" not in spec:
        sys.exit(f"vitest tests are given as <test file>::<test title>, got {spec!r}")

      path, title = spec.split("::", 1)
      resolved.append({"spec": spec, "file": path, "name": title, "short": title})

    return resolved

  def run_test(self, test, timeout):
    if os.path.exists(self.report):
      os.remove(self.report)

    pattern = (
      re.sub(r"[.*+?^${}()|[\]\\/]", lambda match: "\\" + match.group(0), test["name"])
      + "$"
    )
    cmd = [
      *self.bin,
      "run",
      test["file"],
      "-t",
      pattern,
      "--reporter=json",
      f"--outputFile={self.report}",
      *self.args,
    ]
    code, _, seconds = run(cmd, self.tree, timeout)

    if code is None:
      return "timeout", seconds

    try:
      with open(self.report, encoding="utf-8") as handle:
        data = json.load(handle)
    except (OSError, ValueError):
      return "error", seconds

    file_results = data.get("testResults", [])
    results = [
      result
      for file_result in file_results
      for result in file_result.get("assertionResults", [])
    ]
    ran = [result for result in results if result.get("status") in ("passed", "failed")]

    if not ran and any(
      file_result.get("status") == "failed" for file_result in file_results
    ):
      return "error", seconds

    if len(ran) != 1:
      names = ", ".join(result.get("fullName", "?") for result in ran) or "none"
      sys.exit(
        f"expected exactly one test to run for {test['spec']}, saw {len(ran)}: {names}"
      )

    return ("pass" if ran[0]["status"] == "passed" else "killed"), seconds


def load_mutants(args):
  mutants = []

  if args.hand:
    with open(args.hand, encoding="utf-8") as handle:
      for item in json.load(handle):
        mutant = {
          "id": item["id"],
          "file": item["file"],
          "desc": item.get("desc") or item["id"],
        }

        if "patch" in item:
          mutant["patch"] = item["patch"]
        else:
          mutant["find"], mutant["replace"] = item["find"], item["replace"]

        mutants.append(mutant)

  if args.cargo_outcomes:
    with open(args.cargo_outcomes, encoding="utf-8") as handle:
      data = json.load(handle)

    report_dir = os.path.dirname(os.path.abspath(args.cargo_outcomes))
    keep = {"MissedMutant", "Timeout"} | (
      {"CaughtMutant"} if args.all_statuses else set()
    )
    count = 0

    for outcome in data.get("outcomes", []):
      scenario = outcome.get("scenario")

      if (
        not isinstance(scenario, dict)
        or "Mutant" not in scenario
        or outcome.get("summary") not in keep
      ):
        continue

      count += 1
      details = scenario["Mutant"]
      mutants.append(
        {
          "id": f"C{count}",
          "file": details["file"],
          "desc": details.get("name", ""),
          "patch": os.path.join(report_dir, outcome["diff_path"]),
        }
      )

  if args.stryker:
    with open(args.stryker, encoding="utf-8") as handle:
      data = json.load(handle)

    keep = {"Survived", "NoCoverage", "Timeout"} | (
      {"Killed"} if args.all_statuses else set()
    )

    for path, info in data.get("files", {}).items():
      rel = (
        os.path.relpath(os.path.join(args.stryker_root, path), args.tree)
        if args.stryker_root
        else path
      )

      for stryker_mutant in info.get("mutants", []):
        if stryker_mutant.get("status") not in keep:
          continue

        loc = stryker_mutant["location"]
        replacement = stryker_mutant.get("replacement")
        mutants.append(
          {
            "id": f"S{stryker_mutant['id']}",
            "file": rel,
            "desc": f"{path}:{loc['start']['line']}:{loc['start']['column']} "
            f"{stryker_mutant.get('mutatorName')} -> {(replacement or '').strip()!r}",
            "span": loc,
            "replacement": replacement or "",
            "source": info.get("source"),
          }
        )

  if args.only:
    wanted = set(args.only.split(","))
    mutants = [mutant for mutant in mutants if mutant["id"] in wanted]

  if len({mutant["id"] for mutant in mutants}) != len(mutants):
    sys.exit("mutant ids must be unique")

  return mutants


def offset(text, line, column):
  lines = text.split("\n")
  return sum(len(chunk) + 1 for chunk in lines[: line - 1]) + column - 1


def mutated_text(mutant, original, tree):
  if "find" in mutant:
    if original.count(mutant["find"]) != 1:
      raise ValueError(
        f"{mutant['id']}: 'find' text must occur exactly once in {mutant['file']}"
      )

    return original.replace(mutant["find"], mutant["replace"])

  if "span" in mutant:
    if mutant["source"] is not None and mutant["source"] != original:
      raise ValueError(
        f"{mutant['id']}: {mutant['file']} changed since the Stryker run, so positions are stale"
      )

    start = offset(
      original, mutant["span"]["start"]["line"], mutant["span"]["start"]["column"]
    )
    end = offset(
      original, mutant["span"]["end"]["line"], mutant["span"]["end"]["column"]
    )
    return original[:start] + mutant["replacement"] + original[end:]

  out = os.path.join(tempfile.mkdtemp(prefix="kill-matrix-"), "mutated")
  code, log, _ = run(
    ["patch", "-s", "-o", out, os.path.join(tree, mutant["file"]), mutant["patch"]],
    tree,
    60,
  )

  if code != 0:
    raise ValueError(f"{mutant['id']}: patch did not apply: {log.strip()}")

  with open(out, encoding="utf-8") as handle:
    text = handle.read()

  shutil.rmtree(os.path.dirname(out), ignore_errors=True)
  return text


def guard_tree(tree, allow):
  git_dir = run(["git", "rev-parse", "--absolute-git-dir"], tree, 30)
  common = run(
    ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], tree, 30
  )

  if (
    git_dir[0] == 0
    and common[0] == 0
    and git_dir[1].strip() == common[1].strip()
    and not allow
  ):
    sys.exit(
      f"{tree} is a main git checkout, not a linked scratch worktree. Run this in a scratch worktree "
      "(git worktree add --detach ...), or pass --allow-main-worktree if this directory is a throwaway copy."
    )


def main():
  parser = argparse.ArgumentParser(
    description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
  )
  parser.add_argument(
    "--tree",
    required=True,
    help="scratch tree (crate/workspace root or JS package dir)",
  )
  parser.add_argument(
    "--runner",
    choices=["cargo", "vitest"],
    help="default: cargo if Cargo.toml exists, else vitest",
  )
  parser.add_argument(
    "--test",
    action="append",
    required=True,
    help="cargo: test name or path; vitest: file::title",
  )
  parser.add_argument(
    "--hand",
    help='JSON list of {"id","file","find","replace"[,"desc"]} or {"id","file","patch"}',
  )
  parser.add_argument(
    "--cargo-outcomes",
    help="mutants.out/outcomes.json; adds missed and timed-out mutants",
  )
  parser.add_argument(
    "--stryker", help="mutation.json; adds survived, no-coverage and timed-out mutants"
  )
  parser.add_argument("--stryker-root", help="directory Stryker ran in, if not --tree")
  parser.add_argument(
    "--all-statuses",
    action="store_true",
    help="also include mutants the tool already killed",
  )
  parser.add_argument("--only", help="comma-separated mutant ids to keep")
  parser.add_argument(
    "--cargo-args", default="", help='extra cargo test args, e.g. "-p mycrate --lib"'
  )
  parser.add_argument("--vitest-args", default="", help="extra vitest args")
  parser.add_argument(
    "--env",
    action="append",
    default=[],
    help="KEY=VALUE set for every test run, repeatable",
  )
  parser.add_argument(
    "--timeout",
    type=float,
    help="seconds per test run (default: 4x slowest real-code run, min 15)",
  )
  parser.add_argument("--json", help="also write the full matrix here")
  parser.add_argument("--allow-main-worktree", action="store_true")
  args = parser.parse_args()

  # turn SIGTERM and SIGINT into exceptions so the finally blocks restore every mutated file
  signal.signal(signal.SIGTERM, lambda *_: sys.exit("interrupted, files restored"))
  signal.signal(signal.SIGINT, signal.default_int_handler)
  args.tree = os.path.abspath(args.tree)
  os.environ.update(dict(item.split("=", 1) for item in args.env))
  guard_tree(args.tree, args.allow_main_worktree)
  runner_name = args.runner or (
    "cargo" if os.path.exists(os.path.join(args.tree, "Cargo.toml")) else "vitest"
  )
  runner_class, runner_args = (
    (Cargo, args.cargo_args) if runner_name == "cargo" else (Vitest, args.vitest_args)
  )
  runner = runner_class(args.tree, runner_args.split())
  mutants = load_mutants(args)

  ok, log = runner.build()

  if not ok:
    sys.exit(f"the real code does not build:\n{log[-3000:]}")

  tests = runner.resolve(args.test)

  for index, test in enumerate(tests):
    test["label"] = f"t{index + 1}"

  originals = {}

  for mutant in mutants:
    path = os.path.join(args.tree, mutant["file"])

    if not os.path.isfile(path):
      sys.exit(f"{mutant['id']}: {mutant['file']} is not a file under {args.tree}")

    with open(path, encoding="utf-8") as handle:
      originals.setdefault(path, handle.read())

    try:
      mutant["text"] = mutated_text(mutant, originals[path], args.tree)
    except ValueError as error:
      sys.exit(str(error))

    if mutant["text"] == originals[path]:
      sys.exit(f"{mutant['id']}: applying it changes nothing")

  baseline = {}
  slowest = 0.0

  for test in tests:
    baseline[test["label"]], seconds = runner.run_test(test, args.timeout or 600)
    slowest = max(slowest, seconds)

  timeout = args.timeout or max(15.0, 4 * slowest)
  matrix = {test["label"]: {} for test in tests}

  try:
    for mutant in mutants:
      path = os.path.join(args.tree, mutant["file"])

      with open(path, "w", encoding="utf-8") as handle:
        handle.write(mutant["text"])

      try:
        built, _ = runner.build()

        for test in tests:
          if baseline[test["label"]] != "pass":
            matrix[test["label"]][mutant["id"]] = "-"
          elif not built:
            matrix[test["label"]][mutant["id"]] = "error"
          else:
            matrix[test["label"]][mutant["id"]] = runner.run_test(test, timeout)[0]
      finally:
        with open(path, "w", encoding="utf-8") as handle:
          handle.write(originals[path])

  finally:
    for path, text in originals.items():
      with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)

  for path, text in originals.items():
    with open(path, encoding="utf-8") as handle:
      if handle.read() != text:
        sys.exit(f"failed to restore {path}")

  ids = [mutant["id"] for mutant in mutants]
  width = max([len(mutant_id) for mutant_id in ids] + [1])
  out = [
    f"{runner_name}, each test run alone, {len(tests)} tests x {len(mutants)} mutants, timeout {timeout:.0f}s",
    "",
  ]
  out.append("Real code, no mutant:")

  for test in tests:
    status = BASELINE[baseline[test["label"]]]
    note = (
      ""
      if status == "PASS"
      else "  <- does not pass on the real code, so it is not a verified suggested test"
    )
    out.append(f"  {test['label']} {status:5} {test['name']}{note}")

  out += ["", "Per test, the only kill claims the report may make for it:"]

  for test in tests:
    cells = matrix[test["label"]]

    if baseline[test["label"]] != "pass":
      out.append(
        f"  {test['label']} {test['short']}: FAILS ON THE REAL CODE, no kill claims"
      )
      continue

    killed = [mutant_id for mutant_id in ids if cells[mutant_id] == "killed"]
    hung = [mutant_id for mutant_id in ids if cells[mutant_id] == "timeout"]
    line = f"  {test['label']} {test['short']}: kills {' '.join(killed) or 'nothing'}"
    line += f"; times out on {' '.join(hung)}" if hung else ""
    out.append(line + f" ({len(killed) + len(hung)} of {len(ids)})")

  broken = [
    mutant_id
    for mutant_id in ids
    if any(matrix[test["label"]][mutant_id] == "error" for test in tests)
  ]
  detected = {
    mutant_id
    for test in tests
    for mutant_id, cell in matrix[test["label"]].items()
    if cell in ("killed", "timeout")
  }
  missed = [
    mutant_id
    for mutant_id in ids
    if mutant_id not in broken and mutant_id not in detected
  ]
  out += ["", f"Not detected by any listed test: {' '.join(missed) or 'none'}"]
  out += (
    [f"Did not build or load, so not a kill (fix or drop them): {' '.join(broken)}"]
    if broken
    else []
  )
  out += [
    "",
    "Matrix: K test failed, T test timed out, . test passed, E mutant does not build or load, - not run",
    "",
  ]
  out.append("     " + " ".join(f"{mutant_id:>{width}}" for mutant_id in ids))

  for test in tests:
    cells = matrix[test["label"]]
    row = " ".join(
      f"{CODES.get(cells[mutant_id], cells[mutant_id]):>{width}}" for mutant_id in ids
    )
    out.append(f"  {test['label']:3}" + row)

  out += ["", "Mutants:"]

  for mutant in mutants:
    desc = (
      mutant["desc"] if "find" not in mutant else mutant["file"] + ": " + mutant["desc"]
    )
    out.append(f"  {mutant['id']:{width}} {desc}"[:90])

  print("\n".join(out))

  if args.json:
    with open(args.json, "w", encoding="utf-8") as handle:
      json.dump(
        {
          "tests": tests,
          "baseline": baseline,
          "mutants": [
            {
              key: value
              for key, value in mutant.items()
              if key not in ("text", "source")
            }
            for mutant in mutants
          ],
          "matrix": matrix,
        },
        handle,
        indent=2,
      )


if __name__ == "__main__":
  main()
