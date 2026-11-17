import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './process.mjs';

function liveOutcome(tasks, run) {
  if (run.outcome && run.status === 'finished') {
    return run.outcome;
  }

  return tasks.some((task) => !['succeeded', 'failed', 'cancelled', 'skipped'].includes(task.state))
    ? 'in progress'
    : (run.outcome ?? 'in progress');
}

function spend(store) {
  const rows = store.db.prepare('SELECT cost_usd FROM attempts WHERE phase = ?').all('finished');
  const known = rows.filter((row) => row.cost_usd !== null);

  return {
    reportedUsd: Number(known.reduce((total, row) => total + row.cost_usd, 0).toFixed(4)),
    unknownAttempts: rows.length - known.length,
  };
}

export function statusSnapshot(store) {
  const run = store.run();
  const tasks = store.tasks();
  const now = Date.now();

  return {
    runId: run.id,
    label: run.label,
    runDir: run.run_dir,
    status: run.status,
    outcome: liveOutcome(tasks, run),
    lease: {
      live: Boolean(run.owner_token) && run.lease_expires_at > now,
      expiresAt: run.lease_expires_at ? new Date(run.lease_expires_at).toISOString() : null,
      generation: run.owner_generation,
    },
    lastEventSeq: store.lastEventSeq(),
    dispatchStopped: run.dispatch_stopped,
    cancelRequested: Boolean(run.cancel_requested),
    deadlineAt: run.deadline_at ? new Date(run.deadline_at).toISOString() : null,
    spend: spend(store),
    input: run.input
      ? {
          root: run.input.root,
          snapshot: run.input.snapshot,
          commit: run.input.commit,
          dirty: run.input.dirty ?? false,
        }
      : null,
    tasks: tasks.map((task) => {
      const attempts = store.attempts(task.id);
      const latest = attempts.at(-1);
      const patch = latest ? store.artifacts(latest.id).find((item) => item.kind === 'patch') : null;

      return {
        id: task.id,
        state: task.state,
        stateVersion: task.state_version,
        dependsOn: store.dependencies(task.id),
        attempts: attempts.length,
        blocker: task.blocker,
        failure: task.failure_class ? { class: task.failure_class, message: task.failure_message } : null,
        latestAttempt: latest
          ? {
              id: latest.id,
              kind: latest.kind,
              phase: latest.phase,
              outcome: latest.outcome,
              failureClass: latest.failure_class,
              message: latest.failure_message,
              session: latest.session_name,
              providerSessionId: latest.provider_session_id,
              workspace: latest.workspace_path,
              patch: patch
                ? { path: patch.path, sha256: patch.sha256, changes: patch.data?.changes?.length ?? 0 }
                : null,
              costUsd: latest.cost_usd,
            }
          : null,
      };
    }),
    integration: store.latestIntegration(),
  };
}

const cell = (value) =>
  String(value ?? '')
    .replaceAll('|', String.raw`\|`)
    .replaceAll('\n', ' ');

function fmtUsage(usage) {
  if (!usage) {
    return 'not reported';
  }

  const parts = Object.entries(usage)
    .filter(([, value]) => typeof value === 'number')
    .map(([key, value]) => `${key} ${value}`);

  return parts.join(', ') || 'not reported';
}

