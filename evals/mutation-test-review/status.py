"""Prints the hillclimb status table from results/scores.csv: per variant, train/test means and the paired delta vs baseline.

Usage: python3 status.py [--md]   (--md also rewrites the table at the top of runs/narrative.md)
"""

from __future__ import annotations

import statistics as st
import sys
from collections import defaultdict

import run_eval

METRICS = ["score", "recall", "verified", "false_claims", "tree_clean"]


def load(variant: str) -> list[dict]:
  return [row for row in run_eval.load_scores() if row["variant"] == variant]


def per_case(rows: list[dict], metric: str) -> dict[str, float]:
  values_by_case = defaultdict(list)

  for row in rows:
    values_by_case[row["case"]].append(float(row[metric]))

  return {case_id: st.mean(values) for case_id, values in values_by_case.items()}


def paired(base: dict[str, float], candidate: dict[str, float], ids: list[str]) -> tuple[float, float, int]:
  diffs = [candidate[case_id] - base[case_id] for case_id in ids if case_id in base and case_id in candidate]

  if len(diffs) < 2:
    return float("nan"), float("nan"), len(diffs)

  return st.mean(diffs), 1.96 * st.stdev(diffs) / len(diffs) ** 0.5, len(diffs)


def variants() -> list[str]:
  return sorted({row["variant"] for row in run_eval.load_scores()}, key=run_eval.variant_order)


def change_line(variant: str) -> str:
  if variant == "baseline":
    return "baseline"

  return run_eval.load_state().get("changes", {}).get(variant, "")[:60]


def table() -> str:
  state = run_eval.load_state()
  train, test = state["train_ids"], state["test_ids"]
  base_score = per_case(load("baseline"), "score")

  lines = [
    (
      "| round | change | test score | test Δ vs base (95% CI) | train score | recall "
      "| verified | false claims | tree clean | rows | $ round | $ total |"
    ),
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ]

  total = 0.0

  for variant in variants():
    rows = load(variant)

    if not rows:
      continue

    cost = sum(float(row["cost_usd"]) + float(row["judge_cost_usd"]) for row in rows)
    total += cost

    scores = per_case(rows, "score")
    test_scores = [scores[case_id] for case_id in test if case_id in scores]
    train_scores = [scores[case_id] for case_id in train if case_id in scores]
    test_mean = st.mean(test_scores) if test_scores else float("nan")
    train_mean = st.mean(train_scores) if train_scores else float("nan")

    delta_mean, half_width, pairs = paired(base_score, scores, test)
    delta = "-" if variant == "baseline" else f"{delta_mean:+.3f} ± {half_width:.3f} (n={pairs})"

    means = {metric: st.mean(float(row[metric]) for row in rows) for metric in METRICS}
    false_claims = sum(float(row["false_claims"]) for row in rows)
    clean = sum(float(row["tree_clean"]) for row in rows)

    lines.append(
      f"| {variant} | {change_line(variant)} | {test_mean:.3f} | {delta} "
      f"| {train_mean:.3f} | {means['recall']:.3f} | {means['verified']:.3f} "
      f"| {false_claims:.0f} | {clean:.0f}/{len(rows)} | {len(rows)} "
      f"| {cost:.2f} | {total:.2f} |"
    )

  return "\n".join(lines)


if __name__ == "__main__":
  status_table = table()

  print(status_table)

  if "--md" in sys.argv:
    path = run_eval.RUNS_DIR / "narrative.md"
    body = path.read_text().split("<!-- /status -->", 1)[-1] if path.exists() else "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"<!-- status -->\n{status_table}\n<!-- /status -->{body}")
