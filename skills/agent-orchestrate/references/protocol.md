# Runner protocol

This document describes the supported contracts of the local runner, which are the manifest, provider profiles, workspaces, results, states, the run directory, adapters, and the workflow library for scripts that drive their own turn loop. JSON Schemas are in `../schemas/`.

The runner runs on macOS and Linux and needs Node 24.15 or later. Its run state lives in `node:sqlite`, which is experimental in earlier releases and prints a warning there with every command. `doctor`, `run`, and the workflow library report an older runtime or another platform as a problem. The runner has no npm dependencies, so nothing needs to be installed.

The runner does not assume a version of any provider CLI. `doctor` and every run dry-run the exact arguments against the executable that is installed, so a CLI that no longer accepts a flag is reported before any worker starts. cursor-agent updates itself in the background, so its version can change between runs. Each attempt records the version that preflight resolved.

## Manifest (version 1)

Paths resolve relative to the manifest file. Prompt and result-schema files must be inside the manifest directory. The runner rejects unknown fields, duplicate task ids, unknown or self dependencies, cycles, invalid limits, capabilities an adapter lacks, and permission settings it cannot enforce. All of this happens before anything runs.

| Field                | Meaning                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`            | `1`                                                                                                                                         |
| `label`              | Name used in the run id                                                                                                                     |
| `input.root`         | The repository or directory the work starts from. A git input must be the top level of its work tree                                        |
| `input.revision`     | Commit to start from (default `HEAD`), resolved once                                                                                        |
| `input.snapshot`     | `revision` (the commit only), `working-tree` (the commit plus uncommitted and untracked, non-ignored files), or `none` (the live directory) |
| `limits`             | See below                                                                                                                                   |
| `profiles.<name>`    | A provider profile (see below)                                                                                                              |
| `tasks[]`            | Tasks in a stable order. Ready tasks start in this order                                                                                    |
| `integration.order`  | Order for composing code artifacts (defaults to dependency order, then manifest order)                                                      |
| `integration.checks` | Commands run against the combined result                                                                                                    |
| `checkSandbox`       | `{ "mode": "os" \| "none", "writableRoots": [abs paths] }` confines verify and integration checks (default `os`, see below)                 |

`working-tree` snapshots are taken with a temporary index. The user's index, staging area, and branches never change. Snapshot commits are pinned under `refs/orchestrator/<run-id>/`.

### Limits

| Limit                 | Default    | Meaning                                                                                                                            |
| --------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `concurrency`         | 2          | Active attempts at once                                                                                                            |
| `attemptDeadlineMs`   | 30 minutes | Per attempt. A task's `deadlineMs` overrides it                                                                                    |
| `checkDeadlineMs`     | 10 minutes | Per verification command. A check's `timeoutMs` overrides it                                                                       |
| `runDeadlineMs`       | 4 hours    | Absolute, and stored so it survives recovery                                                                                       |
| `terminateGraceMs`    | 10 s       | Between SIGTERM and SIGKILL                                                                                                        |
| `maxStdoutBytes`      | 64 MiB     | Exceeding it ends the attempt as a resource failure. At most 256 MiB, the largest output the result parser reads                   |
| `maxStderrBytes`      | 8 MiB      | Likewise                                                                                                                           |
| `maxRecordBytes`      | 16 MiB     | Largest single JSON line parsed from a provider                                                                                    |
| `maxCheckOutputBytes` | 4 MiB      | Stored check output                                                                                                                |
| `maxArtifactBytes`    | 256 MiB    | Largest patch                                                                                                                      |
| `spendThresholdUsd`   | none       | Stops new dispatch once reported spend reaches it. It is not a hard cap (running work continues and unknown costs are not counted) |

Silence is not failure. The runner tracks the last activity for diagnostics and never stops a worker only because it is quiet.

### Tasks

| Field          | Meaning                                                                                                                                                                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | `^[a-z0-9][a-z0-9._-]{0,63}$`                                                                                                                                                                                                            |
| `prompt`       | A file path, or `{ "text": "…" }`                                                                                                                                                                                                        |
| `profile`      | Profile name                                                                                                                                                                                                                             |
| `dependsOn`    | Task ids. The task starts only after every dependency succeeded                                                                                                                                                                          |
| `workspace`    | `worktree` (default), `shared-readonly`, `in-place`                                                                                                                                                                                      |
| `session`      | Name of a provider session shared by several tasks in order (requires a stable directory, meaning `in-place`, or `shared-readonly` without code dependencies)                                                                            |
| `resultSchema` | A custom JSON Schema. The default is the generic worker result                                                                                                                                                                           |
| `scope`        | Globs (`*`, `**`, `?`, trailing `/`) of paths the task may change. Violations fail verification                                                                                                                                          |
| `verify`       | `[{ "name", "argv", "timeoutMs"? }]`, run in the worker's workspace against the captured artifact as argument arrays with no shell. A check that changes the workspace (a formatter with `--write`, a snapshot update) fails the attempt |
| `requires`     | Capabilities the task needs (default `[]`)                                                                                                                                                                                               |
| `deadlineMs`   | Attempt deadline                                                                                                                                                                                                                         |
| `retry`        | `{ "maxAttempts", "on": ["transient"\|"protocol"\|"verification"\|"budget"], "backoffMs", "safeToRepeat" }`                                                                                                                              |

By default, editing tasks get 1 attempt and `shared-readonly` tasks get 2, on `transient` only. More than one attempt for an editing task needs `safeToRepeat: true`, which declares that repeating its tool use has no unsafe external effect. The runner never retries `launch`, `auth`, `cancellation`, `uncertain`, or `conflict` failures. Attempts that fail before any provider starts (for example an unwritable workspace) are retried with backoff, at most three in total.

### Check sandbox

`verify` and integration checks run tests, package scripts, and modules that a worker may have written, so the runner starts each one inside an OS sandbox.

- On macOS it is `sandbox-exec` with a profile that denies every file write except under `/dev`, the check's working directory, the temporary directories (`$TMPDIR`, its per-user parent under `/var/folders`, and `/private/tmp`), and `writableRoots`. The profile also denies Apple Events, `lsopen`, the LaunchServices services, and running `launchctl`, `open`, or `osascript`, which are the usual ways to have a process started outside the sandbox.
- On Linux it is `bwrap` with the root bound read-only and the same directories bound writable. `/run/user/<uid>` and the D-Bus directories are replaced by empty tmpfs mounts and the D-Bus address variables are unset, so a check cannot ask the user bus or the systemd user manager to start a host process.
- Reads and network access are not restricted, and the sandbox is not a boundary against code that sets out to escape through other services.
- Configured `writableRoots` that do not exist are created before a check starts.

`doctor` and `run` start the sandbox once and confirm that it refuses a write outside its roots, so a run never falls back to unconfined checks. A sandbox cannot start inside another sandbox. In that case, and only when the whole run already executes inside an external sandbox, set `"mode": "none"`, which `run.md` then reports.

Git filter drivers run on worker-written files whenever the runner snapshots a worktree (`git read-tree`, `git add`, and `git write-tree` with a private index) or composes one (`git apply` and `git reset` while preparing a dependent or an integration). When the sandbox mode is `os` and the repository configures any `filter.*.clean` or `filter.*.process` driver, those commands run in the sandbox. They may then write only to the private index, `<git-common-dir>/objects`, `<git-common-dir>/lfs` (created beforehand, so a first LFS use works under bwrap), and, when composing, the worktree's files and its private git directory. Unlike checks, they do not get the temporary directories, so a repository that lives under `$TMPDIR` still has its shared git directory and configuration protected. `doctor` probes the sandbox for such a repository even when the manifest has no checks.

Every git command the runner starts passes `-c core.hooksPath=/dev/null -c core.fsmonitor=false`, so neither hooks nor a configured fsmonitor command run.

Mixing `in-place` and `worktree` tasks in one run is rejected, and so is an `integration` block in a run with `in-place` tasks (there is no snapshot to compose on). A `shared-readonly` Claude profile may not auto-approve unrestricted `Bash`, and on a live root (`snapshot: "none"`) it may not auto-approve any `Bash(...)` rule. The input fingerprint check still runs after every read-only attempt. A `cursor-cli` profile cannot run a `shared-readonly` task at all, because cursor-agent has no mode that prevents writes.

A Claude profile in which a write tool is available and approved (by `acceptEdits` or any allow rule for a write tool, including a scoped one such as `Edit(src/**)`, which Claude applies to every file-editing tool) and which also auto-approves a `Bash` rule is rejected unless it sets `bashSandbox` or `externalSandbox`. Such a worker could edit a script and run it, which is the power of `bypassPermissions`.

A Claude profile whose `allowedTools` names a write tool without a path (`Edit`, `Write`, `MultiEdit`, or `NotebookEdit`) is rejected unless it sets `externalSandbox`. Such a rule approves writes anywhere on disk, and the runner records and scope-checks only what changes inside the workspace. `acceptEdits` approves edits inside the working directory and denies the rest, so no such rule is needed. A rule with a path, such as `Edit(src/**)`, is accepted.

A git `input.root` must be the top level of its work tree. Snapshots, worktrees, and the change audit all cover the whole work tree, so an input below the top level would hide every change outside that directory. Name a subdirectory in the prompts and scopes instead. `in-place` tasks also need at least one commit, because their change audit is a git diff and `scope` could not be enforced without it. The runner checks both in `doctor` and before it creates the run directory.

An `in-place` task holds the input root from its first launch until it reaches a terminal state. Its patch covers every change in the root since its first attempt started, whichever attempt made it, so no other `in-place` task may edit the root in between. The other `in-place` tasks stay `ready` meanwhile, also while the holder is blocked or needs recovery, and the run then ends `blocked` or `recovery_required` until someone continues, decides, or cancels the holder.

## Profiles

Every adapter reapplies the whole profile on every invocation, including the first one, retries, and continuations. The resolved executable, its version, and the exact argument array are stored with each attempt. The stored arguments contain no secrets.

### `claude-cli`

| Field                                  | Flag                                                                                            |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `model`, `effort`                      | `--model`, `--effort`                                                                           |
| `permissionMode` (required)            | `--permission-mode`                                                                             |
| `permissionPrompts` (required, `none`) | `--permission-prompts none`                                                                     |
| `tools`                                | `--tools a,b,c` (available tools)                                                               |
| `allowedTools`, `disallowedTools`      | `--allowedTools …`, `--disallowedTools …`                                                       |
| `maxBudgetUsd`                         | `--max-budget-usd` (enforced by Claude)                                                         |
| `bashSandbox`                          | `--settings` with `sandbox.enabled`, `failIfUnavailable`, and `allowUnsandboxedCommands: false` |
| `settingSources`                       | `--setting-sources`                                                                             |
| `strictMcpConfig`, `mcpConfig`         | `--strict-mcp-config`, `--mcp-config`                                                           |
| `addDirs`                              | `--add-dir`                                                                                     |
| `outputFormat`                         | `stream-json` (default, with `--verbose`) or `json`                                             |
| `executable`                           | Argument array, resolved automatically when absent                                              |

With `bashSandbox`, Claude Code runs every Bash command in its own sandbox, which allows writes only in the working directory. The session exits at startup when the sandbox cannot start, and a command that fails in the sandbox is never retried outside it. Settings from other sources still merge in, so an `excludedCommands` entry in the user's settings runs outside the sandbox. Set `settingSources` to exclude those files when that matters.

The structured result is read from `structured_output` in the final `result` record. An exact JSON `result` text is accepted when that field is absent. Nothing is repaired, so fenced or partial JSON fails. The init record's model, permission mode, tool list, and MCP server states are stored as diagnostics.

### `codex-cli`

| Field             | Fresh invocation                          | Resumed invocation (`exec resume <id>`)         |
| ----------------- | ----------------------------------------- | ----------------------------------------------- |
| `model`, `effort` | `-m`, `-c model_reasoning_effort="…"`     | same                                            |
| `sandbox`         | `-s <mode>`                               | `-c sandbox_mode="<mode>"`                      |
| working directory | `-C <dir>` and the spawn directory        | the spawn directory                             |
| `addDirs`         | `--add-dir`                               | `-c sandbox_workspace_write.writable_roots=[…]` |
| `config`          | `-c key=value`                            | same                                            |
| result            | `--json --output-schema <copy> -o <file>` | same                                            |

Success requires a `turn.completed` event, no `turn.failed` or `error` event, a zero exit, and a final message that parses and validates. Codex has no enforced spending limit in this interface, so usage is reported but not capped.

### `cursor-cli`

| Field                | Flag                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| `model` (required)   | `--model`. Use an id from `cursor-agent models`. Effort is part of the id, so there is no `effort` field |
| `sandbox` (required) | `--sandbox enabled` or `--sandbox disabled`                                                              |
| `force`              | `--force`                                                                                                |
| `addDirs`            | `--add-dir`                                                                                              |
| working directory    | `--workspace <dir>` and the spawn directory                                                              |
| every invocation     | `-p --output-format stream-json --trust`                                                                 |
| resumed invocation   | `--resume <chat id>` plus every flag above                                                               |
| `executable`         | Argument array, resolved automatically when absent                                                       |

The worker's directory is passed as `--workspace` on every invocation, including resumes, because Cursor's sandbox makes that directory writable and cursor-agent stores chats per workspace. `--trust` accepts the new worktree without a workspace trust prompt. The runner never passes `--approve-mcps`, `--mode`, or `--stream-partial-output`.

cursor-agent has no flag that takes a result schema, so the adapter does not claim `structured-output`. The runner appends the schema and a result instruction to the prompt, and `prompt.md` records that text. The payload is the last `assistant` message. It must come after the last tool call and parse as exact JSON, and then it is validated like any other result. The `result` field of the final `result` record is not used, because it joins every assistant message of the turn. Success also needs a `result` record with subtype `success` and a zero exit. A failed run exits non-zero without a `result` record and explains itself on stderr, so the adapter classifies the failure from stderr (an unusable model is a `launch` failure). Usage is the token counts from the `result` record, and cost is not reported. Tool calls that cursor-agent rejected are listed as permission denials.

The safety policy rests on the cursor-agent behavior below. cursor-agent changes between releases, so check these points again before trusting a new release with untrusted work. The provider smoke tests ask a worker of every adapter to write outside its workspace and require that nothing appears there.

- With `--sandbox enabled` and no `--force`, shell commands run in an OS sandbox in which only the workspace is writable and network access is off. A shell write outside the workspace fails, and a file edit outside the workspace is rejected. Edits inside the workspace are applied without a prompt.
- With `--force`, a shell command and a file edit can both write outside the workspace even when `--sandbox enabled` is set. The runner therefore accepts `force` only with `externalSandbox: true`, and it requires the same for `"sandbox": "disabled"`.
- Without `--force` and without the sandbox, a shell command that is not on the user's allowlist is rejected rather than left waiting for approval. The allowlist in `~/.cursor/cli-config.json` and in the project's `.cursor/cli.json` still applies, and the runner cannot see it.
- With `--force`, `--mode plan` rejects edits to non-Markdown files but still runs a shell command that writes a file, and `--mode ask` still applies a file edit. Neither mode is a read-only boundary, which is why `shared-readonly` is rejected for this adapter.

### Executable resolution

The runner tries these sources in order.

1. The profile's `executable`.
2. `CLAUDE_CMD`, `CODEX_CMD`, or `CURSOR_AGENT_CMD`, split on whitespace.
3. The first working `claude`, `codex`, or `cursor-agent` on `PATH`. A broken shim is skipped.
4. For claude and codex only, `pnpm dlx <package>@<version>`, pinned to the version found during preflight.

cursor-agent is not an npm package, so it has no `pnpm dlx` fallback and comes from Cursor's installer (`curl https://cursor.com/install -fsS | bash`). Nothing is resolved or installed during dispatch.

## Results

The generic result (`schemas/worker-result.schema.json`) has the fields `taskId`, `attemptId`, `status` (`done`/`blocked`), `summary`, `blocker` (`{reason, needs}` or null), `files`, and `checks`. The ids must match the ones the runner put in the prompt.

An attempt is accepted only when all of the conditions below hold.

- The exact recorded provider process exited 0 after a normal run.
- The provider reported a successful terminal outcome.
- The payload validates and names the right task and attempt.
- The `status` is `done`. A `blocked` status goes to the blocker path.
- The artifact was captured, the scope holds, and every `verify` command passed against that artifact without changing it.
- For a `shared-readonly` task, the input still matches its starting fingerprint after the worker and again after the checks.
- No ownership, cancellation, or input-mutation question remains.

A read-only fingerprint covers the git tree of tracked and untracked files and, separately, the names, sizes, and modification times of ignored files. A read-only attempt that changed its input fails with class `verification` whatever else happened, so it is not retried on top of the change. That includes a provider failure and an interrupted attempt found by recovery. Each shared checkout (`workspaces/_input`, then `_input-2`, and so on) records its fingerprint in `<dir>.fingerprint` when it is created. A checkout that no longer matches is left in place for inspection, and the next reader gets a new one. The `verify` checks of a task on a shared checkout run in a disposable worktree of the same commit (`workspaces/<task>/<attempt>-checks`), which is removed afterwards. On a live root they run in the root, and the fingerprint is compared again afterwards. A continuation of a read-only task must find its input unchanged since its first attempt started. When it has changed, the continuation does not start, and the task returns to `blocked` with that reason and keeps its original baseline.

Patches are written with every formatting option pinned (`a/` and `b/` prefixes, no textconv, no external diff, no relative paths, submodules included), so user or repository git configuration cannot change them. Before a patch is accepted, the runner applies it to its base in a private index and requires exactly the captured tree.

For an `in-place` task, the runner also lists the untracked ignored files in the root before the first attempt (`ignored-before.txt` in the attempt directory) and after the worker. New ignored files are recorded as `ignoredAdded` on the patch artifact and scope-checked, although no patch contains them. Changes to ignored files that already existed are not detected.

A custom `resultSchema` replaces the generic envelope, and the owning workflow then interprets the payload.

## States

The table lists each task state and the states it can move to next.

| State                                         | Next                                                                                                 |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `pending`                                     | `ready` when every dependency succeeded, or `skipped` when one failed, was cancelled, or was skipped |
| `ready`                                       | `running` (capacity, session, and root exclusivity permitting) or `cancelled`                        |
| `running`                                     | `verifying`, `ready` (a safe retry), `blocked`, `failed`, `cancelled`, or `recovery_required`        |
| `verifying`                                   | `succeeded`, `ready`, `blocked`, `failed`, `cancelled`, or `recovery_required`                       |
| `blocked`                                     | `ready` through `continue`, or `cancelled`                                                           |
| `recovery_required`                           | `ready` or `failed` through a recovery decision, or `cancelled`                                      |
| `succeeded`, `failed`, `cancelled`, `skipped` | None, because these states are terminal                                                              |

Attempt phases are `prepared` → `launching` → `running` → `exited` → `verifying` → `finished`. Attempt outcomes are `succeeded`, `failed`, `blocked`, `cancelled`, `interrupted` (stopped with no effect, or a read-only attempt), and `uncertain`.

Failure classes are `launch`, `auth`, `transient`, `protocol`, `verification`, `budget` (also deadlines and output limits), `cancellation`, `uncertain`, and `conflict`.

The database enforces at most one active attempt per task and per session (partial unique indexes).

The run outcome determines the CLI exit code. `succeeded` exits with 0, `failed` with 1 (a failed or skipped task, or a failed integration), `blocked` with 2, `recovery_required` with 3, `cancelled` with 4, and `stopped` with 5 (run deadline or spend threshold). A run that is still running exits with 6. Two codes are not run outcomes. A usage or configuration error exits with 64 and changes nothing, and a failure inside the runner exits with 70.

## Run directory

Each run gets its own directory under `~/.orchestrator`. Set `ORCHESTRATOR_HOME` or pass `--runs-root` to use another root, which must lie outside `input.root`.

```text
~/.orchestrator/<stamp>-<label>-<id>/
  manifest.json                       Normalized manifest with inlined prompts and schemas, and its hash
  state.sqlite                        Source of truth in WAL mode, never edited by hand
  run.md                              Generated report, rebuilt by the report command
  tasks/<task>/attempts/<attempt>/
    prompt.md                         Prompt the worker received
    result.schema.json                Schema the result must match
    profile.json                      Resolved worker profile
    host-config.json                  Configuration the attempt host starts from
    launch.json                       Host process identity, written when the host starts
    provider.json                     Provider process identity, written when the provider starts
    heartbeat.json                    Latest host heartbeat
    events.jsonl                      Normalized provider events
    stdout.jsonl                      Raw provider stdout
    stderr.log                        Raw provider stderr
    final-message.json                Final message (codex only)
    provider-result.json              Parsed provider result
    exit.json                         Exit receipt written by the host
    cancel.json                       Stop request, present only after a cancel or deadline
  artifacts/
    <task>/<attempt>.patch            Immutable binary patch of the attempt's own change
    <task>/<attempt>.partial.patch    Workspace contents when a recovery decision was applied
    integration-N.patch               Combined change of integration N
  checks/
    <task>/<attempt>/<name>.log       Output of one task check
    integration/<name>.log            Output of one integration check
  workspaces/
    <task>/<attempt>/                 Detached git worktree of one attempt
    _input[-N]/                       Shared read-only checkouts (_input, _input-2, ...)
    _input[-N].fingerprint            Fingerprint each shared checkout started with
    _integration-N/                   Worktree of integration N
```

Each patch holds only the task's own change relative to its prepared input. Changes inherited from dependencies are not exported again. Before launch, a dependent's input is the base snapshot plus its accepted transitive dependency patches. They are applied in the integration order after their hashes are verified, and committed so that the worker sees a clean `git status`. When patches conflict, the task is blocked before any worker starts.

## Events

`events` rows carry `seq`, `at`, `type`, `task_id`, `attempt_id`, and `data`. The event types are `run.created`, `lease.acquired`, `lease.released`, `task.created`, `task.transition`, `dispatch.decision` (selected and deferred tasks with reasons), `attempt.prepared`, `attempt.launching`, `attempt.provider_started`, `attempt.exited`, `attempt.finished`, `session.recorded`, `session.quarantined`, `session.released`, `check.finished`, `control.resolved`, `recovery.action`, `recovery.decision_rejected`, `integration.started`, `integration.finished`, `run.deadline`, `run.spend_threshold`, and `run.outcome`. A workflow run also records `recovery.accepted` when its script accepts the rerun of an uncertain turn. Provider progress stays in each attempt's `events.jsonl`.

## Adapter contract

An adapter module (`scripts/lib/adapters/`) exports `name`, `adapterVersion`, `binary`, `package` (null when the CLI is not an npm package), `envVar`, `versionArgs`, `capabilities`, an optional `installHint` for the resolution error, and the functions below.

- `probe(profile, {cwd, env, schemaFile, lastMessageFile})` checks that the executable accepts the profile's full fresh and resume arguments, by dry-running them with empty stdin. It never invokes a model.
- `resultInstructions(schemaText)` is optional. An adapter whose CLI cannot take the result schema returns text that the runner appends to the prompt before it records and hashes `prompt.md`.
- `buildInvocation(attempt)` returns `{argv, cwd, stdinFile, env}`, an argument array, never a shell string.
- `parseEvent(record)` turns one complete JSON line into normalized `session`, `init`, `progress`, `usage`, and `terminal` events.
- `parseResult({stdoutFile, stderrFile, lastMessageFile})` returns `{providerOutcome: success|failure|missing, failureClass?, message?, payload, sessionId, usage, costUsd, numTurns, permissionDenials, diagnostics}` and never guesses success.

The capabilities are `resume` (all adapters), `streaming-events` (all adapters), `structured-output` (claude and codex, whose CLIs constrain the final message to the schema), `enforced-cost-limit` (claude only), `sandbox` (codex only), `tool-policy` (claude only), and `active-turn-steering` (no adapter). The runner validates every result against its schema whichever adapter produced it, so a task lists `structured-output` only when it needs the CLI itself to enforce the schema. A new backend adds a module and registers it in `adapters/index.mjs`. It also needs contract tests in the style of `tests/attempt.test.mjs`. Scheduling and persistence do not change.

The attempt host (`scripts/attempt-host.mjs`) owns process creation, deadlines, output caps, signals, and receipts for every adapter. It starts the provider in its own process group. A process group cannot hold a descendant that deliberately detaches itself, so a group is not a security sandbox. A workload that needs containment needs an external sandbox or container.

## Workflow library

A script that runs its own sequence of provider turns, instead of a manifest, imports `scripts/lib/index.mjs` and uses it as shown below.

```js
const runner = await import(pathToFileURL(RUNNER).href);
const profiles = await runner.preflightWorkflowProfiles({ codex: {...}, claude: {...} });
const workflow = await runner.openWorkflow({ runDir, kind: 'my-loop', label, resume });
const result = await workflow.runTurn({ step, session, sessionDisplayName, profile, promptText, schemaFile, files, cwd, isGitRepo, addDirs, readOnly, acceptUncertain });

workflow.checkpoint({ state, position }, [result.taskId]);
workflow.finish(outcome);
workflow.close();
```

Each `runTurn` call is a task with a stable step key and one supervised attempt. Provider sessions are named by the caller and resumed automatically. If a turn finished but no checkpoint has consumed it, `runTurn` returns the recorded result (`replayed: true`) instead of invoking the provider. A checkpoint and the ids of the turn results it consumed are written in one transaction. The library never interprets a turn's payload, and transport success is not approval.

Workflow turns default to a 90-minute deadline (`ORCHESTRATOR_TURN_DEADLINE_MS`) and a 256 MiB stdout cap. A workflow run keeps its execution record in `execution.md`, so the calling script can own `run.md`.

The library does not check a profile's permissions the way a manifest does, and it runs no `verify` commands. The calling script owns its profiles, including `bashSandbox` for a Claude profile that edits files and auto-approves Bash, and it owns any commands it runs itself.

The calling script also owns its run. `status`, `watch`, and `report` read a workflow run, but `recover`, `continue`, `cancel`, and `cleanup` refuse one, because only the script that created it knows how to resume or stop it.
