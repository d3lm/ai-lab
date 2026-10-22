---
name: mutation-test-review
description: Reviews the tests in the current git changes, a branch, a commit range, or a GitHub PR, and runs mutation testing (cargo-mutants for Rust, StrykerJS for TS/JS) against the code those tests exercise. It classifies every mutant as killed, survived, no coverage, timed out, or error, triages the survivors, and reports concrete assertion gaps that line coverage cannot reveal.
disable-model-invocation: true
argument-hint: "[PR number or URL | base ref | commit range] [extra focus]"
---

# Mutation test review

This skill judges whether tests would catch real bugs. Line coverage only proves that code ran. Mutation testing injects small deliberate faults (flip `<` to `<=`, return `Default::default()`, drop a call) and re-runs the tests. A mutant that no test notices marks a behaviour the tests never pin down. That signal is what makes this skill worth running, especially on AI-written tests that execute plenty of code while asserting very little.

A mutation score on its own is weak evidence. A tool can report 100% because every mutant in the interesting functions failed to compile, or because the run silently skipped a third of the test files, or because a third of the mutants timed out. The value of this review comes from checking that the numbers mean something and from the triage that follows, so spend your effort there.

The user invoked this skill explicitly, and the argument (if any) is `$ARGUMENTS`.

## Outcome vocabulary

Use these five classes everywhere (in the summary table, the triage, and the prose) so reports stay comparable across tools.

| Class | Meaning | cargo-mutants | Stryker |
|---|---|---|---|
| killed | At least one test failed, so the fault was detected. | `caught` | `Killed` |
| survived | Tests ran the mutated code and still passed, which points to an assertion gap. | `missed` | `Survived` |
| no coverage | No test executed the mutated code at all, which points to a missing test. | not reported natively (see the Rust reference) | `NoCoverage` |
| timed out | The mutant made tests hang, usually an infinite loop. It counts as detected. | `timeout` | `Timeout` |
| error | The mutant did not compile or crashed the runner. It is excluded from the score. | `unviable` | `CompileError`, `RuntimeError` |

The mutation score is `(killed + timed out) / (killed + timed out + survived + no coverage)`. When there are no-coverage mutants, also report the covered score, `(killed + timed out) / (killed + timed out + survived)`, because it isolates assertion quality from missing tests. Leave it out when it equals the score.

## Workflow

Create a scratch directory outside the repo first (for example `SCRATCH=$(mktemp -d -t mutation-review)`) and keep every diff, report, log, and worktree there. Mutation tools write large output directories, and the user's tree should look exactly the same after the review as before. That includes `node_modules`, the lockfile, and build output directories, so do builds, tool installs, and every run that edits source files in a scratch copy (a worktree with the scope diff applied, and its own `CARGO_TARGET_DIR` for Rust). Never apply a mutation in the user's checkout and "restore" it with `git checkout`, because that silently wipes any uncommitted edits in the same file.

Shell variables do not survive between commands, so write the literal scratch path into every command that needs it. Never park it in a fixed shared location (a named file under `/tmp`, an environment file in your home directory): another review running at the same time can overwrite it and send your mutations into its worktree, or its mutations into yours. Keep a list of every worktree you register, including ones you abandon midway, and remove all of them in step 10.

### 1. Resolve the scope

Work out which diff to review and which tree contains the code under test.

- With no argument, review uncommitted work (staged, unstaged, and untracked files) against `HEAD`. If the tree is clean, review the current branch against its merge-base with the default branch. If that is empty too, ask the user what to review.
- A PR number or URL means a GitHub PR. Get metadata with `gh pr view <pr> --json number,headRefOid,baseRefName,url` and the diff with `gh pr diff <pr>`.
- An argument containing `..` is a commit range. Any other ref is a base branch, so diff from the merge-base (`git diff $(git merge-base <base> HEAD)`, which also includes uncommitted work). A plain `git diff <base>` would mix in every newer commit on the base in reverse. A request like "review commit abc123" means `abc123~1..abc123`.
- Any remaining words narrow the focus (for example "only the relay crate").

