import fs from 'node:fs';
import { readJsonLines } from '../process.mjs';
import { classifyMessage, dryRunArguments, truncate } from './common.mjs';

function buildArgs(
  profile,
  {
    schemaFile,
    lastMessageFile,
    cwd,
    resumeSessionId,
    isGitRepo: isGitRepository = true,
    addDirs: addDirectories = [],
  },
) {
  const common = ['--json', '-m', profile.model];

  if (profile.effort) {
    common.push('-c', `model_reasoning_effort="${profile.effort}"`);
  }

  const overrides = Object.entries(profile.config ?? {});

  for (const [key, value] of overrides) {
    common.push('-c', `${key}=${value}`);
  }

  common.push('--output-schema', schemaFile, '-o', lastMessageFile);

  const directories = [...(profile.addDirs ?? []), ...addDirectories];
  const skip = isGitRepository ? [] : ['--skip-git-repo-check'];

  if (resumeSessionId) {
    const roots =
      directories.length > 0 ? ['-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(directories)}`] : [];

    return [
      ...profile.executable,
      'exec',
      'resume',
      resumeSessionId,
      ...common,
      '-c',
      `sandbox_mode="${profile.sandbox}"`,
      ...roots,
      ...skip,
      '-',
    ];
  }

  return [
    ...profile.executable,
    'exec',
    ...common,
    '-s',
    profile.sandbox,
    '-C',
    cwd,
    ...directories.flatMap((dir) => ['--add-dir', dir]),
    ...skip,
    '-',
  ];
}

export default {
  name: 'codex-cli',
  adapterVersion: '1',
  binary: 'codex',
  package: '@openai/codex',
  envVar: 'CODEX_CMD',
  versionArgs: ['--version'],
  capabilities: new Set(['resume', 'streaming-events', 'structured-output', 'sandbox']),

  async probe(profile, { cwd, env, schemaFile, lastMessageFile }) {
    const problems = [];
    const options = { schemaFile, lastMessageFile, cwd, isGitRepo: false };
    const fresh = await dryRunArguments(buildArgs(profile, options), { cwd, env, expect: /No prompt provided/i });

    if (!fresh.ok) {
      problems.push(`codex rejected the profile's arguments: ${fresh.output.split('\n').slice(0, 3).join(' ')}`);
    }

    const resumed = await dryRunArguments(
      buildArgs(profile, { ...options, resumeSessionId: '00000000-0000-4000-8000-000000000000' }),
      { cwd, env, expect: /No prompt provided/i },
    );

    if (!resumed.ok) {
      problems.push(`codex rejected the resume arguments: ${resumed.output.split('\n').slice(0, 3).join(' ')}`);
    }

    return { ok: problems.length === 0, problems };
  },

  buildInvocation(attempt) {
    return {
      argv: buildArgs(attempt.profile, attempt),
      cwd: attempt.cwd,
      stdinFile: attempt.promptFile,
      env: {},
    };
  },

  parseEvent(record) {
    switch (record.type) {
      case 'thread.started': {
        return [{ type: 'session', sessionId: record.thread_id ?? null }];
      }
      case 'item.completed': {
        const item = record.item ?? {};

        const text =
          item.type === 'agent_message'
            ? item.text
            : item.type === 'command_execution'
              ? `$ ${item.command}`
              : item.type;

        return [{ type: 'progress', text: truncate(text ?? '') }];
      }
      case 'turn.completed': {
        return [
          { type: 'usage', usage: record.usage ?? null, costUsd: null },
          { type: 'terminal', ok: true, detail: 'turn.completed' },
        ];
      }
      case 'turn.failed':
      case 'error': {
        return [
          { type: 'terminal', ok: false, detail: truncate(record.error?.message ?? record.message ?? record.type) },
        ];
      }
      default: {
        return [];
      }
    }
  },

  /**
   * Success requires a completed turn, no failure event, and a valid final message.
   * A plausible final-message file does not override a failed or interrupted turn.
   */
  parseResult({ stdoutFile, lastMessageFile }) {
    const { records, invalid } = readJsonLines(stdoutFile);
    const sessionId = records.find((record) => record.type === 'thread.started')?.thread_id ?? null;
    const completed = records.findLast((record) => record.type === 'turn.completed');
    const failed = records.find((record) => record.type === 'turn.failed' || record.type === 'error');

    const base = {
      sessionId,
      usage: completed?.usage ?? null,
      costUsd: null,
      numTurns: null,
      permissionDenials: [],
      protocolErrors: invalid,
      diagnostics: { failedEvent: failed ?? null },
      payload: null,
      payloadSource: null,
    };

    if (failed) {
      const message = failed.error?.message ?? failed.message ?? failed.type;

      return {
        ...base,
        providerOutcome: 'failure',
        failureClass: classifyMessage(String(message)),
        message: `codex ${failed.type}: ${truncate(String(message), 500)}`,
      };
    }

    if (!completed) {
      return {
        ...base,
        providerOutcome: 'missing',
        failureClass: 'protocol',
        message: `no turn.completed event in ${stdoutFile}`,
      };
    }

    let text;

    try {
      text = fs.readFileSync(lastMessageFile, 'utf8');
    } catch {
      return {
        ...base,
        providerOutcome: 'success',
        failureClass: 'protocol',
        message: `final message file missing: ${lastMessageFile}`,
      };
    }

    try {
      return { ...base, providerOutcome: 'success', payload: JSON.parse(text.trim()), payloadSource: lastMessageFile };
    } catch (error) {
      return {
        ...base,
        providerOutcome: 'success',
        failureClass: 'protocol',
        message: `malformed final message in ${lastMessageFile}: ${error.message}`,
      };
    }
  },
};
