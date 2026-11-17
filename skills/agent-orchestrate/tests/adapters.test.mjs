import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import claude from '../scripts/lib/adapters/claude-cli.mjs';
import codex from '../scripts/lib/adapters/codex-cli.mjs';
import { resolveExecutable } from '../scripts/lib/adapters/common.mjs';
import cursor from '../scripts/lib/adapters/cursor-cli.mjs';
import { createLineDecoder } from '../scripts/lib/process.mjs';
import { FAKE_CLI, claudeProfile, codexProfile, cursorProfile, makeTemporaryDir } from './helpers.mjs';

const flag = (argv, name) => {
  const index = argv.indexOf(name);

  return index === -1 ? null : argv[index + 1];
};

test('claude invocations reapply the whole profile, fresh and resumed', () => {
  const profile = claudeProfile({
    executable: ['claude'],
    allowedTools: ['Read', 'Edit(src/**)', 'Bash(npm test:*)'],
    disallowedTools: ['Edit'],
    addDirs: ['/extra'],
    settingSources: ['user'],
    strictMcpConfig: true,
  });

  const base = { profile, schemaText: '{"type":"object"}', cwd: '/work', promptFile: '/p.md' };
  const fresh = claude.buildInvocation({ ...base, sessionName: 'run/task' }).argv;
  const resumed = claude.buildInvocation({ ...base, resumeSessionId: 'sess-1' }).argv;

  assert.deepEqual(fresh.slice(0, 2), ['claude', '-p']);
  assert.equal(flag(fresh, '--name'), 'run/task');
  assert.equal(flag(resumed, '--resume'), 'sess-1');
  assert.equal(resumed.includes('--name'), false);

  for (const argv of [fresh, resumed]) {
    assert.equal(flag(argv, '--model'), 'claude-test');
    assert.equal(flag(argv, '--effort'), 'high');
    assert.equal(flag(argv, '--output-format'), 'stream-json');
    assert.ok(argv.includes('--verbose'));
    assert.equal(flag(argv, '--json-schema'), '{"type":"object"}');
    assert.equal(flag(argv, '--permission-mode'), 'acceptEdits');
    assert.equal(flag(argv, '--permission-prompts'), 'none');
    assert.equal(flag(argv, '--tools'), 'Read,Edit,Write', 'available tools are separate from approvals');

    assert.deepEqual(argv.slice(argv.indexOf('--allowedTools') + 1, argv.indexOf('--allowedTools') + 4), [
      'Read',
      'Edit(src/**)',
      'Bash(npm test:*)',
    ]);

    assert.equal(flag(argv, '--disallowedTools'), 'Edit');
    assert.equal(flag(argv, '--max-budget-usd'), '1');
    assert.equal(flag(argv, '--setting-sources'), 'user');
    assert.ok(argv.includes('--strict-mcp-config'));
    assert.equal(flag(argv, '--add-dir'), '/extra');
  }
});

test('codex resume reapplies sandbox and writable roots through config, since exec resume lacks -s, -C, and --add-dir', () => {
  const profile = codexProfile({ executable: ['codex'], addDirs: ['/extra'], config: { model_verbosity: '"low"' } });

  const base = {
    profile,
    schemaFile: '/s.json',
    lastMessageFile: '/last.json',
    cwd: '/work',
    promptFile: '/p.md',
    isGitRepo: false,
  };

  const fresh = codex.buildInvocation(base).argv;
  const resumed = codex.buildInvocation({ ...base, resumeSessionId: 'thread-1' }).argv;

  assert.deepEqual(fresh.slice(0, 2), ['codex', 'exec']);
  assert.equal(flag(fresh, '-s'), 'workspace-write');
  assert.equal(flag(fresh, '-C'), '/work');
  assert.equal(flag(fresh, '--add-dir'), '/extra');
  assert.deepEqual(resumed.slice(0, 4), ['codex', 'exec', 'resume', 'thread-1']);
  assert.equal(resumed.includes('-s') || resumed.includes('-C') || resumed.includes('--add-dir'), false);
  assert.ok(resumed.includes('sandbox_mode="workspace-write"'));
  assert.ok(resumed.includes('sandbox_workspace_write.writable_roots=["/extra"]'));

  for (const argv of [fresh, resumed]) {
    assert.ok(argv.includes('--json'));
    assert.equal(flag(argv, '-m'), 'codex-test');
    assert.ok(argv.includes('model_reasoning_effort="high"'));
    assert.ok(argv.includes('model_verbosity="low"'));
    assert.equal(flag(argv, '--output-schema'), '/s.json');
    assert.equal(flag(argv, '-o'), '/last.json');
    assert.ok(argv.includes('--skip-git-repo-check'));
    assert.equal(argv.at(-1), '-');
  }
});