When the scope is a branch or PR, check whether the target branch already contains the same change. Run `git cherry -v <base> HEAD` (a leading `-` marks a commit whose patch is already upstream), and for test changes also check whether the new test names already exist on the base (`git grep -n '<test name>' <base>`). If they do, lead the report with that fact, because it may make the branch redundant.

The mutation tool must run against the tree that the diff describes. `cargo mutants --in-diff` warns "The diff might be out of date with this source tree" and finds zero mutants when they disagree. If the end of the range is not the current working tree (a PR you are not checked out on, or an older commit), create a detached worktree with `git worktree add --detach "$SCRATCH/tree" <sha>` (use `git fetch origin pull/<n>/head` for PRs). Never check out, stash, or reset in the user's own tree, because they may have uncommitted work. A fresh worktree has no build artifacts or `node_modules`, so tell the user it needs a cold build and install.

Save the diff to `$SCRATCH/scope.diff`. For uncommitted work, stage nothing. Use `git diff HEAD` and append untracked files with `git diff --no-index /dev/null <file>`.

### 2. Map tests to the code they exercise

Split the changed files into test code and production code, and group them by language. Rust test code includes `#[cfg(test)]` modules, `tests/` directories, and test-only module trees such as `src/tests/`. cargo-mutants never mutates `#[cfg(test)]` code, so test-only diffs yield no mutants on their own.

Then choose mutation targets.

- **Production code changed.** Mutate the changed lines. This is the default and the cheapest run.
- **Only tests changed** (new cases, "tightened" assertions). Read the changed tests, find the functions and modules they call, and mutate those. The question becomes "do these tests catch faults in the code they claim to cover?" Keep the target tight (the specific functions, not whole large files) by using `--list` output to build a `--re` filter or a line-range mutate spec.
- **Tests were deleted.** Mutate the code the deleted tests used to cover, and confirm the remaining tests still kill those mutants. A deletion justified as "redundant" is exactly the claim mutation testing can check.

Also look for sibling copies of the logic in scope, such as the same limit, constant, or guard duplicated in a neighbouring module (a connected and an unconnected variant of a socket, say). A gap in one copy usually exists in the other. Add siblings to the mutation target when they are small, or name them in the report when they are not.

### 3. Learn how the project really runs its tests

Read `package.json` scripts, `Makefile`, test shell scripts, CI workflows, `.cargo/mutants.toml`, `.config/nextest.toml`, and `stryker.conf.*`. A mutation tool only sees the tests its own command runs. Suites that run elsewhere (wasm targets behind a custom runner, Playwright or browser tests, integration suites in another package) cannot kill mutants, so survivors those suites might catch are not proven gaps. Note every suite the run leaves out for triage and the caveats.

Run any prerequisite steps (generated bindings, a wasm build, codegen) before the baseline, then run the plain test command once and record how many tests it executes. You will compare the mutation tool's count against this number in step 5.

### 4. Check tools and estimate cost

Read the reference for each language in scope. They cover flags, gotchas, and output formats.

- `references/rust.md` covers Rust with cargo-mutants.
- `references/typescript.md` covers TS/JS with StrykerJS.

If a tool is missing, stop and ask. Show the exact install command and what it changes (a global `cargo install`, or new dev dependencies in `package.json` and the lockfile). Do not install anything without approval.

Always list the mutants before running them (`cargo mutants --list` or a Stryker dry run). Read the list, not just the count. Prune mutants that can never compile (the Rust reference describes the common type-alias pattern), because each still costs a build. Estimate the wall time as baseline build plus test time, multiplied by the remaining mutant count, divided by the job count. If the estimate exceeds about 15 minutes, tell the user the number and propose a narrower target before running.

### 5. Run mutation testing, and review the tests statically meanwhile

Start the mutation run in the background. While it runs, read the changed tests and write down static findings. Look for these problems.

