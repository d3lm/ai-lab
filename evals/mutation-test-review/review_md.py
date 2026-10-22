"""Writes <variant>/grades.md: each case's final report beside the judge's per-defect verdict."""

import json
import sys

import run_eval


def main(variant: str) -> None:
  vdir = run_eval.RUNS_DIR / variant
  results = (vdir / "results.jsonl").read_text().splitlines()
  rows = sorted(
    (json.loads(line) for line in results if line.strip()),
    key=lambda row: (row["prompt_id"], row["rep"]),
  )

  out = [f"# Grades for {variant}", ""]

  for row in rows:
    grade = row["grade"]
    explanation = row["explanation"]

    summary = (
      f"score {grade['score']:.2f} | recall {grade['recall']:.2f} "
      f"| found+fix {grade['actionable']:.2f} | verdict ok {grade['verdict_ok']:.0f} "
      f"| top fix ok {grade['top_fix_ok']:.0f} "
      f"| major false claims {grade['false_claims']:.0f} "
      f"| tree clean {grade['tree_clean']:.0f} "
      f"| ${row['cost_usd']:.2f} + judge ${row['judge_cost_usd']:.2f} "
      f"| {row['latency_s']:.0f}s"
    )

    out += [
      f"## {row['prompt_id']} (rep {row['rep']})",
      "",
      summary,
      "",
      "**Judge, per defect**",
      "",
    ]
    out += [f"- {line}" for line in explanation["score"].splitlines()]
    out += [
      "",
      f"**False claims:** {explanation['false_claims']}",
      "",
      f"**Verdict:** {explanation['verdict_ok']}",
      "",
    ]
    out += [
      "<details><summary>Report the skill produced</summary>",
      "",
      "`````markdown",
      row["meta"]["report"].rstrip(),
      "`````",
      "",
      "</details>",
      "",
    ]

  (vdir / "grades.md").write_text("\n".join(out) + "\n")
  print(vdir / "grades.md")


if __name__ == "__main__":
  main(sys.argv[1] if len(sys.argv) > 1 else "baseline")
