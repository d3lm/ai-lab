---
name: agent-orchestrate
description: Coordinate several Claude Code, Codex CLI, and Cursor CLI (cursor-agent) workers in parallel from the shell, each as a non-interactive process with JSON output, with follow-ups via session resume, progress reads, dependency tracking, and structured results. Use when the user asks to delegate, parallelize, fan out, or split up coding work across claude, codex, or cursor agents, hand work between them, or monitor workers, including "spawn a claude for each of these", "run these through codex in parallel", "give this one to cursor-agent", "what are my workers doing".
argument-hint: the work to split up and which runner (claude, codex, cursor, or mixed)
allowed-tools: Bash(node:*), Bash(cat:*), Bash(ls:*), Bash(jq:*), Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(git worktree list:*)
disable-model-invocation: true
---

# Agent Orchestration

A local runner owns execution: task state, dependency readiness, process lifecycle, workspaces, verification, and crash recovery. You own the plan: split the work, choose workers, write prompts and acceptance checks, and explain results. Do not start `claude`, `codex`, or `cursor-agent` yourself, do not track tasks in prose, and never edit `state.sqlite`.

```bash
ORCHESTRATOR="<skill-dir>/scripts/orchestrator.mjs"
node "$ORCHESTRATOR" validate manifest.json
```

`<skill-dir>` is the directory that holds this file. Write its absolute path into the variable. Always call the runner as `node "$ORCHESTRATOR" …`. A variable holding `node <path>` breaks in zsh, which does not split it into words. The runner needs Node 24.15 or later and nothing else.

## Choose the tool

