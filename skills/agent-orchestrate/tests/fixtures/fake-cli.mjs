#!/usr/bin/env node

/**
 * Stands in for the Claude, Codex, or Cursor CLI in runner tests. It emulates whichever CLI its
 * arguments look like (`exec` means codex, `--trust` means cursor-agent) and takes its behaviour
 * from a `FAKE: {json}` line in the prompt on stdin.
 *
 * Every directive field is optional:
 *
 * - `status` sets the generic payload status to 'done' or 'blocked'
 * - `payload` replaces the generic payload with an explicit object
 * - `wrongIds` returns the wrong attempt id
 * - `malformed` writes an unparseable final result
 * - `exitCode` exits with this code after the output
 * - `signal` makes the fake kill itself with this signal
 * - `sleepMs` waits this long before answering
 * - `hang` never answers
 * - `child` spawns a long-lived 'attached' or 'detached' descendant
 * - `childPidFile` names the file that receives the descendant pid
 * - `writes` lists files to write in cwd as [{path, content, base64?, mode?}]
 * - `deletes` lists paths to delete as [path]
 * - `symlinks` lists symlinks to create as [{path, target}]
 * - `flood` sets how many bytes of extra stdout to write
 * - `stderr` adds extra stderr noise
 * - `claudeSubtype` sets the result subtype for claude (e.g. error_max_budget_usd)
 * - `codexFail` emits turn.failed with this message
 * - `cursorFail` makes cursor-agent print this message on stderr and exit 1 without a result record
 * - `cursorToolLast` makes cursor-agent end its turn with a tool call instead of a final message
 * - `resultThenFail` writes a valid result, then exits 1
 * - `chunked` writes stdout in small chunks with pauses
 * - `sessionId` sets the session id to report
 * - `bigRecordBytes` emits one oversized JSON record first
 * - `counterFile` and `perAttempt` give per-invocation overrides, e.g. hang on the first call and
 *   succeed on the second
 *
 * Invocations are logged to $FAKE_LOG (JSON lines) when set.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const argv = process.argv.slice(2);
const isCodex = argv[0] === 'exec';
const isCursor = argv.includes('--trust');
const cliName = isCodex ? 'codex' : isCursor ? 'cursor' : 'claude';

// a pipe can be momentarily empty (EAGAIN) before the writer's data arrives, so wait instead of treating it as EOF
function readStdin() {
  const chunks = [];
  const buffer = Buffer.alloc(65_536);
  const pause = new Int32Array(new SharedArrayBuffer(4));

  while (true) {
    let read;

    try {
      read = fs.readSync(0, buffer, 0, buffer.length, null);
    } catch (error) {
      if (error.code === 'EAGAIN') {
        Atomics.wait(pause, 0, 0, 5);

        continue;
      }

      return error.code === 'EOF' ? Buffer.concat(chunks).toString('utf8') : '';
    }

    if (read === 0) {
      return Buffer.concat(chunks).toString('utf8');
    }

    chunks.push(Buffer.from(buffer.subarray(0, read)));
  }
}

function flagValue(name) {
  const index = argv.indexOf(name);

  return index === -1 ? null : argv[index + 1];
}

if (argv.includes('--version') || argv.includes('-V')) {
  console.log(isCodex ? 'codex-cli 0.0.1-fake' : '0.0.1-fake (Claude Code)');
  process.exit(0);
}

const stdin = readStdin();

if (process.env.FAKE_LOG) {
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv, cwd: process.cwd(), pid: process.pid, stdin }) + '\n');
}

if (!stdin.trim()) {
  // mimic each CLI's empty-prompt error so argument dry runs succeed
  console.error(
    {
      codex: 'No prompt provided via stdin.',
      cursor: 'Error: No prompt provided for print mode',
      claude: 'Error: Input must be provided either through stdin or as a prompt argument when using --print',
    }[cliName],
  );

  process.exit(1);
}

const directiveLine = stdin.split('\n').find((line) => line.startsWith('FAKE: '));
const fake = directiveLine ? JSON.parse(directiveLine.slice(6)) : {};

// the perAttempt entries override the directive for the 1st, 2nd, ... invocation counted in counterFile
if (fake.counterFile) {
  const index = fs.existsSync(fake.counterFile) ? Number(fs.readFileSync(fake.counterFile, 'utf8')) : 0;

  fs.writeFileSync(fake.counterFile, String(index + 1));
  Object.assign(fake, fake.perAttempt?.[index] ?? {});
}

const taskId = stdin.match(/Task id: `([^`]+)`/)?.[1] ?? 'unknown-task';
const attemptId = stdin.match(/Attempt id: `([^`]+)`/)?.[1] ?? 'unknown-attempt';
const resumed = isCodex ? (argv[1] === 'resume' ? argv[2] : null) : flagValue('--resume');

const sessionId =
  fake.sessionId ?? resumed ?? { codex: 'thread-fake', cursor: 'chat-fake', claude: 'session-fake' }[cliName];

const payload = fake.payload ?? {
  taskId,
  attemptId: fake.wrongIds ? 'a-wrong' : attemptId,
  status: fake.status ?? 'done',
  summary: fake.summary ?? `fake ${cliName} finished ${taskId}`,
  blocker: fake.status === 'blocked' ? { reason: 'needs a decision', needs: 'operator input' } : null,
  files: (fake.writes ?? []).map((item) => item.path),
  checks: [],
};

function message(text, extra = {}) {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, ...extra };
}

async function out(text) {
  if (!fake.chunked) {
    process.stdout.write(text);
    return;
  }

  // split inside multi-byte characters and JSON tokens on purpose
  const buffer = Buffer.from(text);

  for (let index = 0; index < buffer.length; index += 7) {
    process.stdout.write(buffer.subarray(index, index + 7));
    await delay(1);
  }
}

if (fake.child) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: fake.child === 'detached',
    stdio: 'ignore',
  });

  child.unref();

  if (fake.childPidFile) {
    fs.writeFileSync(fake.childPidFile, String(child.pid));
  }
}

const writes = fake.writes ?? [];

for (const item of writes) {
  const file = path.resolve(item.path);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, item.base64 ? Buffer.from(item.content, 'base64') : item.content);

  if (item.mode) {
    fs.chmodSync(file, Number.parseInt(item.mode, 8));
  }
}

const deletes = fake.deletes ?? [];

for (const item of deletes) {
  fs.rmSync(path.resolve(item), { force: true });
}

const symlinks = fake.symlinks ?? [];

for (const item of symlinks) {
  fs.symlinkSync(item.target, path.resolve(item.path));
}

if (fake.stderr) {
  process.stderr.write(`${fake.stderr}\n`);
}

process.stderr.write('(node:1) [DEP0169] DeprecationWarning: url.parse() behavior is not standardized\n');

if (fake.bigRecordBytes) {
  await out(JSON.stringify({ type: 'noise', data: 'x'.repeat(fake.bigRecordBytes) }) + '\n');
}

if (isCodex) {
  await out(JSON.stringify({ type: 'thread.started', thread_id: sessionId }) + '\n');
  await out(JSON.stringify({ type: 'turn.started' }) + '\n');
} else if (isCursor) {
  if (fake.cursorFail) {
    process.stderr.write(`${fake.cursorFail}\n`);
    process.exit(1);
  }

  await out(
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      apiKeySource: 'login',
      cwd: process.cwd(),
      session_id: sessionId,
      model: flagValue('--model'),
      permissionMode: 'default',
    }) + '\n',
  );
} else {
  await out(
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: sessionId,
      model: flagValue('--model'),
      permissionMode: flagValue('--permission-mode'),
      tools: ['Read'],
    }) + '\n',
  );
}

if (fake.flood) {
  const line = JSON.stringify({ type: 'flood', data: 'y'.repeat(1000) }) + '\n';

  for (let written = 0; written < fake.flood; written += line.length) {
    if (!process.stdout.write(line)) {
      await new Promise((resolve) => process.stdout.once('drain', resolve));
    }
  }
}

if (fake.hang) {
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}

if (fake.sleepMs) {
  await delay(fake.sleepMs);
}

if (fake.signal) {
  process.kill(process.pid, fake.signal);
  await delay(1000);
}

if (isCodex) {
  const lastFile = flagValue('-o');

  await out(
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'working ✓ — ünïcode' } }) + '\n',
  );

  if (fake.codexFail) {
    await out(JSON.stringify({ type: 'turn.failed', error: { message: fake.codexFail } }) + '\n');
    process.exit(fake.exitCode ?? 1);
  }

  if (lastFile) {
    fs.writeFileSync(lastFile, fake.malformed ? '{"taskId": ' : JSON.stringify(payload));
  }

  await out(
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 3 } }) +
      '\n',
  );
} else if (isCursor) {
  const preamble = 'Checking the workspace ✓ — ünïcode\n\n';
  const final = fake.malformed ? 'Done.\n```json\n{"taskId": 1}\n```' : JSON.stringify(payload);

  const shell = {
    shellToolCall: { args: { command: 'touch outside.txt' }, result: { rejected: { command: 'touch outside.txt' } } },
  };

  await out(JSON.stringify(message(preamble, { timestamp_ms: 1, model_call_id: 'm-1', session_id: sessionId })) + '\n');
  await out(JSON.stringify({ type: 'tool_call', subtype: 'started', tool_call: shell, session_id: sessionId }) + '\n');

  await out(
    JSON.stringify({ type: 'tool_call', subtype: 'completed', tool_call: shell, session_id: sessionId }) + '\n',
  );

  if (!fake.cursorToolLast) {
    await out(JSON.stringify(message(final, { session_id: sessionId })) + '\n');
  }

  const result = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 5,
    result: preamble + (fake.cursorToolLast ? '' : final),
    session_id: sessionId,
    request_id: 'req-fake',
    usage: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 0 },
  };

  await out(JSON.stringify(result) + '\n');
} else {
  const subtype = fake.claudeSubtype ?? 'success';
  const ok = subtype === 'success';

  const result = {
    type: 'result',
    subtype,
    is_error: !ok,
    session_id: sessionId,
    num_turns: 2,
    total_cost_usd: 0.05,
    usage: { input_tokens: 10, output_tokens: 3 },
    permission_denials: [],
    result: fake.malformed ? 'not json' : JSON.stringify(payload),
    ...(ok && !fake.malformed ? { structured_output: payload } : {}),
  };

  await out(JSON.stringify(result) + '\n');

  if (!ok) {
    process.exit(fake.exitCode ?? 1);
  }
}

process.exit(fake.resultThenFail ? 1 : (fake.exitCode ?? 0));