Record every finding as a claim of the form "this test still passes when the code does X wrong" or "this test passes in mode Y whatever the code does". A static finding is a hypothesis, not a verdict, and step 6 turns each one into a probe.

- Tests that cannot fail. Examples are assertions inside branches that never execute, errors that get swallowed, a missing `await` on an async expectation, `expect(promise)` without `.rejects` or `.resolves`, loops over empty collections, and comparisons of a value with itself (for example `before.inode == after.inode` when both come from the same cached struct).
- Weak assertions such as `is_ok()`, `is_some()`, `toBeTruthy()`, a single field of a struct that has several meaningful fields, or a bare "does not panic" check, used where the exact value is known and cheap to assert. Ordering and range checks (`a > b`, `x <= limit`, `toBeGreaterThan`) belong here too when the exact value is computable, because any wrong formula that keeps the order passes.
- Test helpers with a mode that skips or neuters the comparison: a golden or snapshot helper that rewrites the expected file and then compares against what it just wrote, an environment variable or flag that turns failures into warnings or skips, a retry wrapper that hides the first failure. In that mode every test using the helper passes whatever the code does.
- Negative tests without a positive control. A test that asserts "no WINDOW frame is sent" also passes when the frame interceptor is broken, unless the test first shows the interceptor sees a frame.
- Assertions on mocks or fixtures instead of on the behaviour under test, and snapshots so broad that any change "passes" after a re-record.
- Test names that promise more than the body checks.
- Missing boundary and error-path cases for the logic that changed, such as the exact limit, the empty input, or the permission failure.
- Timing-based synchronisation (sleeps, polling with generous timeouts) that makes a test flaky or slow enough to time out mutants spuriously.
- Hard-coded lists that duplicate a source of truth, such as a test that loops over a literal list of file names, routes, or error codes. A new entry will silently go untested, so suggest deriving the list (from `readdir`, the registry constant, or the enum) when that is cheap.

When the run finishes, sanity-check it before trusting any number.

- **Test count.** Compare the number of tests the tool ran in its baseline with the count from step 3. Stryker's sandbox copies only the package directory, so a test that imports a file from outside it silently disappears and the dry run still reports success. A drop in the count means the numbers are wrong. Fix the setup and rerun, and say in the report whether you observed the drop in a run or inferred it from the imports. Any comparison run (kill attribution, parent tests) needs the full count too.
- **Unviable share.** If most mutants in the functions that matter were errors, the score says nothing about those functions. Say so plainly and cover them with hand-applied mutations (step 6).
- **Timeout share.** If more than about a fifth of the mutants timed out, the score is inflated, because a timeout counts as detected without any assertion failing. Sample a few timeouts to see whether they are genuine hangs or slow tests hitting the limit, report the score with timeouts excluded as well, and suggest a tighter timeout for a rerun.

### 6. Go beyond the tool's operators

Mutation tools only apply a fixed menu of operators, and the most important faults in a change often fall outside it. Four techniques fill the gap, and all of them run in a scratch worktree (`git worktree add --detach "$SCRATCH/probe" HEAD`, then apply the scope diff for uncommitted work), never in the user's tree.