test('cursor invocations reapply the whole profile, fresh and resumed, and pin the sandbox to the workspace', () => {
  const profile = cursorProfile({ executable: ['cursor-agent'], addDirs: ['/extra'] });
  const base = { profile, schemaText: '{"type":"object"}', cwd: '/work', promptFile: '/p.md' };
  const fresh = cursor.buildInvocation({ ...base, sessionName: 'run/task' }).argv;
  const resumed = cursor.buildInvocation({ ...base, resumeSessionId: 'chat-1', addDirs: ['/more'] }).argv;

  assert.deepEqual(fresh.slice(0, 2), ['cursor-agent', '-p']);
  assert.equal(fresh.includes('--resume'), false);
  assert.equal(flag(resumed, '--resume'), 'chat-1');

  for (const argv of [fresh, resumed]) {
    assert.equal(flag(argv, '--output-format'), 'stream-json');
    assert.ok(argv.includes('--trust'));
    assert.equal(flag(argv, '--model'), 'cursor-test');
    assert.equal(flag(argv, '--sandbox'), 'enabled');
    assert.equal(flag(argv, '--workspace'), '/work');
    assert.equal(argv.includes('--force'), false, 'force is never added unless the profile asks for it');
    assert.equal(argv.includes('--stream-partial-output'), false, 'assistant events must stay whole messages');
  }

  assert.deepEqual(
    resumed.filter((_, index) => resumed[index - 1] === '--add-dir'),
    ['/extra', '/more'],
  );

  assert.ok(cursor.buildInvocation({ ...base, profile: { ...profile, force: true } }).argv.includes('--force'));
});

test('cursor carries the result schema in the prompt because its CLI cannot take one', () => {
  const schema = '{"type":"object","required":["ok"]}';
  const text = cursor.resultInstructions(`${schema}\n`);

  assert.ok(text.includes(schema));
  assert.match(text, /exactly one JSON object/);
  assert.equal(claude.resultInstructions, undefined, 'claude takes the schema as --json-schema');
  assert.equal(codex.resultInstructions, undefined, 'codex takes the schema as --output-schema');
  assert.equal(cursor.capabilities.has('structured-output'), false, 'the provider does not enforce the schema');
});

// these shapes were recorded from the CLIs' JSON output and reduced to the fields the adapters read
const CLAUDE_STREAM = [
  {
    type: 'system',
    subtype: 'init',
    session_id: 's-9',
    model: 'claude-fable-5-1',
    permissionMode: 'acceptEdits',
    tools: ['Read', 'Edit'],
    mcp_servers: [{ name: 'docs', status: 'failed' }],
    apiKeySource: 'none',
  },
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit' }] }, session_id: 's-9' },
  { type: 'user', message: { content: [{ type: 'tool_result' }] }, session_id: 's-9' },
  {
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: 's-9',
    num_turns: 4,
    total_cost_usd: 0.31,
    usage: { input_tokens: 1200, output_tokens: 300 },
    permission_denials: [{ tool_name: 'Bash' }],
    result: '{"ok":true}',
    structured_output: { ok: true },
  },
];

