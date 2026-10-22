"""Copies the train-split material for one round's analyzer into a scratch directory.

The bundle holds only train cases: their results rows (grades, judge explanations, the final report), their
transcripts, and each train case's score across every round so far. Test-split rows and traces are never copied.

Usage: python3 analyzer_bundle.py <variant> <out_dir>
"""

import json
import shutil
import sys
from pathlib import Path

import run_eval
import status

ROW_FIELDS = (
  "prompt_id",
  "rep",
  "prompt",
  "tags",
  "grade",
  "explanation",
  "cost_usd",
  "latency_s",
  "tool_calls",
  "num_turns",
)


def main(variant: str, out: Path) -> None:
  state = run_eval.load_state()
  train = set(state["train_ids"])
  vdir = run_eval.RUNS_DIR / variant
  out.mkdir(parents=True, exist_ok=True)
  (out / "traces").mkdir(exist_ok=True)

  rows = [row for row in run_eval.load_runs(variant) if row["prompt_id"] in train]

  with open(out / "train_rows.jsonl", "w") as file:
    for row in rows:
      slim = {field: row[field] for field in ROW_FIELDS}

      slim["report"] = row["meta"]["report"]
      slim["tree_changes"] = row["meta"].get("tree_changes", {})

      file.write(json.dumps(slim) + "\n")

      src = vdir / "traces" / f"{row['prompt_id']}_rep{row['rep']}.json"

      shutil.copy(src, out / "traces" / src.name)

  history = {}

  for round_variant in status.variants():
    scores = status.per_case(status.load(round_variant), "score")
    history[round_variant] = {case_id: round(score, 3) for case_id, score in scores.items() if case_id in train}

  (out / "train_score_history.json").write_text(json.dumps(history, indent=2))

  print(f"{len(rows)} train rows, {len(list((out / 'traces').iterdir()))} traces -> {out}")


if __name__ == "__main__":
  main(sys.argv[1], Path(sys.argv[2]))