- **Revert check.** When the diff changes production code, put the pre-change production files back in the scratch tree while keeping the new tests (`git checkout <base> -- <production files>`), and run the changed tests. Every new test that still passes against the old code does not test the change at all. A table of test name against "fails on old code" is often the single most convincing artifact in the report.
- **Kill attribution.** When the question is what the new or changed tests add, measure it. With Stryker, set `disableBail: true` so `killedBy` lists every killing test, then count mutants killed only by the changed tests. With cargo-mutants, rerun the same mutants with the parent commit's version of the test files (or with `-- --test <file>` and `--exact <name>` filters) and compare. Report the mutants the change newly kills.
- **Hand-applied mutations.** Write 5 to 15 targeted faults for the core of the change, especially where the tool produced nothing that compiled, and for things the tool never mutates (struct literal fields, a whole-struct copy replaced by a partial one, a skipped branch for one input shape, a reported position or range). Think about the input shapes the code handles (comments, trailing commas, empty collections, boundary sizes) and mutate the handling of each. Apply each fault, run the relevant tests, restore, and record the outcome in the same five classes. Write the faults once, as a JSON list of `{"id": "H1", "file": "src/x.rs", "find": "<exact text, occurring once>", "replace": "<faulty text>", "desc": "<one line>"}` saved as `$SCRATCH/hand.json`, and loop apply, test, and restore over that file. Step 8 feeds the same file to `scripts/kill_matrix.py`, so the faults your suggested tests are verified against are exactly the ones you probed with. You chose these faults to find gaps, so their kill rate is biased low by construction. Report them as a list of gaps found, not as a score that represents the suite.
- **Probe every changed test and every static finding.** Faults chosen only from the changed production lines miss the weaknesses in the tests themselves, so build a second set from the test side.
  - For each changed or added test, write down the behaviour its name and assertions claim to check (growth, ordering, a cap, an error variant, a layout property), then write one or two faults that break exactly that behaviour while keeping the rest plausible. For example, change a multiplier or offset in a formula under a test that only checks "bigger than before", or return the right error kind with the wrong payload under a test that only checks "is an error". These faults may sit on lines the diff did not touch; the question is whether the new test detects them.
  - For each static finding from step 5, construct the situation it describes and run it. For a weak assertion, apply a fault the assertion should catch. For a helper mode that bypasses the comparison, set that mode, apply a fault that changes the output, and run the tests. For a negative test without a positive control, break the interceptor or filter it relies on.
  - Each probe ends in one of two outcomes. If the fault survives (or the tests pass in the bypass mode with the fault applied), the finding is a test gap and goes through step 8 like any survivor, with a verified fix. A fix for a bypass mode makes that mode unable to pass silently (write the file and then fail with a message saying it was updated, or write it and return without asserting while the normal run still compares), and is verified by running the tests in that mode with the fault applied. If the fault is killed, name the test that killed it, and the finding is contradicted.
  - Do not close a finding by appeal to convention or intent ("this is the usual pattern for that kind of helper", "fine as a smoke test", "only a problem if someone misuses the flag", "harmless"). Those describe why the weakness exists, not whether a fault gets through. Only a probe settles it.

### 7. Normalise the results

Run the bundled summariser on the tool output. It maps both tools onto the five classes, computes the scores, and lists every non-killed mutant with its location and the path to its diff.

```bash
python3 <skill-dir>/scripts/summarize.py <outcomes.json | mutation.json> [--diff "$SCRATCH/scope.diff"] [--lcov lcov.info] [--root <dir the tool ran in>]
```

`--diff` keeps only mutants whose span touches a changed line. `--lcov` reclassifies survivors on lines that no test executed as no coverage, which matters for Rust because cargo-mutants cannot tell the two apart. Pass `--format json` for machine-readable output.

### 8. Triage every survivor, no-coverage mutant, and timeout

Raw counts mislead, so the triage is the core of the review. For each mutant (from the tool and from your hand-applied set), open its diff, read the surrounding code, and put it in exactly one bucket.

- **Test gap.** A real behaviour change that no test pins down. This includes every static-finding probe from step 6 whose fault survived. Explain in one or two sentences what bug this mutant stands for and why the current tests miss it. Then suggest the smallest test or assertion that would kill it, written in the project's existing test style and helpers.
- **Equivalent.** No test could ever detect the mutant because behaviour is identical. Say why it is equivalent. These are not gaps.
- **Low value.** The mutant changes behaviour nobody should assert on, such as log text, `Debug` output, or a metrics label. Keep this bucket honest. A protocol constant, an error code, or a public `Display` format usually does matter.
- **Caught elsewhere, unverified.** A suite the run left out (from step 3) plausibly exercises this code. Name the suite. If a spot check is cheap, apply the mutant in a scratch worktree and run that suite to settle it.