const CODEX_STREAM = [
  { type: 'thread.started', thread_id: 't-3' },
  { type: 'turn.started' },
  { type: 'item.started', item: { id: 'i0', type: 'command_execution', command: 'rg foo', status: 'in_progress' } },
  {
    type: 'item.completed',
    item: { id: 'i0', type: 'command_execution', command: 'rg foo', exit_code: 0, status: 'completed' },
  },
  { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: '{"ok":true}' } },
  { type: 'turn.completed', usage: { input_tokens: 900, cached_input_tokens: 600, output_tokens: 80 } },
];

const CURSOR_SESSION = 'fdeb0afc-8650-49fd-aae6-3d2cf58b5d71';

const cursorText = (text, extra = {}) => {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    session_id: CURSOR_SESSION,
    ...extra,
  };
};

const CURSOR_SHELL = {
  shellToolCall: {
    args: { command: 'touch shell-made.txt' },
    result: { rejected: { command: 'touch shell-made.txt' } },
  },
};

// these were recorded from cursor-agent 2026.07.23 and 2026.10.14, whose stream-json result text joins every message
const CURSOR_STREAM = [
  {
    type: 'system',
    subtype: 'init',
    apiKeySource: 'login',
    cwd: '/private/tmp/ca-live',
    session_id: CURSOR_SESSION,
    model: 'Composer 2.5 Fast',
    permissionMode: 'default',
  },
  { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'prompt' }] }, session_id: CURSOR_SESSION },
  { type: 'thinking', subtype: 'delta', text: 'I need to', session_id: CURSOR_SESSION, timestamp_ms: 1 },
  cursorText('Trying the command.\n\n', { timestamp_ms: 2, model_call_id: 'm-1' }),
  { type: 'tool_call', subtype: 'started', call_id: 'c1', tool_call: CURSOR_SHELL, session_id: CURSOR_SESSION },
  { type: 'tool_call', subtype: 'completed', call_id: 'c1', tool_call: CURSOR_SHELL, session_id: CURSOR_SESSION },
  cursorText('{"ok":true}'),
  {
    type: 'result',
    subtype: 'success',
    duration_ms: 6028,
    duration_api_ms: 6028,
    is_error: false,
    result: 'Trying the command.\n\n{"ok":true}',
    session_id: CURSOR_SESSION,
    request_id: '68b0626b-41b6-4b06-90e4-322cb422500f',
    usage: { inputTokens: 9574, outputTokens: 103, cacheReadTokens: 17_248, cacheWriteTokens: 0 },
  },
];

function writeLines(dir, name, records, trailing = '') {
  const file = path.join(dir, name);

  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n' + trailing);

  return file;
}

test('claude results come from the final result record and keep diagnostics', (t) => {
  const dir = makeTemporaryDir(t);
  const ok = claude.parseResult({ stdoutFile: writeLines(dir, 'ok.jsonl', CLAUDE_STREAM, 'garbage line\n') });

  assert.equal(ok.providerOutcome, 'success');
  assert.deepEqual(ok.payload, { ok: true });
  assert.equal(ok.sessionId, 's-9');
  assert.equal(ok.costUsd, 0.31);
  assert.deepEqual(ok.permissionDenials, ['Bash']);
  assert.equal(ok.protocolErrors, 1);
  assert.deepEqual(ok.diagnostics.tools, ['Read', 'Edit']);

  const events = CLAUDE_STREAM.flatMap((record) => claude.parseEvent(record));

  assert.deepEqual(events.find((event) => event.type === 'init').mcpServers, ['docs:failed']);
  assert.equal(events.find((event) => event.type === 'progress').text, 'tool: Edit');

  const budget = claude.parseResult({
    stdoutFile: writeLines(dir, 'budget.jsonl', [
      CLAUDE_STREAM[0],
      { type: 'result', subtype: 'error_max_budget_usd', is_error: true, session_id: 's-9', total_cost_usd: 1 },
    ]),
  });

  assert.equal(budget.providerOutcome, 'failure');
  assert.equal(budget.failureClass, 'budget');
  assert.equal(budget.sessionId, 's-9', 'the session survives a failed turn');

  const auth = claude.parseResult({
    stdoutFile: writeLines(dir, 'auth.jsonl', [
      {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: 'Invalid API key · Please run /login',
      },
    ]),
  });

  assert.equal(auth.failureClass, 'auth');

  const missing = claude.parseResult({ stdoutFile: writeLines(dir, 'missing.jsonl', [CLAUDE_STREAM[0]]) });

  assert.equal(missing.providerOutcome, 'missing');
  assert.equal(missing.sessionId, 's-9', 'the session id is captured from init before any result');
});