export function renderReport(store) {
  const run = store.run();
  const tasks = store.tasks();
  const seq = store.lastEventSeq();
  const status = statusSnapshot(store);

  const lines = [
    `# Run ${run.id}`,
    '',
    `- Label: ${run.label}`,
    `- Outcome: **${status.outcome}**`,
    `- Supervisor: ${status.lease.live ? `live (generation ${run.owner_generation}, lease until ${status.lease.expiresAt})` : `none running (last generation ${run.owner_generation})`}`,
    `- Generated: ${new Date().toISOString()} from event #${seq}. A report whose event number lags \`status --json\` is stale.`,
  ];

  if (run.input) {
    const input = run.input;

    const snapshot =
      input.snapshot === 'none'
        ? 'live directory (no snapshot)'
        : `${input.snapshot} snapshot ${String(input.commit).slice(0, 12)}${input.dirty ? ` (includes uncommitted work, ${input.untracked?.length ?? 0} untracked files)` : ''}`;

    lines.push(`- Input: \`${input.root}\`, ${snapshot}`);
  }

  if (run.manifest) {
    lines.push(
      `- Limits: concurrency ${run.manifest.limits.concurrency}, run deadline ${status.deadlineAt ?? 'none'}`,
      run.manifest.checkSandbox.mode === 'none'
        ? '- Check sandbox: **none**. Verify and integration checks ran worker-written code with your privileges.'
        : '- Check sandbox: os. Checks could write only to their workspace, the temporary directories, and the configured roots.',
    );
  }

  const warnings = run.runtime?.warnings ?? [];

  for (const warning of warnings) {
    lines.push(`- Warning: ${warning}`);
  }

  if (run.dispatch_stopped) {
    lines.push(`- Dispatch stopped: ${run.dispatch_stopped}`);
  }

  if (run.cancel_requested) {
    lines.push('- Cancellation requested for the whole run');
  }

  lines.push(
    `- Reported spend: $${status.spend.reportedUsd.toFixed(2)}${status.spend.unknownAttempts > 0 ? ` (${status.spend.unknownAttempts} finished attempt${status.spend.unknownAttempts === 1 ? '' : 's'} did not report cost)` : ''}. This is reported usage, not an enforced cap.`,
    '',
    '## Tasks',
    '',
    '| Task | State | Depends on | Attempts | Profile | Session | Last attempt | Cost |',
    '| ---- | ----- | ---------- | -------- | ------- | ------- | ------------ | ---- |',
  );

  for (const task of tasks) {
    const attempts = store.attempts(task.id);
    const latest = attempts.at(-1);
    const session = latest ? store.session(latest.session_name) : null;
    const cost = attempts.reduce((total, attempt) => total + (attempt.cost_usd ?? 0), 0);

    lines.push(
      `| ${[
        task.id,
        task.state,
        store.dependencies(task.id).join(', ') || '-',
        attempts.length,
        task.spec.profile ?? '-',
        session?.provider_session_id ?? '-',
        latest ? `${latest.kind} ${latest.outcome ?? latest.phase}` : '-',
        attempts.some((attempt) => attempt.cost_usd !== null) ? `$${cost.toFixed(2)}` : '-',
      ]
        .map((value) => cell(value))
        .join(' | ')} |`,
    );
  }

  const integration = store.latestIntegration();

  if (run.manifest?.integration) {
    lines.push('', '## Integration', '');

    if (!integration) {
      lines.push('Not run. Task artifacts exist separately; they have **not** been combined or checked together.');
    } else {
      lines.push(
        `- Status: **${integration.status}** (${integration.created_at})`,
        `- Order: ${(integration.detail?.order ?? []).join(' → ')}`,
      );

      if (integration.patch_path) {
        lines.push(`- Combined patch: \`${integration.patch_path}\` (sha256 ${integration.patch_sha256})`);
      }

      if (integration.status === 'passed') {
        lines.push('- The combined artifact passed every integration check. Nothing was applied to your branch.');
      }

      const failures = integration.detail?.failures ?? [];

      for (const failure of failures) {
        lines.push(`- Failure: ${failure}`);
      }

      if (integration.detail?.conflict) {
        lines.push(
          `- Conflict applying ${integration.detail.conflict.taskId}: ${integration.detail.conflict.message.split('\n')[0]}`,
        );
      }

      if (integration.detail?.error) {
        lines.push(`- Error: ${integration.detail.error}`);
      }

      const integrationChecks = store.checks({ scope: 'integration' });

      for (const check of integrationChecks) {
        lines.push(
          `- Check ${check.name}: ${check.ok ? 'pass' : 'FAIL'} (exit ${check.exit_code ?? check.signal}, ${check.duration_ms} ms) log \`${check.log_path}\``,
        );
      }
    }
  }

  lines.push('', '## Task details');

  for (const task of tasks) {
    lines.push('', `### ${task.id}: ${task.state}`, '');

    const attempts = store.attempts(task.id);

    if (task.blocker) {
      lines.push(
        `- Blocker: ${task.blocker.reason}${task.blocker.needs ? `; needs: ${task.blocker.needs}` : ''}`,
        `  Continue with: \`orchestrator continue ${run.run_dir} --task ${task.id} --prompt-file <file>\``,
      );
    }

    if (task.failure_class && task.state !== 'succeeded') {
      lines.push(`- Failure (${task.failure_class}): ${task.failure_message}`);
    }

    if (attempts.length === 0) {
      lines.push('- No attempts yet.');
    }

    for (const attempt of attempts) {
      lines.push(
        `- Attempt ${attempt.number} \`${attempt.id}\` (${attempt.kind}): ${attempt.outcome ?? `in progress, phase ${attempt.phase}`}`,
      );

      if (attempt.payload && typeof attempt.payload === 'object') {
        const claim = attempt.payload;

        lines.push(`  - Worker claim: ${claim.status ?? 'result'}${claim.summary ? `: ${claim.summary}` : ''}`);

        if (Array.isArray(claim.files) && claim.files.length > 0) {
          lines.push(`    Claimed files: ${claim.files.join(', ')}`);
        }

        if (Array.isArray(claim.checks) && claim.checks.length > 0) {
          lines.push(`    Claimed checks: ${claim.checks.join('; ')}`);
        }
      }

      const exit = attempt.exit;

      if (exit) {
        lines.push(
          `  - Host evidence: ${exit.terminalReason}, exit ${exit.code ?? '-'}${exit.signal ? `, signal ${exit.signal}` : ''}, ${exit.durationMs} ms${exit.descendants?.present ? `, descendants stopped: ${exit.descendants.stopped}` : ''}`,
        );
      }

      if (attempt.result) {
        lines.push(
          `  - Provider outcome: ${attempt.result.providerOutcome}${attempt.result.message ? ` (${attempt.result.message})` : ''}`,
        );

        if (attempt.result.permissionDenials?.length > 0) {
          lines.push(`  - Permission denials: ${attempt.result.permissionDenials.join(', ')}`);
        }
      }

      if (attempt.failure_message && attempt.outcome !== 'succeeded') {
        lines.push(`  - Host verdict (${attempt.failure_class ?? attempt.outcome}): ${attempt.failure_message}`);
      }

      for (const artifact of store.artifacts(attempt.id)) {
        const changes = artifact.data?.changes ?? [];

        lines.push(
          `  - Artifact ${artifact.kind}: \`${artifact.path}\` (${artifact.bytes} bytes, sha256 ${artifact.sha256.slice(0, 16)}…), ${changes.length} changed paths`,
        );

        for (const change of changes.slice(0, 20)) {
          lines.push(`    - ${change.status} ${change.from ? `${change.from} → ` : ''}${change.path}`);
        }

        if (changes.length > 20) {
          lines.push(`    - … ${changes.length - 20} more`);
        }
      }

      const attemptChecks = store.checks({ attemptId: attempt.id });

      for (const check of attemptChecks) {
        lines.push(
          `  - Host check ${check.name}: ${check.ok ? 'pass' : 'FAIL'} (exit ${check.exit_code ?? check.signal}${check.timed_out ? ', timed out' : ''}, ${check.duration_ms} ms) log \`${check.log_path}\``,
        );
      }

      if (attempt.usage || attempt.cost_usd !== null) {
        lines.push(
          `  - Usage: ${fmtUsage(attempt.usage)}; cost ${attempt.cost_usd === null ? 'not reported' : `$${attempt.cost_usd.toFixed(4)}`}`,
        );
      }

      if (attempt.workspace_path) {
        lines.push(`  - Workspace: \`${attempt.workspace_path}\``);
      }

      lines.push(`  - Files: \`${path.relative(run.run_dir, attempt.attempt_dir)}\``);
    }
  }

  const log = store
    .events({ after: 0, limit: 100_000 })
    .filter((event) =>
      /^(recovery\.|control\.|lease\.acquired|run\.(deadline|spend_threshold|outcome)|session\.quarantined|session\.released)/.test(
        event.type,
      ),
    );

  if (log.length > 0) {
    lines.push('', '## Recovery and control log', '');

    for (const event of log) {
      const data = event.data ?? {};
      const subject = [event.task_id, event.attempt_id].filter(Boolean).join(' ');

      const detail =
        data.action ??
        data.status ??
        data.outcome ??
        data.reason ??
        (data.generation !== undefined ? `generation ${data.generation}` : '');

      lines.push(
        `- #${event.seq} ${event.at} ${event.type}${subject ? ` (${subject})` : ''}${detail ? `: ${detail}` : ''}${data.reason && data.action ? `, ${data.reason}` : ''}`,
      );
    }
  }

  lines.push(
    ...retainedSection(run),
    '',
    '---',
    '',
    'Generated from `state.sqlite`. Edits to this file are overwritten; regenerate it with `orchestrator report <run-dir>`.',
    '',
  );

  return lines.join('\n');
}

