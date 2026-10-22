"""Renders CASES.md: every case, its answer key, and the diff under review."""

import subprocess
import tempfile
from pathlib import Path

import fixture

KIND = {
  "tool-survivor": "tool",
  "hand-mutation": "hand",
  "revert-check": "revert",
  "static": "static",
}


def scope_diff(repo: Path, mode: str) -> str:
  if mode == "branch":
    return fixture.git(repo, "diff", "main...feature")

  subprocess.run(["git", "add", "-N", "."], cwd=repo, check=True)

  return fixture.git(repo, "diff", "HEAD")


def main() -> None:
  cases = [fixture.load_case(case_id) for case_id in fixture.list_cases()]
  defect_count = sum(len(case["defects"]) for case in cases)

  out = [
    "# Eval Cases",
    "",
    (
      f"{len(cases)} cases, {defect_count} planted defects. "
      "Each defect is verified by `verify.py` (tool = a surviving cargo-mutants/Stryker mutant, "
      "hand = a hand-applied mutation the tests miss, revert = the new test passes on the pre-change code, "
      "static = a test that cannot fail as written, also backed by a hand mutation)."
    ),
    "",
    "| case | lang | scope | invocation | defects (kind) |",
    "|---|---|---|---|---|",
  ]

  for case in cases:
    defects = ", ".join(f"{defect['id']} ({KIND[defect['kind']]})" for defect in case["defects"]) or "control: none"
    invocation = f"/mutation-test-review {case['args']}".rstrip()

    out.append(f"| {case['id']} | {case['lang']} | {case['mode']} | `{invocation}` | {defects} |")

  for case in cases:
    with tempfile.TemporaryDirectory() as tmp:
      repo = Path(tmp) / "repo"
      fixture.build(case["id"], repo, skill_dir=None, node_modules=False)
      diff = scope_diff(repo, case["mode"])

    out += ["", f"## {case['id']}", "", case["summary"], ""]

    for defect in case["defects"]:
      out.append(f"- **{defect['id']}** ({KIND[defect['kind']]}): {defect['description']}")

    if case.get("control"):
      out.append("- Control: the report should say the tests are strong and must not claim a real gap.")

    out += [
      "",
      "<details><summary>Diff under review</summary>",
      "",
      "````diff",
      diff.rstrip(),
      "````",
      "",
      "</details>",
    ]

  Path("CASES.md").write_text("\n".join(out) + "\n")


if __name__ == "__main__":
  main()
