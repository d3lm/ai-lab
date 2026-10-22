#!/usr/bin/env python3

"""Normalise cargo-mutants or StrykerJS results into five outcome classes.

The classes are killed, survived, no_coverage, timeout, and error. The input is
cargo-mutants `mutants.out/outcomes.json` or Stryker `reports/mutation/mutation.json`,
and the format is detected automatically.
"""

import argparse
import json
import os
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from diff_ranges import changed_lines

CLASSES = ["killed", "survived", "no_coverage", "timeout", "error"]

CARGO_STATUS = {
  "CaughtMutant": "killed",
  "MissedMutant": "survived",
  "Timeout": "timeout",
  "Unviable": "error",
}

STRYKER_STATUS = {
  "Killed": "killed",
  "Survived": "survived",
  "NoCoverage": "no_coverage",
  "Timeout": "timeout",
  "CompileError": "error",
  "RuntimeError": "error",
  "Ignored": "ignored",
  "Pending": "ignored",
}


def load_cargo(data, report_dir, root):
  mutants = []

  for outcome in data.get("outcomes", []):
    scenario = outcome.get("scenario")

    if not isinstance(scenario, dict) or "Mutant" not in scenario:
      continue

    mutant = scenario["Mutant"]
    span = mutant.get("span") or {}
    start = span.get("start") or {}
    name = mutant.get("name", "")
    description = name.split(": ", 1)[1] if ": " in name else name
    function = mutant.get("function")

    if isinstance(function, dict):
      function = function.get("function_name")

    diff_path = outcome.get("diff_path")
    log_path = outcome.get("log_path")

    mutants.append(
      {
        "status": CARGO_STATUS.get(outcome.get("summary"), "error"),
        "tool_status": outcome.get("summary"),
        "file": os.path.join(root, mutant.get("file", "")) if root else mutant.get("file", ""),
        "line": start.get("line"),
        "end_line": (span.get("end") or {}).get("line") or start.get("line"),
        "column": start.get("column"),
        "function": function,
        "description": description,
        "name": name,
        "diff": os.path.join(report_dir, diff_path) if diff_path else None,
        "log": os.path.join(report_dir, log_path) if log_path else None,
      }
    )

  return mutants


def load_stryker(data, root):
  mutants = []

  for path, info in data.get("files", {}).items():
    source_lines = (info.get("source") or "").splitlines()

    for mutant in info.get("mutants", []):
      status = STRYKER_STATUS.get(mutant.get("status"), "error")

      if status == "ignored":
        continue

      loc = mutant.get("location") or {}
      start = loc.get("start") or {}
      end = loc.get("end") or {}
      line = start.get("line")
      original = ""

      if line and line == end.get("line") and line <= len(source_lines):
        original = source_lines[line - 1][start.get("column", 1) - 1 : end.get("column", 1) - 1]

      replacement = mutant.get("replacement")
      description = mutant.get("mutatorName", "mutation")

      if original and replacement is not None:
        description += f": replace `{original.strip()}` with `{replacement.strip()}`"
      elif replacement is not None:
        description += f": replace with `{replacement.strip()}`"

      mutants.append(
        {
          "status": status,
          "tool_status": mutant.get("status"),
          "file": os.path.join(root, path) if root else path,
          "line": line,
          "end_line": end.get("line") or line,
          "column": start.get("column"),
          "function": None,
          "description": description,
          "name": mutant.get("id"),
          "covered_by": len(mutant.get("coveredBy") or []),
          "killed_by": mutant.get("killedBy") or [],
        }
      )

  return mutants


def load_lcov(path):
  uncovered = {}
  current = None

  with open(path, encoding="utf-8", errors="replace") as handle:
    for raw in handle:
      raw = raw.strip()

      if raw.startswith("SF:"):
        current = raw[3:]
        uncovered.setdefault(current, {})
      elif raw.startswith("DA:") and current is not None:
        line, count = raw[3:].split(",")[:2]
        uncovered[current][int(line)] = int(float(count)) == 0

  return uncovered


def paths_match(left, right):
  left = os.path.normpath(left)
  right = os.path.normpath(right)
  return left == right or left.endswith(os.sep + right) or right.endswith(os.sep + left)