- **Native subagents** for ordinary delegation inside one host (Claude Code's Agent tool, Codex subagents). No runner needed.
- **This runner** when the work mixes Claude, Codex, and Cursor, when tasks hand code to each other, or when the run needs enforced concurrency, deadlines, verification, or recovery.
- **A dedicated skill** when one exists for the specific loop the user wants. Such skills may be built on this runner's workflow library, and they keep their own instructions.

## Defaults

Keep these unless the user asks otherwise. Never substitute a different model after a failure.

| Profile | Settings                                                                                                                                              |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| claude  | `"model": "claude-fable-5-1", "effort": "high", "permissionMode": "acceptEdits", "permissionPrompts": "none", "bashSandbox": true`, scoped tool lists |
| codex   | `"model": "gpt-6-astra", "effort": "xhigh", "sandbox": "workspace-write"` (`"read-only"` for analysis)                                                |
| cursor  | `"model": "claude-opus-5-5-high", "sandbox": "enabled"` (Opus 5.5 High, 1M context; ids come from `cursor-agent models`)                              |

Tool policy has four parts. Keep them separate:

- `tools` (`--tools`) is the set of tools that exist in the session.
- `allowedTools` and `disallowedTools` are permission rules that approve or deny calls automatically. `allowedTools` alone is not an exclusive boundary.
- `acceptEdits` approves file edits inside the working directory, so `allowedTools` needs no `Edit` or `Write` entry. An entry without a path, such as `"Write"`, approves writes anywhere on disk. The runner rejects it. Give a rule a path when you need one, for example `Edit(src/**)`.
- With `permissionPrompts: "none"`, anything that would prompt is denied, so the run never waits for a person.

A worktree isolates the checkout. It is not a sandbox. The runner rejects `bypassPermissions`, `danger-full-access`, and a Cursor profile with `force` or `"sandbox": "disabled"` unless the profile sets `externalSandbox: true`, and that flag is only for a run that really executes inside a separately configured container or sandbox. Ask the user before you use it.

Anything that runs repository code runs code a worker may have written. The runner contains it in three ways:

- A Claude profile that can edit files (through `acceptEdits` or any `Edit`/`Write` rule, scoped ones included) and also auto-approves any `Bash(...)` rule must set `"bashSandbox": true`. Otherwise the worker could edit a script and then run it unprompted. The flag runs Claude's Bash tool in Claude Code's sandbox (writes only in the worktree), refuses to start without it, and disables the unsandboxed retry. Never approve `Bash(git diff:*)`, because `git diff --output=<path>` writes anywhere.
- `verify` and integration checks run in an OS sandbox (`sandbox-exec` on macOS, `bwrap` on Linux). They can write only to their workspace and the temporary directories, and they keep read and network access. When a test suite needs a cache, add it to `"checkSandbox": {"writableRoots": ["/abs/path"]}`. `doctor` fails when the sandbox cannot start, for example inside another sandbox. `"checkSandbox": {"mode": "none"}` is only for runs inside an external sandbox, so ask the user first.
- Git filter drivers (for example Git LFS) run when the runner snapshots or composes a worktree. When the repository configures any, those git commands run in the same sandbox, with write access only to the object store, the LFS store, and the worktree being composed. `doctor` lists the drivers. Your own `git status` or `git diff` in a worktree runs them outside the sandbox, so when there are any, read the patches in `artifacts/` instead.

These sandboxes stop ordinary code from writing outside its workspace. They also close the usual ways to have a system service start a process for it, but they are not a boundary against code that sets out to escape. For untrusted work, run the whole runner in an external sandbox.

Cursor workers differ from the other two in four ways (details in [references/protocol.md](references/protocol.md#cursor-cli)):

- `cursor-agent` cannot take a result schema. The runner puts the schema in the prompt and accepts only an exact JSON final message, so a worker that wraps its result in prose fails with a protocol error.
- It reports tokens but not cost, so its spend is unknown.
- With `"sandbox": "enabled"`, its shell commands run in Cursor's sandbox with only the workspace writable. Network access can be blocked in that sandbox, so do not ask a Cursor worker to install packages.
- It has no read-only mode, so `shared-readonly` is rejected. Give analysis tasks a worktree and read the patch.

## Plan the work

Write a manifest. The full contract is in [references/protocol.md](references/protocol.md). Keep tasks independent and dependency chains shallow. `input.root` is the top level of the repository. To work in a subdirectory, name it in the prompts and scopes.

```json
{
  "version": 1,
  "label": "auth refactor",
  "input": { "root": "/path/to/repo", "snapshot": "working-tree" },
  "limits": { "concurrency": 2 },
  "profiles": {
    "claude": {
      "adapter": "claude-cli",
      "model": "claude-fable-5-1",
      "effort": "high",
      "permissionMode": "acceptEdits",
      "permissionPrompts": "none",
      "bashSandbox": true,
      "tools": ["Read", "Glob", "Grep", "Edit", "Write", "Bash"],
      "allowedTools": ["Read", "Glob", "Grep", "Bash(npm test:*)"],
      "maxBudgetUsd": 5
    },
    "codex": { "adapter": "codex-cli", "model": "gpt-6-astra", "effort": "xhigh", "sandbox": "workspace-write" },
    "cursor": { "adapter": "cursor-cli", "model": "claude-opus-5-5-high", "sandbox": "enabled" }
  },
  "tasks": [
    {
      "id": "api",
      "profile": "codex",
      "prompt": "prompts/api.md",
      "scope": ["src/api/**"],
      "verify": [{ "name": "unit", "argv": ["npm", "test", "--", "api"] }]
    },
    {
      "id": "ui",
      "profile": "claude",
      "prompt": "prompts/ui.md",
      "dependsOn": ["api"],
      "scope": ["src/ui/**"],
      "verify": [{ "name": "unit", "argv": ["npm", "test", "--", "ui"] }]
    },
    {
      "id": "docs",
      "profile": "cursor",
      "prompt": "prompts/docs.md",
      "dependsOn": ["api"],
      "scope": ["docs/**"]
    }
  ],
  "integration": { "checks": [{ "name": "all", "argv": ["npm", "test"] }] }
}
```

Put the manifest, its prompt files, and any result schemas together in one input directory under the runs root, never in `/tmp` or the repository. Use `${ORCHESTRATOR_HOME:-$HOME/.orchestrator}/inputs/<YYYYMMDD-HHMMSS>-<label>/`, created with `mkdir -p`. The runs root must be on a local filesystem, not a network share. Prompt and schema paths cannot leave that directory. Follow-up rounds of the same work reuse it (for example `manifest-r2.json`, `prompts/r2/`), so the inputs of every round stay next to the runs they produced. Each run also keeps its own copy of the manifest with the prompts inlined. Each prompt states:

- the objective and the files the worker may change;
- acceptance criteria;
- what a dependency produced, when that matters (the runner applies the dependency's actual patch to the worker's starting tree);
- a warning not to broaden scope or touch unrelated code.

The runner appends the task and attempt ids and the result protocol itself. Workers report `done` or `blocked`. A worker's claimed files and checks are informational. The runner records the actual patch and runs the `verify` commands itself; it never executes commands from a worker's reply.

There are three workspace modes:

- `worktree` is the default and gives each attempt its own git worktree.
- `shared-readonly` is for analysis with a profile that cannot write. After every outcome, including failures, the runner confirms that the input (tracked, untracked, and ignored files) did not change. When it did, the task fails and later readers get a fresh checkout. The task's `verify` checks run in a disposable checkout of the same commit, so they cannot disturb other readers.
- `in-place` edits `input.root` directly, one task at a time. It needs `"snapshot": "none"` and a git repository with at least one commit, because its changes are captured as a git diff. A task keeps the root from its first launch until it finishes, so while it is blocked or needs recovery the other `in-place` tasks wait. Its patch is every change to the root since that first launch, so ask the user not to edit the root until the task has finished.

A read-only manifest for an analysis task needs no Claude tool-policy work when it uses Codex:

```json
{
  "version": 1,
  "label": "auth review",
  "input": { "root": "/path/to/repo", "snapshot": "working-tree" },
  "profiles": {
    "codex": { "adapter": "codex-cli", "model": "gpt-6-astra", "effort": "xhigh", "sandbox": "read-only" }
  },
  "tasks": [{ "id": "review", "profile": "codex", "workspace": "shared-readonly", "prompt": "prompts/review.md" }]
}
```

## Run

1. `node "$ORCHESTRATOR" validate manifest.json` checks the structure and the dependency graph. It starts nothing.
2. `node "$ORCHESTRATOR" doctor manifest.json` resolves each executable, records its version, dry-runs each profile's exact arguments, and starts the check sandbox once. It invokes no model. Fix every problem before running. Never respond to a permission, authentication, or sandbox problem by enabling a bypass mode.
3. Start `node "$ORCHESTRATOR" run manifest.json` with your host's background process facility (in Claude Code, the Bash tool's `run_in_background`). A bare `&` and a PID file are not supervision. As soon as stderr prints `run dir: …`, give the user that path. `run.md` in it is regenerated from state on every change.

## Monitor and steer

- `node "$ORCHESTRATOR" status <run-dir> --json` gives every task's state, latest attempt, blocker or failure, patch, and integration result. The exit code of `run`, `status`, `continue`, and `recover` is the run outcome. Codes 64 (a usage or configuration error, nothing was changed) and 70 (a failure inside the runner) are not run outcomes.
- `node "$ORCHESTRATOR" watch <run-dir> --after <cursor> --timeout-ms 60000` waits a bounded time for new events and returns a cursor. Prefer it to polling in a loop.
- A worker report is under `tasks/<task>/attempts/<attempt>/`: `prompt.md`, `stdout.jsonl`, `stderr.log`, `provider-result.json`, `exit.json`. Judge failure by the recorded outcome, not by how much stderr there is.
- **Blocked** (`exit 2`): read the blocker. Resolve it yourself or ask the user, then write the answer to a file and run `node "$ORCHESTRATOR" continue <run-dir> --task <id> --prompt-file <file>`. The same session resumes in the same workspace with the same profile. A succeeded task never reopens. Follow-up work goes in a new run whose input already contains the earlier patch. Apply that patch to a branch or commit (with the user's consent), then point `input.revision` at it, or use `"snapshot": "working-tree"` after applying it to the checkout.
- **Cancel**: `node "$ORCHESTRATOR" cancel <run-dir> [--task <id>]`. A task reports `cancelled` only after its processes have stopped.
- **Recovery** after a crash, a reboot, or `recovery_required` (`exit 3`): follow [references/recovery.md](references/recovery.md). `recover` reconciles first and never reruns accepted work. Uncertain edits wait for an explicit decision file.

Retries are automatic only when they are safe: read-only tasks retry transient provider failures once. Editing tasks run once unless the manifest says `"retry": {"safeToRepeat": true}`.

## Report to the user

From `status --json` and `run.md`, report the following:

- outcome and exit code; for each task: state, attempts, cost (unknown cost is not $0);
- for each task, the worker's claim next to the host evidence: patch path and changed files, scope result, `verify` results;
- integration: whether the combined patch applied and passed its checks, or was never combined. A produced patch is not an integrated one;
- blockers, failures, and recovery actions, verbatim;
- reported spend, labelled as reported usage (only Claude's `maxBudgetUsd` is an enforced per-attempt cap).

Read the patches before you call the work done. Nothing is merged into the user's branch. To deliver, show the combined patch (`artifacts/integration-N.patch`) and apply it only if the user asks. A manifest without `integration` produces no combined patch, so deliver each task's patch from `artifacts/<task>/` in dependency order and say that they were never checked together.

Run folders are the record and stay in place. Run `node "$ORCHESTRATOR" cleanup <run-dir>` only when the user asks. It removes finished worktrees (task and integration) after it confirms their patches are preserved. It keeps a worktree that holds gitignored files, because no patch contains them, and lists those files. Pass `--discard-ignored` only after the user has seen them. Cleanup prints the `refs/orchestrator/<run-id>/` refs that remain in the repository and the command that deletes them.