// worktrees and pinned refs live in the user's repository until someone removes them, so the report says so
function retainedSection(run) {
  if (run.kind !== 'manifest' || !run.input?.commit) {
    return [];
  }

  const workspaces = path.join(run.run_dir, 'workspaces');
  const present = [];

  try {
    const entries = fs.readdirSync(workspaces, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      if (entry.name.startsWith('_')) {
        present.push(entry.name);

        continue;
      }

      const attempts = fs.readdirSync(path.join(workspaces, entry.name));

      for (const attempt of attempts) {
        present.push(`${entry.name}/${attempt}`);
      }
    }
  } catch {
    // a missing workspaces directory means nothing is retained there
  }

  return [
    '',
    '## Retained in the repository',
    '',
    `- Worktrees registered in \`${run.input.root}\`: ${present.length === 0 ? 'none' : present.map((name) => `\`${name}\``).join(', ')}. \`orchestrator cleanup ${run.run_dir}\` removes the ones whose contents are preserved.`,
    `- Pinned refs under \`refs/orchestrator/${run.id}/\`. Cleanup keeps them and prints the command that deletes them.`,
  ];
}

// the script behind a workflow run owns run.md, so the execution record of such a run goes to execution.md
export function reportPath(run) {
  return path.join(run.run_dir, run.kind === 'manifest' ? 'run.md' : 'execution.md');
}

export function writeReport(store) {
  const file = reportPath(store.run());

  writeFileAtomic(file, renderReport(store));

  return file;
}
