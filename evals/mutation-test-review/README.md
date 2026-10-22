# `mutation-test-review` eval

This eval measures whether the `mutation-test-review` skill finds low-quality tests in Rust and TS changes.

## How it works

- **Cases:** 28 small, synthetic fixture repos (14 Rust, 14 TS) are defined in `cases/`. They were written for this eval, not taken from real projects. Each one has a change under review whose tests have planted weaknesses: 67 in total. Two cases are controls, with genuinely strong tests.
- **Ground truth:** `verify.py` proves every planted weakness with a real run. This includes a surviving cargo-mutants or Stryker mutant, a hand-applied fault the tests miss, or a new test that passes on the pre-change code.
- **Runner:** `run_eval.py` builds each fixture as a fresh git repo outside this checkout and runs `claude -p "/mutation-test-review"` with Opus 5.5. It records the transcript and cost, and checks that the fixture repo was left untouched.
- **Judge:** Opus 5.5 grades each run with two calls:
  - One checks the report against the answer key, for example whether each gap was found and a fix was given.
  - One checks the transcript to confirm that each suggested test actually ran and killed what the report claims.
- **Score:** `recall × verified`. Side metrics are false claims, tree clean, cost, and latency.
- **Split:** 16 cases are used for train and 12 are held out for test.

## Results (28 cases × 2 reps)

| version  | test  | train | verified | tree clean | $ per run |
| -------- | ----- | ----- | -------- | ---------- | --------- |
| baseline | 0.995 | 0.939 | 0.981    | 55/56      | ~0.60     |
| v1       | 0.970 | 0.963 | 0.984    | 56/56      | ~0.60     |
| v2       | 1.000 | 1.000 | 1.000    | 56/56      | ~0.70     |

v2 takes about twice as long per review, because every suggested test runs against every mutant.

## Caveats

- All cases are synthetic. They are small, single-crate or single-package repos with planted weaknesses, so the scores above do not show how the skill does on real code.
- The eval is now saturated. Use it as a regression check for skill edits.
- The next step is to eval real repos: take merged PRs from real Rust and TS projects, establish ground truth with cargo-mutants or Stryker, and run the skill on those changes. Real PRs bring larger diffs, slower test suites, and messier build setups.
- The transcript judge has some noise: re-grading the same run moved single scores by up to about ±0.2.

## Running it

```bash
# re-check ground truth
python3 verify.py

# after any harness change
python3 run_eval.py approve-harness

python3 run_eval.py run --variant v3 --reps 2 -j 4

# status table
python3 status.py

# report in the browser: open http://localhost:8000/results/
python3 -m http.server
```

Each run writes its full output to `runs/<variant>/`, which is gitignored. This includes reports, judge reasoning, transcripts, and errors. When a run or regrade finishes, the minimum needed to compare rounds is exported to `results/`, which is committed:

- `results/state.json` holds the train/test split, the approved harness digest, and a one-line change note per variant.
- `results/scores.csv` has one row per variant, case, and rep, with every grade plus cost and latency.

`status.py` reads only `results/`, so it works on a fresh clone. `regrade`, `review_md.py`, `analyzer_bundle.py`, and `judge_check.py` need the full output in `runs/`. Run `python3 run_eval.py export` to rebuild `results/` from `runs/`.