def lookup(table, path):
  for key, value in table.items():
    if paths_match(key, path):
      return value

  return None


def touches(mutant, lines):
  if mutant["line"] is None:
    return False

  return any(line in lines for line in range(mutant["line"], (mutant["end_line"] or mutant["line"]) + 1))


def score(counts):
  detected = counts["killed"] + counts["timeout"]
  valid = detected + counts["survived"] + counts["no_coverage"]
  covered = detected + counts["survived"]

  return {
    "score": round(100 * detected / valid, 1) if valid else None,
    "covered_score": round(100 * detected / covered, 1) if covered else None,
  }


def render_markdown(mutants, counts, scores, source):
  out = [f"Source is {source}.", ""]
  out.append("| Killed | Survived | No coverage | Timed out | Error | Score | Covered score |")
  out.append("|---|---|---|---|---|---|---|")

  def pct(value):
    return "n/a" if value is None else f"{value}%"

  out.append(
    f"| {counts['killed']} | {counts['survived']} | {counts['no_coverage']} | {counts['timeout']} "
    f"| {counts['error']} | {pct(scores['score'])} | {pct(scores['covered_score'])} |"
  )

  for status, title in [
    ("survived", "Survived"),
    ("no_coverage", "No coverage"),
    ("timeout", "Timed out"),
  ]:
    group = [mutant for mutant in mutants if mutant["status"] == status]

    if not group:
      continue

    out += ["", f"## {title} ({len(group)})", ""]

    for mutant in sorted(
      group,
      key=lambda mutant: (mutant["file"], mutant["line"] or 0, mutant["column"] or 0),
    ):
      where = f"{mutant['file']}:{mutant['line']}:{mutant['column']}"
      extra = f" (diff at {mutant['diff']})" if mutant.get("diff") else ""
      out.append(f"- `{where}` {mutant['description']}{extra}")

  errors = [mutant for mutant in mutants if mutant["status"] == "error"]

  if errors:
    by_file = Counter(mutant["file"] for mutant in errors)
    out += ["", f"## Errors ({len(errors)}, excluded from the score)", ""]
    out += [f"- {path} has {count}" for path, count in by_file.most_common()]

  return "\n".join(out)


def main():
  parser = argparse.ArgumentParser(description=__doc__)
  parser.add_argument("report", help="outcomes.json (cargo-mutants) or mutation.json (Stryker)")
  parser.add_argument("--diff", help="keep only mutants on lines this unified diff adds or changes")
  parser.add_argument("--lcov", help="reclassify survivors on unexecuted lines as no_coverage")
  parser.add_argument(
    "--root",
    default="",
    help="prefix for report paths so they match repo-relative diff paths",
  )
  parser.add_argument("--format", choices=["md", "json"], default="md")
  args = parser.parse_args()

  with open(args.report, encoding="utf-8") as handle:
    data = json.load(handle)

  if "outcomes" in data:
    source = "cargo-mutants"
    mutants = load_cargo(data, os.path.dirname(os.path.abspath(args.report)), args.root)
  elif "files" in data:
    source = "StrykerJS"
    mutants = load_stryker(data, args.root)
  else:
    sys.exit("unrecognised report format (expected cargo-mutants outcomes.json or Stryker mutation.json)")

  if args.lcov:
    uncovered = load_lcov(args.lcov)

    for mutant in mutants:
      lines = lookup(uncovered, mutant["file"])

      if mutant["status"] == "survived" and lines and lines.get(mutant["line"]) is True:
        mutant["status"] = "no_coverage"

  if args.diff:
    with open(args.diff, encoding="utf-8", errors="replace") as handle:
      changed = changed_lines(handle.read())

    # whole-body mutants start at the function head, so keep any mutant whose span touches a changed line
    mutants = [mutant for mutant in mutants if touches(mutant, lookup(changed, mutant["file"]) or set())]

  counts = Counter({outcome_class: 0 for outcome_class in CLASSES})
  counts.update(mutant["status"] for mutant in mutants)
  scores = score(counts)

  if args.format == "json":
    print(
      json.dumps(
        {"source": source, "counts": dict(counts), **scores, "mutants": mutants},
        indent=2,
      )
    )
  else:
    print(render_markdown(mutants, counts, scores, source))


if __name__ == "__main__":
  main()
