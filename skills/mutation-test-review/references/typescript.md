# TypeScript and JavaScript with StrykerJS

StrykerJS (https://stryker-mutator.io) mutates TS/JS source in a sandbox copy and runs the project's test runner against each mutant. Unlike cargo-mutants it reports `NoCoverage` natively, because it measures per-test coverage first.

## Detecting the setup

Run everything from the package that owns the tests. In a pnpm or npm workspace that is usually the package directory, not the repo root.

- Identify the test runner from `devDependencies` and config files (`vitest.config.*`, `jest.config.*`, `.mocharc*`, `karma.conf.*`).
- Check for an existing Stryker install with `npx stryker --version` run in that package, and look for `stryker.conf.*` or `stryker.config.*`. An existing config encodes the project's choices, so reuse it and only override `mutate`.
- Check the `test` script for prerequisite steps (for example building a wasm package first). Run those once before Stryker, because Stryker calls the runner directly and skips the script.

## Installing (ask first)

If Stryker is missing, show the user the command for their package manager and runner, and wait for approval. Prefer installing it into the scratch copy you run Stryker in (see "Check the test count"), which leaves the user's `package.json`, lockfile, and `node_modules` untouched for the whole review. For vitest the command is the following.

```bash
pnpm add -D @stryker-mutator/core @stryker-mutator/vitest-runner
```

Use `@stryker-mutator/jest-runner` or `@stryker-mutator/mocha-runner` for those runners. Tell the user this edits `package.json` and the lockfile. At the end of the review, revert both and reinstall unless the user asked to keep Stryker (`git checkout -- <package.json> <lockfile> && pnpm install`). A temporary `npx -p @stryker-mutator/core -p @stryker-mutator/vitest-runner stryker run` avoids editing files but often fails, because the runner plugin must resolve the project's own `vitest` from the temporary install location.

For TypeScript, `@stryker-mutator/typescript-checker` with `--checkers typescript` rejects type-invalid mutants before any test runs. That turns them into `CompileError` quickly instead of spending test time on them. It is optional and worth it when tests are slow.

## Command template

```bash
python3 <skill-dir>/scripts/diff_ranges.py "$SCRATCH/scope.diff" --strip-prefix packages/lib/ --include 'src/**' --format stryker
# prints something like src/net-tunnel.ts:120-164,src/net-tunnel-codec.ts:40-52

npx stryker run \
  --testRunner vitest \
  --mutate "src/net-tunnel.ts:120-164,src/net-tunnel-codec.ts:40-52" \
  --reporters json,clear-text,progress \
  --coverageAnalysis perTest \
  --disableBail \
  --concurrency 4
```

- `--mutate` takes comma-separated globs, and each entry may carry a line range as `file:start-end`. A single line still needs the range form (`file:115-115`), since `file:115` matches nothing and the run fails with "No tests were executed". Use `diff_ranges.py` to turn the scope diff into ranges on changed lines. For a test-only change, pass ranges covering the functions that the changed tests exercise instead.
- Paths in `--mutate` are relative to the directory Stryker runs in, so strip the package prefix with `--strip-prefix`.
- `--disableBail` keeps running tests after the first failure, so `killedBy` lists every killing test. It is what makes kill attribution to the changed tests possible, at some cost in run time.
- `--reporters json` writes `reports/mutation/mutation.json` relative to the run directory. Copy it to `$SCRATCH` and delete `reports/mutation/` afterwards if it did not exist before the run.
- `--dryRunOnly` runs the initial test pass and coverage measurement without mutating. Use it to confirm the setup and to check the test count (see below).
- `--timeoutMS` and `--timeoutFactor` control when a mutant counts as timed out. Tests that wait on a promise instead of failing fast turn many mutants into timeouts, so if the timeout share is high, rerun a sample with a tighter timeout to see which are real hangs.
- `--incremental` reuses results from `reports/stryker-incremental.json` across runs. It is useful when iterating on new tests to kill survivors.
- `--testRunner command` with `--commandRunner.command "<cmd>"` is the fallback for unsupported runners. It cannot measure coverage, so there is no `NoCoverage` and every mutant runs the full command.

Options without a CLI flag go in a config file. Write it to `$SCRATCH/stryker.config.json` and pass its path as the first argument to `stryker run`, so nothing new lands in the user's package. Two vitest-runner options matter here. `"vitest": { "related": false }` runs every test file instead of only those vitest considers related to the mutated file, and `"inPlace": true` mutates the real files instead of a sandbox copy.

## Check the test count

Stryker copies the package directory into `.stryker-tmp/` and runs the tests there. A test file that imports anything outside the package (for example `../../netproto/golden.json`) fails to load in the sandbox, and Stryker silently drops it while still reporting a successful dry run. In one review this removed 69 of 211 tests and made every number wrong.

After the dry run, compare the number of tests Stryker ran (in the clear-text output, or the sum of `tests` across `testFiles` in `mutation.json`) with the count from running vitest directly. If Stryker ran fewer, set `inPlace: true`. In-place mode edits real source files while it runs, and an interrupted run leaves them mutated, so only use it inside a scratch worktree (`git worktree add --detach "$SCRATCH/tree" HEAD` plus the scope diff and a `node_modules` install or symlink), never in the user's own checkout.

## Suites Stryker cannot see

Stryker's vitest and jest runners execute tests in Node. Playwright suites, vitest browser mode, and end-to-end suites that load a built bundle are outside the run. Treat survivors in code those suites exercise as "caught elsewhere, unverified" unless you spot-check them by hand.

## Output format

`mutation.json` follows the mutation-testing-elements schema. `files` maps each source path to an object holding `source` and a `mutants` array. Each mutant has `mutatorName`, `replacement`, `location.start/end` (1-based lines and columns), `status` (`Killed`, `Survived`, `NoCoverage`, `Timeout`, `CompileError`, `RuntimeError`, `Ignored`), and, when coverage analysis is on, `coveredBy` and `killedBy` test ids that map to `testFiles`. The bundled `summarize.py` reads this file directly and shows the original source text next to each mutation.
