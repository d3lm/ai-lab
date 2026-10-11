#!/usr/bin/env python3

"""Turn a unified diff into the line ranges it adds or changes on the new side.

The default output is a Stryker `--mutate` spec such as
`src/a.ts:10-14,src/b.ts:3-3`. The module also exposes `changed_lines()` for
summarize.py.
"""

import argparse
import fnmatch
import json
import re
import sys

HUNK = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@")


def changed_lines(diff_text):
  """Return a dict that maps each new-side path to the set of added line numbers."""
  result = {}
  path = None
  line_no = 0

  for raw in diff_text.splitlines():
    if raw.startswith("+++ "):
      target = raw[4:].split("\t")[0].strip()
      path = None if target == "/dev/null" else re.sub(r"^[ab]/", "", target)

      if path is not None:
        result.setdefault(path, set())

      continue

    if raw.startswith(("--- ", "diff --git")):
      continue

    match = HUNK.match(raw)

    if match:
      line_no = int(match.group(1))
      continue

    if path is None or not line_no:
      continue

    if raw.startswith("+"):
      result[path].add(line_no)
      line_no += 1
    elif raw.startswith(("-", "\\")):
      pass
    else:
      line_no += 1

  return result


def to_ranges(lines):
  ranges = []

  for n in sorted(lines):
    if ranges and n == ranges[-1][1] + 1:
      ranges[-1][1] = n
    else:
      ranges.append([n, n])

  return ranges


def main():
  parser = argparse.ArgumentParser(description=__doc__)
  parser.add_argument("diff", help="unified diff file, or - for stdin")
  parser.add_argument("--strip-prefix", default="", help="remove this prefix from paths (e.g. packages/lib/)")
  parser.add_argument("--include", action="append", default=[], help="glob on the stripped path, repeatable")
  parser.add_argument("--exclude", action="append", default=[], help="glob on the stripped path, repeatable")
  parser.add_argument("--format", choices=["stryker", "json", "plain"], default="stryker")
  args = parser.parse_args()

  if args.diff == "-":
    text = sys.stdin.read()
  else:
    with open(args.diff, encoding="utf-8", errors="replace") as file:
      text = file.read()

  selected = {}

  for path, lines in changed_lines(text).items():
    if args.strip_prefix:
      if not path.startswith(args.strip_prefix):
        continue

      path = path[len(args.strip_prefix) :]

    if args.include and not any(fnmatch.fnmatch(path, g) for g in args.include):
      continue

    if any(fnmatch.fnmatch(path, g) for g in args.exclude):
      continue

    if lines:
      selected[path] = to_ranges(lines)

  if args.format == "json":
    print(json.dumps(selected, indent=2))
  elif args.format == "plain":
    for path, ranges in selected.items():
      print(path, " ".join(f"{a}-{b}" for a, b in ranges))
  else:
    print(",".join(f"{path}:{a}-{b}" for path, ranges in selected.items() for a, b in ranges))


if __name__ == "__main__":
  main()
