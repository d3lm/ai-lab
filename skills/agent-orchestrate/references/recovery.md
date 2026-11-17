# Recovery and cancellation

This document explains how the runner behaves after crashes, interrupts, and cancellation, and what the operator decides by hand. In short, run `recover`, read what it surfaced, and decide only the cases it cannot prove.

## Ownership

- A run has one owner at a time, which is a supervisor holding a lease in `state.sqlite` with an ownership generation. Every state change checks that generation inside its transaction.
- The lease lasts 30 s and is renewed every 5 s. `ORCHESTRATOR_LEASE_MS` shortens it for tests.
- A second supervisor cannot take a run while the lease is valid. `recover`, `continue`, and `cancel` refuse or queue their request instead.
- Each attempt host was started under one generation. It refuses to start its provider if the generation has changed. It cancels a running provider when the generation changes, or when the lease has been expired for another 30 s. An expired lease must stay expired for three renewal intervals of the host's own running time before it acts, so a machine waking from sleep gives its supervisor time to renew.
- An expired lease is a recovery signal, not proof that a worker stopped. Nothing is redispatched because of an expired lease alone.

## What `recover` does

`orchestrator recover <run-dir>` refuses a run whose stored tasks or dependencies differ from its manifest, because such a run was never created completely. Otherwise it takes a new lease, which increments the generation. It then settles every unfinished attempt before it dispatches anything, as the table below shows.

| What it finds                                           | Action                                                                                                                                                                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A valid `exit.json` whose nonce matches                 | Ingests it once and verifies the result, even if the old supervisor died before recording it, and also when the receipt lands while recovery is inspecting the attempt's processes                                  |
| An exited or verifying attempt                          | Stops any check command the old supervisor left running, then verifies again from the start                                                                                                                         |
| A check record that cannot be read                      | Marks it `uncertain`, because the check may be running and cannot be found                                                                                                                                          |
| An integration that started but recorded no result      | Stops its checks, removes its workspace, and records it as `error`. This happens on every recovery and every `cancel`, even past the deadline. Only then does the runner decide whether a new integration may start |
| An attempt still in `prepared` (no process was started) | Ends it as interrupted with no effects. The task is ready again, and this does not count as an attempt                                                                                                              |
| A live attempt host (PID and start time match)          | Asks it to stop, then waits for its exit receipt. The provider and its group stop first. A provider that had already exited on its own keeps the result it exited with                                              |
| A dead host with a live provider (identity verified)    | Stops the provider's process group                                                                                                                                                                                  |
| No launch receipt (the host never ran)                  | Ends it as interrupted with no effects. A late host sees the new generation and exits                                                                                                                               |
| A host that stopped before it recorded its provider     | Marks it `uncertain`, because the provider may be running and cannot be found                                                                                                                                       |
| A dead provider whose process group still has members   | Marks it `uncertain`, because the members cannot be verified                                                                                                                                                        |
| An unreadable or truncated receipt                      | Marks it `uncertain`, because a partial receipt is never trusted                                                                                                                                                    |
| A PID now used by another process                       | Never signalled or adopted                                                                                                                                                                                          |

After processes are stopped, the runner handles the remaining attempts as follows.

- An interrupted **read-only** attempt is a transient failure and retries within its policy.
- An interrupted **editing** attempt becomes `recovery_required`. Its session is quarantined, so no other task can resume it. Ready tasks that share that session wait. They do not keep the supervisor running, and the run ends `recovery_required`.
- Accepted results are never rerun.

## Deciding `recovery_required` tasks

Inspect the attempt first, using the sources below.

- `status --json` shows the task's `stateVersion` and latest attempt.
- The attempt's directory holds the receipts and logs.
- The attempt's workspace (`workspaces/<task>/<attempt>/`) holds whatever it changed.
- External effects are anything the task's tools could reach beyond its workspace.

Then write a decision file like the one below and pass it to `recover`. Its shape is in `../schemas/decision.schema.json`. A file that does not match it is refused as a whole, before the run is touched.

```json
{
  "version": 1,
  "decisions": [
    {
      "taskId": "ui",
      "attemptId": "a-3f9c1e2d4b",
      "stateVersion": 7,
      "evidence": "Compared the workspace with its input. Two files were half-edited and the transcript shows no external calls. Discarding the partial edit.",
      "action": "retry-after-reconciliation"
    }
  ]
}
```

```bash
orchestrator recover <run-dir> --decision decision.json
```

| Action                       | Effect                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `retry-after-reconciliation` | Saves the partial change as a `partial-patch` artifact, releases the session, and makes the task ready. A worktree task starts its next attempt from the task's prepared input, not from the partial edit. An in-place task runs again in the input root as you left it, and its patch still covers every change since its first attempt |
| `fail-preserving-artifacts`  | Saves the partial change and fails the task. Dependents are skipped                                                                                                                                                                                                                                                                      |

The partial change is written to its own file, `artifacts/<task>/<attempt>.partial.patch`. A patch that the attempt had already recorded stays as it was.

