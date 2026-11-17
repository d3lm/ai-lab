---
name: code-review-loop
description: Runs a deterministic review loop over a code change (branch or uncommitted work). Codex reviews the diff for correctness first and code quality second, restricted to the change's scope. Every claim needs proof that the other side can open or rerun. Codex may not raise a finding without evidence, and Claude verifies that evidence and either fixes the finding with the smallest edit and proof that the fix works, or rejects it with counter-evidence. Both sessions are resumed every turn. Neither side may touch unrelated code or pre-existing issues, and the script records every out-of-scope edit. Stops when Codex approves, when a finding has been rejected three times (disputed, escalated to the user), or at the turn limit. Use when the user asks to review a branch, PR, or diff with codex and claude, iterate on a change until it passes review, or harden an implementation before opening a PR.
argument-hint: optional --cwd for the repo, --base for the ref to compare against, --goal for what the change is meant to do, --check for a test command
allowed-tools: Bash(node:*), Bash(cat:*), Bash(ls:*), Bash(jq:*), Bash(git status:*), Bash(git diff:*), Bash(git log:*)
disable-model-invocation: true
---

# Code Review Loop

One script owns the loop. Do not re-implement it with ad hoc `claude` or `codex` calls, and never edit `state.sqlite`.

```bash
REVIEW="<skill-dir>/resources/review-code.mjs"
node "$REVIEW" --cwd <repo> --goal "<what the change does>" --check "<test command>"
```

`<skill-dir>` is the directory that holds this file. Write its absolute path into the variable. The script needs the `agent-orchestrate` skill in the same skills directory, Node 24.15 or later, and macOS or Linux.

## Run

The change under review is everything that differs between the merge-base of `--base` and the working tree, including untracked files and excluding lockfiles. Committed branch work and uncommitted edits are both covered. On the base branch itself, only uncommitted work is reviewed.

Pass `--goal` whenever the user has stated intent (a sentence, a ticket, or a plan file path). Correctness is judged against it, and it bounds the scope. Pass `--check` when the repository has a fast test or typecheck command. The script runs it before the loop and after every Claude turn, and Claude may run exactly that command.

Each turn takes minutes. Start the script with your host's background process facility (in Claude Code, the Bash tool's `run_in_background`). A bare `&` and a PID file are not supervision. As soon as stderr prints `run dir: …`, give the user that path. `run.md` in it is rewritten after every step and can be read while the loop runs.

The Codex defaults match the `agent-orchestrate` skill, and Claude defaults to Opus 5.5 with the 1M-token context window. Override models or effort only when the user asks.

| Option                              | Default                                    | Meaning                                                                                                   |
| ----------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `--cwd DIR`                         | current directory                          | Names the repository, which must be a git work tree.                                                      |
| `--base REF`                        | `origin/HEAD`, then `main`, then `master`  | Names the ref whose merge-base with HEAD is the start of the change.                                      |
| `--goal TEXT\|FILE`                 | inferred from the diff and commit messages | States the intent of the change. A path is read as a file.                                                |
| `--check CMD`                       | none                                       | Sets the command that runs in `--cwd` through `sh -c` in the check sandbox. Claude may run only this one. |
| `--check-writable DIR`              | none                                       | Adds a directory the check may write to, such as a test cache. The option is repeatable.                  |
| `--check-sandbox MODE`              | `os`                                       | Selects the check sandbox. `none` runs the check unconfined (see Safety).                                 |
| `--max-turns N`                     | 6                                          | Sets the number of Codex review rounds. Codex always has the last word.                                   |
| `--dispute-after N`                 | 3                                          | Sets how often Claude may reject one finding before it is escalated instead of looped.                    |
| `--codex-model`, `--codex-effort`   | `gpt-6-astra`, `xhigh`                     | Selects the reviewer's model and reasoning effort.                                                        |
| `--claude-model`, `--claude-effort` | `claude-opus-5-5[1m]`, `high`              | Selects the author's model and reasoning effort. The `[1m]` suffix selects the 1M-token context window.   |
| `--claude-budget USD`               | 15                                         | Caps the spend of each Claude turn. Claude enforces the cap.                                              |
| `--run-dir DIR`                     | `<runs root>/<stamp>-code-review-<branch>` | Sets where artifacts go. The runs root is `ORCHESTRATOR_HOME`, or `~/.orchestrator` when that is unset.   |
| `--resume DIR`                      |                                            | Continues a failed or interrupted run from its last completed turn.                                       |
| `--accept-partial-turn`             | off                                        | Lets `--resume` rerun a turn that ended uncertain or a Claude turn interrupted mid-edit.                  |