Before you rank a gap as high or low risk, check the claim the ranking depends on. If you think an input "cannot occur", find out whether upstream tooling really prevents it (run the formatter on a sample, or check whether the CLI refuses such files). If you think it is rare, look at what real code in the repo contains. For example, a lint rule that stops checking token kinds matters a lot when the house style puts multi-line block comments exactly where the rule operates.

Suggested tests need to close the whole gap, not one instance of it.

- List every entry point that reaches the changed behaviour (for example `stat(path)`, `fstat(fd)`, `stat("/proc/self/fd/N")`, and `fstat` on a reopened fd) and make the test exercise each one.
- Compare whole values against an independent oracle (`assert_eq!(fstat(fd), stat(path))`) rather than one field, so faults in the fields nobody thought of die too.
- Use realistic inputs, meaning the shapes that real code in the repo has (the house comment style, typical sizes, real fixtures), not contrived ones that only exist to trip the mutant.
- Give each test one concern. Folding two unrelated assertions into one test lets the first failure mask the second.
- Make fixtures tell apart the values a bug could confuse, such as a uid that differs from the gid, sizes that differ from each other, or two arms with different shapes.
- Avoid building new drift into the test. Derive lists from the source of truth instead of hard-coding them, and prefer a lower bound or a non-empty check over an exact count that breaks when someone adds an entry.
- Test behaviour, not the implementation. An assertion that only restates a getter (`assert!(rule.edits_only_whitespace())`) is a change detector. Check the effect the flag promises instead (for example, that every fix the rule produces touches only whitespace).
- Verify every suggested test with the kill matrix (below), and claim for each test only what its own line in the matrix shows. If you did not run a test, do not present it as a test and do not claim what it kills. Either run it or downgrade it to a one-line idea under the gap.

When you compare entry points, also look at where they disagree in error behaviour (one path succeeds while a sibling path fails with `ESRCH`, for example). Such asymmetries are often design questions the change raised without answering, so report them as questions for the user. Claims about how another system behaves (Linux, a browser, a protocol spec) need a citation or a check. Otherwise frame them as questions, not findings.

Rank test gaps by risk. A gap in error handling, bounds checks, permissions, or protocol encoding outranks a gap in a convenience accessor. Then pick the one or two tests the user should add first. A long list of equally weighted tests is hard to act on, especially for a small change.

#### Verify suggested tests with the kill matrix

A kill claim in the report ("this test kills C2 and H5") is a claim about that one test, in the exact text the report shows, against mutants that were really applied. Evidence about anything else does not back it: a rerun of the whole suite or of all suggested tests together, a run of an earlier draft of the test, a tool run where the mutant timed out and no killing test was recorded, a hand run of a change you consider "equivalent" to the claimed mutant, or a gap's list of survivors that some other suggested test killed. Those runs are fine as evidence for a suite-level row in the Evidence table, not for a per-test claim.

So once every suggested test is final, write each one verbatim into the scratch worktree, in the file and module where the report tells the user to put it, and run the bundled script from outside the tree:

```bash
python3 <skill-dir>/scripts/kill_matrix.py --tree "$SCRATCH/probe" \
  --test <name> --test <name> \
  --hand "$SCRATCH/hand.json" \
  --cargo-outcomes "$SCRATCH/mutants.out/outcomes.json"   # or --stryker "$SCRATCH/mutation.json"
```

- `--test` is the test function name or path for cargo (`tests::rejects_empty`), or `<test file>::<test title>` for vitest (`test/parse.test.ts::rejects an empty spec`; a describe prefix may be added to disambiguate). Pass every suggested test, including tightened versions of existing ones. Use `--cargo-args "-p <crate> --lib"` to pick the package or test target, and `--stryker-root` when Stryker ran in a different directory from `--tree`.
- `--cargo-outcomes` adds the tool's missed and timed-out mutants, `--stryker` adds survived, no-coverage and timed-out ones (`--all-statuses` adds killed ones too), and `--hand` adds your faults. Every mutant you want to name in a kill claim must be in the run. If a claim needs a fault the tool did not produce, add it to the hand file and rerun.
- The script runs each test alone on the real code, then applies each mutant, runs each test alone again, restores the file, and prints a `K`/`T`/`.`/`E` matrix plus one line per test, such as `t3 keeps_order_on_ties: kills C2 H3; times out on H7 (3 of 12)`. It refuses to run in a main checkout, and it restores every file even when interrupted. For jest, mocha, or another runner it does not support, run each test alone per mutant by hand and show that output for each claim.

