# Rust with cargo-mutants

Check for it with `cargo mutants --version`. If it is missing, the install command is `cargo install --locked cargo-mutants`, and you need the user's approval first. The docs live at https://mutants.rs.

## Command template

```bash
cargo mutants \
  --gitignore true \
  -o "$SCRATCH" \
  --in-diff "$SCRATCH/scope.diff" \
  -p <package> \
  -j <jobs>
```

Run it from the workspace root of the tree that matches the diff. Results land in `$SCRATCH/mutants.out/`.

## Flags that matter

- `--gitignore true` is essential. cargo-mutants copies the whole source tree into a scratch build directory for the baseline and again for each job. Version 27 copies gitignored files by default, which includes every `target/` directory and `node_modules`. In one monorepo that meant 185 GB and 580k files, and a 12-second run took 9 minutes. With `--gitignore true` the copy skips build output, and a cold build in the scratch dir is still far cheaper than copying.
- `-o "$SCRATCH"` keeps `mutants.out/` out of the repo.
- `--in-diff FILE` restricts mutants to lines the diff touches. The diff must match the tree, otherwise cargo-mutants prints "The diff might be out of date with this source tree" and finds nothing.
- `-p PACKAGE` limits generation to one crate (repeatable). Without it, `--in-diff` covers every workspace crate the diff touches.
- `-f GLOB` and `-e GLOB` include or exclude source files. `--re REGEX` and `--exclude-re REGEX` filter by mutant name as shown by `--list`. Names look like `src/fd/query.rs:24:5: replace OpenFileDescription::stat -> FileStat with Default::default()`, so a regex on the function name (for example `--re 'OpenFileDescription::stat\b'`) targets a single function.
- `--test-workspace true` runs every crate's tests for each mutant instead of only the mutated crate's tests. Use it when the mutated crate is a shared library (a protocol or codec crate) whose real tests live in its dependents, and expect proportionally longer runs. `--test-package NAME` is a cheaper middle ground.
- `-j N` sets parallel jobs. Each job keeps its own build directory and compiles independently, so memory is the usual limit. Start around a third of the core count for big crates. cargo-mutants also runs a jobserver sized to every core, so on a shared machine cap total compiler processes with `-j 1` plus `CARGO_BUILD_JOBS=<n>`.
- `--test-tool nextest` should be used when the project uses nextest.
- `--cap-lints true` stops `#![deny(warnings)]` or `-D warnings` in `RUSTFLAGS` from turning ordinary mutants (like an unused variable after a deleted statement) into unviable ones.
- `--baseline skip` saves one full build and test pass, but only use it when you just ran the same tests green yourself.
- `--timeout SECS` and `--minimum-test-timeout SECS` help when the auto-set timeout (derived from the baseline) is too tight for slow or variable tests.
- Never use `--in-place`, because it edits the user's working tree.

Respect an existing `.cargo/mutants.toml`. It may set `exclude_globs`, `exclude_re`, `skip_calls`, `test_tool`, `additional_cargo_test_args`, or `error_values`, and CLI flags combine with it.

## Listing and estimating

`cargo mutants <same filters> --list | wc -l` gives the count. The baseline line of a real run (`ok Unmutated baseline in 5s build + 1s test`) gives the per-mutant cost, since incremental builds after the first are usually faster than the baseline.

Read the list before running it. When a function returns a type alias for `Result` (for example `type KernelResult<T> = Result<T, KernelError>`), cargo-mutants cannot see through the alias and emits `KernelResult::new()`, `KernelResult::from(..)`, and `KernelResult::from_iter(..)` replacements that never compile. In one crate these were 67 of 84 mutants, and each still cost a build attempt. Exclude them with `--exclude-re '<Alias>::(new|from|from_iter)\b'`, and consider adding the same pattern to `exclude_re` in `.cargo/mutants.toml` if the user wants it persisted.

Also watch for body replacements with `Default::default()` on types that do not implement `Default`. They are unviable too, which means the tool generates nothing that compiles for those functions. When those functions are the heart of the change, cover them with hand-applied mutations as described in SKILL.md.

## Output files

`mutants.out/` contains the following.

- `outcomes.json` holds every scenario (the baseline plus each mutant) with `summary` set to `CaughtMutant`, `MissedMutant`, `Timeout`, or `Unviable`, along with `diff_path` and `log_path`. The bundled `summarize.py` reads this file.
- `caught.txt`, `missed.txt`, `timeout.txt`, and `unviable.txt` list mutant names, one per line.
- `diff/*.diff` shows each mutation as a patch. The `+++` header holds the mutant name instead of a path, so `git apply` rejects it. Apply one to a scratch worktree with `patch -p0 <file> < <diff>` and revert it with `patch -R -p0 <file> < <diff>`.
- `log/*.log` contains the full build and test output per mutant, which shows which test killed a caught mutant. `cargo test` stops at the first failing test binary, so a log only names the killers in that binary. To attribute kills to a specific test file or test, rerun with `-- --test <file>` or `-- --test <file> -- --exact <name>`.

## No coverage for Rust

cargo-mutants reports both "no test reached this" and "a test reached this but did not check it" as `missed`. The distinction matters because the first calls for a new test and the second for a stronger assertion. If `cargo llvm-cov` is installed, generate coverage for the same package and test command (`cargo llvm-cov -p <package> --lcov --output-path "$SCRATCH/lcov.info"`) and pass `--lcov` to `summarize.py`. If it is not installed, do not install it unprompted. Decide per survivor during triage by checking whether any test calls the function (grep the test modules, or read the mutant's log to see which tests ran), and label it no coverage when you are confident nothing reaches it.

## Tests that cargo-mutants cannot run

cargo-mutants runs `cargo test` (or nextest) for the host target. It does not run wasm tests behind a custom runner, shell-scripted suites, or JS and browser suites that exercise a wasm build of the crate. Treat survivors in code those suites cover as "caught elsewhere, unverified" unless you spot-check them. A spot check means applying `mutants.out/diff/<name>.diff` in a scratch worktree and running the other suite by hand.

## Skipping equivalent mutants

If the crate already depends on the `mutants` crate, `#[mutants::skip]` on a function is the idiomatic way to silence a confirmed equivalent mutant. Otherwise suggest an `exclude_re` entry in `.cargo/mutants.toml`. Only suggest these for mutants you have argued are equivalent in the report.