## Safety

The workers run through the shared runner in `agent-orchestrate`, which supervises their processes, resumes provider sessions, and keeps durable turn records and checkpoints. The runner does not check a workflow's permissions the way it checks a manifest, so the script applies the same policy itself.

- Codex runs `exec` in the `read-only` sandbox.
- Claude runs with `acceptEdits` and `permissionPrompts: "none"`. Its session has only the tools `Read`, `Glob`, `Grep`, `Edit`, `Write`, and `WebFetch`, plus `Bash` when a check is configured. Edits are approved only inside the repository and the run dir, and anything else that would prompt is denied. The only approved shell command is `Bash(<check>)`, and `bashSandbox` runs it in Claude Code's sandbox, which refuses to start without one.
- The script's own check runs in an OS sandbox (`sandbox-exec` on macOS, `bwrap` on Linux), because it executes code that Claude may have written. It can write only to the repository, the temporary directories, and each `--check-writable` directory. It keeps read and network access.
- Git commands run with hooks and fsmonitor disabled, and the diff format is pinned, so repository or user git configuration cannot run programs or change the reviewed patch.

Before any run state exists, the script resolves each CLI once (`CLAUDE_CMD` or `CODEX_CMD`, else a working binary on `PATH`, else a version-pinned `pnpm dlx`), dry-runs its exact arguments without invoking a model, and confirms that the check sandbox starts and refuses a write outside its roots. A sandbox cannot start inside another sandbox. In that case, and only when the whole script already runs inside an external sandbox or container, pass `--check-sandbox none`. Ask the user first. Never respond to a permission, authentication, or sandbox problem by loosening the profile.

Worker results are validated against the schemas in `resources/`. Malformed or fenced output fails the turn and is never repaired. Each turn is bounded at 90 minutes (`ORCHESTRATOR_TURN_DEADLINE_MS`).

## What the loop does

1. The script snapshots the change. The file list is the scope for the whole run, and the patch is `diff/diff-0.patch`.

2. Codex reviews the diff and returns `{verdict, findings[], preExisting[]}` with stable ids. Its standard puts correctness first (edge cases, error paths, callers, tests for the changed behavior). Next comes the code quality of the new code (simplest correct implementation, no spaghetti growth, reuse of canonical helpers, abstractions that earn their keep, explicit type boundaries, file size). Security and performance come last, and only where the change introduces them. Problems in code the change did not touch go to `preExisting` and never become findings. Edits the goal does not require are `scope` findings, and their fix is to revert. Every finding carries evidence, meaning entries that each name a file:line range, command, commit, goal sentence, or docs page (`ref`), quote what it shows, and say whether Codex ran it or only read it. The schema rejects a finding without evidence, and opinions such as "simpler" or "cleaner" do not count.

3. Claude verifies each finding and its evidence against the code. It fixes what is proven with the smallest edit inside the scope files, and rejects what is wrong, unproven, or out of scope. It returns `{addressed[], rejected[]}`, and every entry carries evidence. A fix cites the changed lines and, when the check runs a covering test, shows that test failing without the fix and passing with it. A rejection cites the code, caller, goal sentence, or check output that refutes the finding.

4. The script re-snapshots the diff, runs the check, and records which pre-existing files outside the scope were modified. Codex is resumed with the new diff, Claude's response, the out-of-scope list, and the check result. It checks Claude's evidence, drops a finding whose rejection holds, and re-raises one only with evidence that answers Claude's. Claude is resumed with the new findings and must answer re-raised evidence the same way. The loop repeats.

The script's exit code reports the outcome. Codes 64 and 70 are not run outcomes.

| Exit | Outcome     | Meaning                                                                                                                  |
| ---- | ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| 0    | `approved`  | Codex returned `approve` or no findings. Minor leftovers are listed as notes.                                            |
| 2    | `max-turns` | The turn limit was hit. Unresolved findings are listed under "Open findings".                                            |
| 3    | `stalemate` | Every remaining finding is disputed.                                                                                     |
| 1    | `failed`    | A worker exited non-zero, hit its budget or deadline, or returned a malformed envelope. The `error` field names the log. |
| 64   |             | A usage or configuration error occurred, such as a bad option, an old Node, or a failed preflight. No turn ran.          |
| 70   |             | The script itself failed.                                                                                                |