A decision is rejected, and the rejection is recorded, in any of the cases below.

- The task is not `recovery_required`.
- The `stateVersion` is stale.
- The attempt is not the task's latest.
- The `evidence` is too short to describe what was checked.
- Any recorded process of that attempt (host, provider, provider group, or check command) is still alive.

No decision can mark a task as succeeded. If a task's result is actually fine, add a new task that verifies it.

## Blocked tasks

A blocked worker keeps its session and workspace. `continue --task <id> --prompt-file <file>` adds an attempt marked `continuation`. That attempt saves the new prompt, resumes the session in the same directory with the same profile, and keeps every earlier prompt and log. A continuation that is interrupted before its provider starts runs again as the same continuation, with the same prompt. The task's patch covers all of its attempts, relative to its prepared input. A blocked `in-place` task keeps the input root, so other `in-place` tasks wait until it is continued or cancelled. A read-only continuation whose input changed while it was blocked does not start. The task returns to `blocked` with that reason and keeps the baseline of its first attempt. A dependency conflict also shows as blocked. Continuing it without changing anything fails the same way, so fix the conflict with a new task or a different integration order.

## Cancellation

- `cancel <run-dir> --task <id>` stops one task. Without `--task` it stops the whole run.
- With a live supervisor, the request is queued, and `cancel` returns once that supervisor has applied it on its next pass. Without one, `cancel` reconciles the run itself and applies the request. That includes a supervisor that crashed and still holds its lease. `cancel` then waits until the lease ends, which takes up to 30 s. `continue` delivers its request the same way.
- Cancellation writes `cancel.json`, sends SIGTERM to the verified host, waits for the grace period, and then sends SIGKILL to the provider's group. A task is reported `cancelled` only after the host has confirmed that the provider stopped.
- A task whose worker has exited but is still being verified is cancelled too. The request is recorded in the attempt's `cancel.json`, its running check is stopped, and a check that passes afterwards cannot turn the attempt into a success.
- Pending, ready, and blocked tasks are cancelled directly. `recovery_required` tasks are left alone, because their processes are unproven.
- The first Ctrl-C on `run` cancels the run. A workflow run behaves the same way. The first Ctrl-C stops its running workers, their turns fail, and the calling script can resume the run. A second Ctrl-C exits at once, and the hosts then stop their workers once the lease has expired and the grace period has passed.
- When the run deadline passes, active attempts stop (`budget` failures), including attempts in verification, and no new work starts. The deadline is enforced again after recovery.
- Integration is supervised the same way. Cancelling the run, or reaching its deadline, stops the running integration check and records the integration as `failed` with the reason. A cancelled integration leaves the run `cancelled`, and neither case can end in success. The stop is judged in the same transaction that records the integration result, so a stop that arrives during the final step still wins. Integration does not start once the run is cancelled or past its deadline.

## Cleanup

`cleanup <run-dir> [--task <id>] [--discard-ignored]` removes worker worktrees, and without `--task` also integration worktrees. It removes a worktree only when all of the conditions below hold.

- No supervisor holds the lease.
- Every task that used the worktree is terminal (or blocked, and this is not its latest workspace).
- No recorded process is alive, including check commands.
- The worktree's tracked and untracked contents are preserved. For an editing task, the latest patch or partial patch must exist, match its recorded hash, and contain exactly the worktree's current tree, so edits made after the worker finished keep it in place. For a read-only task, the worktree must still match the input it started from. For an integration, its combined patch must exist, match its hash, and equal the worktree's tree. An integration that recorded no combined patch (a conflict or an error) keeps its worktree.
- The worktree holds no gitignored files. Snapshots and patches never contain them, so a worktree with any is kept and the files are listed. `--discard-ignored` removes such worktrees anyway, so pass it only after someone has looked at the list.

A disposable check checkout (`<attempt>-checks`) left behind by a crash holds nothing to preserve, so cleanup removes it once no check process of that attempt is alive.

Cleanup prints what remains in the repository, namely this run's worktrees and its `refs/orchestrator/<run-id>/*` refs, along with a command that deletes the refs. Run folders, artifacts, logs, and refs stay. Delete those separately, and only when the user asks.

## Workflow runs

A script built on the workflow library resumes a run with `openWorkflow({ runDir, resume: true })`, which behaves as described below.

- `checkpoint()` stores the script's own state together with the turns it consumed, so the script restores its position from the last checkpoint.
- A turn that finished but was not checkpointed is replayed from its record, so no provider runs again only to rebuild a result.
- A turn that ended uncertain (its process could not be proven stopped) quarantines its session. `runTurn` refuses to rerun that step until the caller passes `acceptUncertain` and every recorded process of the turn is verifiably gone. A rerun moves the earlier attempt's files to the attempt's `superseded/` directory and never reads a final message left by an earlier attempt.
- Whether an interrupted turn left partial edits that need a person's decision is the calling script's question. The library only reports that the turn was uncertain.
- A directory without `state.sqlite` cannot be resumed.
