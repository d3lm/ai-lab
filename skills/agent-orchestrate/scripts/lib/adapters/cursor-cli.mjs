import fs from 'node:fs';
import { readJsonLines } from '../process.mjs';
import { classifyMessage, dryRunArguments, truncate } from './common.mjs';

// cursor-agent prints this before any model call when the account cannot use the requested model
const MODEL_REJECTED = /cannot use this model/i;

const STDERR_TAIL_BYTES = 16 * 1024;

/**
 * `--trust` accepts the new worktree without the workspace trust prompt. `--workspace` names the
 * directory that Cursor's sandbox makes writable, so it is passed on resume too.
 */
function buildArgs(profile, { cwd, resumeSessionId, addDirs: extraDirectories = [] }) {
  const args = [...profile.executable, '-p', '--output-format', 'stream-json', '--trust'];

  if (resumeSessionId) {
    args.push('--resume', resumeSessionId);
  }

  args.push('--model', profile.model, '--sandbox', profile.sandbox, '--workspace', cwd);

  if (profile.force) {
    args.push('--force');
  }

  for (const dir of [...(profile.addDirs ?? []), ...extraDirectories]) {
    args.push('--add-dir', dir);
  }

  return args;
}

function messageText(record) {
  return (record.message?.content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

// a tool call holds one key such as `shellToolCall` or `editToolCall`, or a generic `function` entry
function toolEntry(toolCall) {
  const kind = Object.keys(toolCall ?? {}).find((key) => key.endsWith('ToolCall') || key === 'function');

  if (!kind) {
    return null;
  }

  const call = toolCall[kind] ?? {};
  const base = kind === 'function' ? (call.name ?? 'function') : kind.slice(0, -'ToolCall'.length);

  return { name: base.charAt(0).toUpperCase() + base.slice(1), call };
}

function describeToolCall(toolCall) {
  const entry = toolEntry(toolCall);

  if (!entry) {
    return 'tool';
  }

  const args = entry.call.args ?? {};

  if (entry.name === 'Shell' && args.command) {
    return `$ ${args.command}`;
  }

  return args.path ? `${entry.name}: ${args.path}` : `tool: ${entry.name}`;
}

function readTail(file) {
  if (!file) {
    return '';
  }

  try {
    const fd = fs.openSync(file, 'r');

    try {
      const { size } = fs.fstatSync(fd);
      const length = Math.min(size, STDERR_TAIL_BYTES);
      const buffer = Buffer.alloc(length);

      fs.readSync(fd, buffer, 0, length, size - length);

      return buffer.toString('utf8').trim();
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

export default {
  name: 'cursor-cli',
  adapterVersion: '1',
  binary: 'cursor-agent',
  package: null,
  installHint: 'the Cursor CLI (curl https://cursor.com/install -fsS | bash)',
  envVar: 'CURSOR_AGENT_CMD',
  versionArgs: ['--version'],
  capabilities: new Set(['resume', 'streaming-events']),

  // cursor-agent validates the model before it reads the prompt, so the dry run also catches an unusable model
  async probe(profile, { cwd, env }) {
    const expect = /No prompt provided/i;
    const fresh = await dryRunArguments(buildArgs(profile, { cwd }), { cwd, env, expect });

    if (!fresh.ok && MODEL_REJECTED.test(fresh.output)) {
      return {
        ok: false,
        problems: [`cursor-agent cannot use model ${profile.model}; \`cursor-agent models\` lists the usable ids`],
      };
    }

    const problems = [];

    if (!fresh.ok) {
      problems.push(
        `cursor-agent rejected the profile's arguments: ${truncate(fresh.output.split('\n').slice(0, 3).join(' '))}`,
      );
    }

    const resumed = await dryRunArguments(
      buildArgs(profile, { cwd, resumeSessionId: '00000000-0000-4000-8000-000000000000' }),
      { cwd, env, expect },
    );

    if (!resumed.ok) {
      problems.push(
        `cursor-agent rejected the resume arguments: ${truncate(resumed.output.split('\n').slice(0, 3).join(' '))}`,
      );
    }

    return { ok: problems.length === 0, problems };
  },

  /**
   * Cursor Agent has no flag that takes a result schema, so the schema goes into the prompt.
   * The runner still validates the final message against it, exactly as for the other adapters.
   */
  resultInstructions(schemaText) {
    return [
      '',
      'Result format (from the supervisor):',
      '',
      '- Your last message, sent after your last tool call, is the result. It must be exactly one JSON object that validates against the JSON Schema below.',
      '- Write nothing before or after that object, and do not wrap it in a code fence. Any other text fails the attempt.',
      '',
      '```json',
      schemaText.trim(),
      '```',
      '',
    ].join('\n');
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
      case 'system': {
        if (record.subtype !== 'init') {
          return [];
        }

        return [
          { type: 'session', sessionId: record.session_id ?? null },
          {
            type: 'init',
            model: record.model ?? null,
            permissionMode: record.permissionMode ?? null,
            apiKeySource: record.apiKeySource ?? null,
            cwd: record.cwd ?? null,
          },
        ];
      }
      case 'assistant': {
        return [{ type: 'progress', text: truncate(messageText(record)) }];
      }
      case 'tool_call': {
        return record.subtype === 'started'
          ? [{ type: 'progress', text: truncate(describeToolCall(record.tool_call)) }]
          : [];
      }
      case 'result': {
        return [
          { type: 'session', sessionId: record.session_id ?? null },
          { type: 'usage', usage: record.usage ?? null, costUsd: null },
          { type: 'terminal', ok: !record.is_error && record.subtype === 'success', detail: record.subtype ?? null },
        ];
      }
      default: {
        return [];
      }
    }
  },

  /**
   * The `result` record's text joins every assistant message of the turn, so the payload comes
   * from the last assistant message, which must follow the last tool call. A failed run exits
   * non-zero without a result record and explains itself on stderr. Nothing is repaired.
   */
  parseResult({ stdoutFile, stderrFile }) {
    const { records, invalid } = readJsonLines(stdoutFile);
    const init = records.find((record) => record.type === 'system' && record.subtype === 'init');
    const result = records.findLast((record) => record.type === 'result');
    const lastAssistant = records.findLastIndex((record) => record.type === 'assistant');
    const lastToolCall = records.findLastIndex((record) => record.type === 'tool_call');

    const permissionDenials = records
      .filter((record) => record.type === 'tool_call' && record.subtype === 'completed')
      .map((record) => toolEntry(record.tool_call))
      .filter((entry) => entry?.call.result?.rejected)
      .map((entry) => entry.name);

    const base = {
      sessionId: result?.session_id ?? init?.session_id ?? null,
      usage: result?.usage ?? null,
      costUsd: null,
      numTurns: null,
      permissionDenials,
      protocolErrors: invalid,
      diagnostics: {
        subtype: result?.subtype ?? null,
        requestId: result?.request_id ?? null,
        durationMs: result?.duration_ms ?? null,
        model: init?.model ?? null,
        permissionMode: init?.permissionMode ?? null,
        apiKeySource: init?.apiKeySource ?? null,
      },
      payload: null,
      payloadSource: null,
    };

    if (!result) {
      const stderr = readTail(stderrFile);

      if (stderr) {
        // runtime warnings can precede the error line, so an explicit error line wins over position
        const lines = stderr.split('\n').filter((line) => line.trim());
        const errorLine = lines.findLast((line) => /^error\b/i.test(line) || MODEL_REJECTED.test(line)) ?? lines.at(-1);

        return {
          ...base,
          providerOutcome: 'failure',
          failureClass: MODEL_REJECTED.test(stderr) ? 'launch' : classifyMessage(stderr),
          message: `cursor-agent: ${truncate(errorLine, 500)}`,
        };
      }

      return {
        ...base,
        providerOutcome: 'missing',
        failureClass: 'protocol',
        message: `no result record in ${stdoutFile}`,
      };
    }

    if (result.is_error || result.subtype !== 'success') {
      const text = `${result.subtype ?? ''} ${typeof result.result === 'string' ? result.result : ''}`;

      return {
        ...base,
        providerOutcome: 'failure',
        failureClass: classifyMessage(text),
        message: `cursor-agent result ${result.subtype ?? 'unknown'}${result.is_error ? ' (is_error)' : ''}`,
      };
    }

    let text;
    let source;

    if (lastAssistant === -1) {
      text = typeof result.result === 'string' ? result.result : null;
      source = 'result';
    } else if (lastAssistant > lastToolCall) {
      text = messageText(records[lastAssistant]);
      source = 'final-message';
    } else {
      text = null;
    }

    if (text === null) {
      return {
        ...base,
        providerOutcome: 'success',
        failureClass: 'protocol',
        message: `no final assistant message after the last tool call in ${stdoutFile}`,
      };
    }

    try {
      return { ...base, providerOutcome: 'success', payload: JSON.parse(text.trim()), payloadSource: source };
    } catch (error) {
      return {
        ...base,
        providerOutcome: 'success',
        failureClass: 'protocol',
        message: `final message is not exact JSON (${error.message}): ${truncate(text, 200)}`,
      };
    }
  },
};