test('codex success needs turn.completed and a parseable final message; failures win over a plausible message', (t) => {
  const dir = makeTemporaryDir(t);
  const last = path.join(dir, 'last.json');

  fs.writeFileSync(last, '{"ok":true}');

  const ok = codex.parseResult({ stdoutFile: writeLines(dir, 'ok.jsonl', CODEX_STREAM), lastMessageFile: last });

  assert.equal(ok.providerOutcome, 'success');
  assert.equal(ok.sessionId, 't-3');
  assert.equal(ok.costUsd, null, 'unknown cost is null, never zero');

  const failed = codex.parseResult({
    stdoutFile: writeLines(dir, 'failed.jsonl', [
      ...CODEX_STREAM.slice(0, 2),
      { type: 'turn.failed', error: { message: 'rate limit exceeded (429)' } },
    ]),
    lastMessageFile: last,
  });

  assert.equal(failed.providerOutcome, 'failure');
  assert.equal(failed.failureClass, 'transient');

  const interrupted = codex.parseResult({
    stdoutFile: writeLines(dir, 'cut.jsonl', CODEX_STREAM.slice(0, 4)),
    lastMessageFile: last,
  });

  assert.equal(interrupted.providerOutcome, 'missing');

  fs.writeFileSync(last, '```json\n{"ok":true}\n```');

  const fenced = codex.parseResult({
    stdoutFile: writeLines(dir, 'fenced.jsonl', CODEX_STREAM),
    lastMessageFile: last,
  });

  assert.equal(fenced.failureClass, 'protocol', 'nothing is repaired');
});

test('cursor results come from the last assistant message after the last tool call, never from joined text', (t) => {
  const dir = makeTemporaryDir(t);
  const stdoutFile = writeLines(dir, 'ok.jsonl', CURSOR_STREAM);
  const ok = cursor.parseResult({ stdoutFile, stderrFile: path.join(dir, 'none.log') });

  assert.equal(ok.providerOutcome, 'success');
  assert.equal(ok.failureClass, undefined);
  assert.deepEqual(ok.payload, { ok: true });
  assert.equal(ok.payloadSource, 'final-message');
  assert.equal(ok.sessionId, CURSOR_SESSION);
  assert.equal(ok.costUsd, null, 'cursor-agent reports tokens, not cost');
  assert.equal(ok.usage.inputTokens, 9574);
  assert.deepEqual(ok.permissionDenials, ['Shell']);
  assert.equal(ok.diagnostics.model, 'Composer 2.5 Fast');

  const events = CURSOR_STREAM.flatMap((record) => cursor.parseEvent(record));

  assert.equal(events.find((event) => event.type === 'session').sessionId, CURSOR_SESSION);
  assert.ok(events.some((event) => event.type === 'progress' && event.text === '$ touch shell-made.txt'));
  assert.deepEqual(events.at(-1), { type: 'terminal', ok: true, detail: 'success' });

  const toolLast = cursor.parseResult({
    stdoutFile: writeLines(dir, 'tool-last.jsonl', [...CURSOR_STREAM.slice(0, 6), CURSOR_STREAM.at(-1)]),
  });

  assert.equal(toolLast.failureClass, 'protocol', 'text before a tool call is not the final message');

  const prose = cursor.parseResult({
    stdoutFile: writeLines(dir, 'prose.jsonl', [
      ...CURSOR_STREAM.slice(0, 6),
      cursorText('{"ok":false}\n\nI could not do it.'),
      CURSOR_STREAM.at(-1),
    ]),
  });

  assert.equal(prose.failureClass, 'protocol', 'nothing is repaired');
});