The script records a warning when Claude modified pre-existing files outside the scope, claimed fixes without changing the diff, broke a check that passed before the loop, was denied a tool, or skipped a finding id. A check that already fails before the loop is also a warning, so nobody attributes it to Claude.

## Monitor

Read `run.md` for progress. The runner's read-only commands also work on this run, with one task per turn (`codex-review-N` and `claude-address-N`).

- `node "$ORCHESTRATOR" status <run-dir> --json` gives each turn's state, attempt, and failure.
- `node "$ORCHESTRATOR" watch <run-dir> --after <cursor> --timeout-ms 60000` waits a bounded time for new events. Prefer it to polling in a loop.
- `node "$ORCHESTRATOR" report <run-dir>` writes the execution record to `execution.md`. `run.md` belongs to the script.

`$ORCHESTRATOR` is `<agent-orchestrate skill dir>/scripts/orchestrator.mjs`. The runner's `recover`, `continue`, `cancel`, and `cleanup` commands refuse this run, because only the script knows how to resume or stop it. To stop it, send the script SIGINT or SIGTERM.

## After the run

Read `run.md` (or the JSON the script prints on stdout) and report to the user as follows.

- State the outcome and the turn count.
- Show disputed findings with Codex's issue and evidence next to each of Claude's rejections and its evidence. The user decides these, so open the cited references and say which evidence holds.
- List the open findings if the turn limit was hit.
- Quote out-of-scope edits verbatim from the warnings, with the `git diff` of those files. The user decides whether to keep or revert them.
- List the pre-existing issues Codex noticed, so the user may act on them separately. The loop did not touch them.
- Give the check status before and after the loop.
- Give the total Claude cost and the run dir.

Distinguish what the workers claimed from what you checked. Run `git diff <merge-base>` (printed in `run.md`), or diff `diff/diff-0.patch` against the latest `diff/diff-N.patch`, and read what actually changed. The loop commits and stages nothing.

Do not resume the loop with more turns unless the user asks. Both sessions stay resumable, and their thread and session ids are in `run.md`.

## Recovery

After a `failed` outcome or an interrupted run, `node "$REVIEW" --resume <run-dir>` continues from the last completed turn with the run's original options. A turn that finished before the interruption is replayed from its record, not rerun. A failed turn runs again.

Resume stops and explains when a Claude turn was interrupted after it had started editing, or when a turn ended uncertain (its process could not be proven stopped). Compare `git diff <merge-base>` with the earlier diff snapshot, then pass `--accept-partial-turn` to rerun the turn on the current tree. The script records that as a warning.

Ctrl-C stops the running worker and fails the run, which `--resume` can continue. A second Ctrl-C exits at once. Resuming a run that already finished only regenerates its report and summary and exits with its outcome. A run from before checkpoint support (no `state.sqlite`) cannot be resumed.

## Artifacts

```text
~/.orchestrator/<stamp>-code-review-<branch>/
  run.md                           Holds the human report, which the script rewrites after every step.
  state.json                       Holds the machine-readable state, projected from the latest checkpoint.
  state.sqlite                     Holds durable turn records, sessions, and checkpoints. Never edit it by hand.
  state.<stamp>.sqlite             Holds earlier state, archived when a new run reuses the run dir.
  execution.md                     Holds the execution record, which only the runner's report command writes.
  tasks/<step>/attempts/<attempt>/ Holds one directory per turn (codex-review-N, claude-address-N).
    profile.json                   Holds the resolved worker profile, including its tool policy.
    launch.json, provider.json     Identify the host and provider processes.
    events.jsonl                   Lists the normalized provider events.
    exit.json                      Holds the exit receipt.
    provider-result.json           Holds the parsed provider result.
  diff/scope.txt                   Lists the files in the change when the loop started.
  diff/diff-N.patch                Holds snapshots, where 0 is the input and N is after Claude turn N.
  checks/check-N.log               Holds check output, where 0 is the baseline and N is after Claude turn N.
  codex/review/                    Holds prompt-N.md, out-N.jsonl, last-N.json, and err-N.log.
  claude/address/                  Holds prompt-N.md, out-N.json, and err-N.log. The last stream-json line is the result.
```

Prompts live in `resources/prompts/` and schemas in `resources/*.schema.json`. The review standard lives in `codex-review.md`. Edit those files to change the standard, and leave the loop alone.