Then write the claims from the output of the last run.

- For each suggested test, name only the mutants its own line lists after "kills" or "times out on" (say "times out" for the second group). Do not credit one test with a mutant that a sibling test kills, even when both close the same gap. When a gap lists the survivors that motivated it, say which of them the shown test kills and which remain, or which other suggested test kills them.
- If you change a suggested test after the run (a value, a name, merging or splitting tests), rerun the script. The output that backs a claim must come after the last edit of that test.
- A test whose real-code line says FAILS or HANGS is not a suggested test, and no kill claim may be made for it. If it fails because the code has a real bug, report the bug as a finding or question (input, observed output, expected output) under Caveats, and offer the test together with a fix. Do not put a failing test in "Add these first" or "Other gaps".
- A mutant marked `E` did not build or load, so it is not a kill. Fix the fault or drop it.
- A test that pins a behaviour rather than a mutant still goes through the script, so its real-code PASS is on record. Say that it pins behaviour.

### 9. Write the report

The user asked whether their tests catch real bugs, so answer that first and keep the evidence below it. Aim for a report that can be read in two minutes. Put any recommendation that changes what the user does with the branch (for example, "master already has this test, drop the commit") in the opening lines, not at the end. List only surviving mutants in tables and summarise killed ones as a count. Show the code for every test you suggest, or link a diff that contains exactly that code.

```markdown
# Mutation test review for <scope>

<Two or three sentences with the verdict. Say whether these tests would catch realistic bugs in the changed code and name the single biggest gap. If the base branch already contains the change, say that first.>

## Add these first
<The one or two highest-value tests as code blocks, each with one sentence on the bug it catches and the mutants it kills on its own, copied from its line in the final kill matrix.>

## Evidence
<Revert-check table for production changes, or the mutants newly killed by the changed tests for test-only changes. Then the results table, one row per tool run, and one short paragraph on whether the score means anything (test count, unviable share in the key functions, timeout share).>

| Killed | Survived | No coverage | Timed out | Error | Score |
|---|---|---|---|---|---|

The run used <tool + exact command>, took <duration>, and ran <N of N> tests from <which suites>.

## Other gaps
<The remaining ranked gaps, each with `file:line`, the mutation, the bug it represents, why the tests miss it, and a suggested test with the mutants it kills on its own, copied from its line in the final kill matrix.>

## Static findings
<Findings from step 5, each with the probe from step 6 that settled it: "confirmed by <mutant or probe>" with a pointer to the gap and its fix in the sections above, or "contradicted: <probe> was killed by <test>". There is no third label. A finding you could not probe goes under Caveats as an open question, not here as a verdict.>

## Equivalent and low-value mutants
<One line each with the reason.>

## Caveats
<Suites not run, siblings left out, narrowed scope, or anything else that limits the conclusions.>
```

End by offering to add the tests.

### 10. Clean up

Remove every worktree you created, including any you stopped using, and confirm with `git worktree list` that only the user's own worktrees remain and delete tool output that landed inside the repo (for example Stryker's `reports/mutation/` and `.stryker-tmp/`, and any Stryker config file you created). If dependencies ended up installed in the user's checkout, revert `package.json` and the lockfile and reinstall, unless the user said to keep them. When the user explicitly asked for the tool to be added to their project, do the mutation runs from a scratch copy anyway, then at the end add the dev dependency, a working config (including any setting such as `inPlace` that the run needed), and ignore entries for the tool's output directories. Tell the user exactly what you added and how to remove it. Then run `git status` and confirm the user's tree matches its state before the review. Mention where the scratch artifacts live in case the user wants the raw logs.