test('a cursor run that fails before a result record is classified from stderr', (t) => {
  const dir = makeTemporaryDir(t);
  const empty = writeLines(dir, 'empty.jsonl', []);
  const stderrFile = path.join(dir, 'stderr.log');

  fs.writeFileSync(stderrFile, 'Cannot use this model: no-such-model. Available models: auto, composer-2.5\n');

  const model = cursor.parseResult({ stdoutFile: empty, stderrFile });

  assert.equal(model.providerOutcome, 'failure');
  assert.equal(model.failureClass, 'launch', 'an unusable model is configuration, not a transient failure');
  assert.match(model.message, /Cannot use this model/);

  fs.writeFileSync(stderrFile, 'Error: not logged in. Run cursor-agent login\n');
  assert.equal(cursor.parseResult({ stdoutFile: empty, stderrFile }).failureClass, 'auth');

  const cut = cursor.parseResult({ stdoutFile: writeLines(dir, 'cut.jsonl', CURSOR_STREAM.slice(0, 3)) });

  assert.equal(cut.providerOutcome, 'missing');
  assert.equal(cut.sessionId, CURSOR_SESSION, 'the session id is captured from init before any result');
});

test('the line decoder keeps partial records and multi-byte characters across chunks and drops oversized records', () => {
  const records = [];
  const oversize = [];

  const decoder = createLineDecoder({
    maxRecordBytes: 32,
    onRecord: (line) => records.push(line),
    onOversize: (bytes) => oversize.push(bytes),
  });

  const text = Buffer.from(`{"a":"✓é"}\n${'x'.repeat(40)}\n{"b":2}\n{"tail":`);

  for (let index = 0; index < text.length; index += 3) {
    decoder.push(text.subarray(index, index + 3));
  }

  assert.deepEqual(records, ['{"a":"✓é"}', '{"b":2}']);
  assert.equal(oversize.length, 1);
  assert.equal(decoder.end(), '{"tail":');
});

test('resolution skips a working binary that cannot apply the profile and records why', async (t) => {
  const dir = makeTemporaryDir(t);
  const old = path.join(dir, 'old');
  const good = path.join(dir, 'good');

  fs.mkdirSync(old);
  fs.mkdirSync(good);

  fs.writeFileSync(
    path.join(old, 'claude'),
    '#!/bin/sh\nif [ "$1" = --version ]; then echo \'1.0.0 (Claude Code)\'; exit 0; fi\necho "error: unknown option \'--permission-prompts\'" >&2\nexit 1\n',
    { mode: 0o755 },
  );

  fs.writeFileSync(path.join(good, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" "$@"\n`, {
    mode: 0o755,
  });

  const env = { ...process.env, PATH: `${old}:${good}` };

  delete env.CLAUDE_CMD;

  const profile = claudeProfile();

  delete profile.executable;

  const found = await resolveExecutable(claude, {
    env,
    accept: (argv) => claude.probe({ ...profile, executable: argv }, { cwd: dir, env }),
  });

  assert.deepEqual(found.argv, [path.join(good, 'claude')]);
  assert.equal(found.source, 'path');
  assert.equal(found.rejected.length, 1);
  assert.match(found.rejected[0].reason, /unknown option '--permission-prompts'/);

  const explicit = { ...env, CLAUDE_CMD: path.join(old, 'claude') };

  await assert.rejects(
    resolveExecutable(claude, {
      env: explicit,
      accept: (argv) => claude.probe({ ...profile, executable: argv }, { cwd: dir, env: explicit }),
    }),
    /Set CLAUDE_CMD to a working command/,
    'an explicit override is never silently replaced',
  );
});

test('a missing cursor-agent names its installer instead of a package, and probing it never needs a prompt', async (t) => {
  const dir = makeTemporaryDir(t);

  await assert.rejects(
    resolveExecutable(cursor, { env: { PATH: dir } }),
    /cannot resolve a working cursor-agent executable[\s\S]*Set CURSOR_AGENT_CMD to a working command or install the Cursor CLI/,
  );

  const probe = await cursor.probe(cursorProfile(), { cwd: dir, env: process.env });

  assert.deepEqual(probe, { ok: true, problems: [] });
});
