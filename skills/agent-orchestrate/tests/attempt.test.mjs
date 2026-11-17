import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AttemptRunner } from '../scripts/lib/attempt.mjs';
import { DEFAULT_LIMITS, GENERIC_RESULT_SCHEMA, protocolFooter, randomIds } from '../scripts/lib/contracts.mjs';
import { Store } from '../scripts/lib/store.mjs';
import {
  claudeProfile,
  codexProfile,
  cursorProfile,
  eventually,
  fakePrompt,
  isAlive,
  makeTemporaryDir,
} from './helpers.mjs';

const SCHEMA = fs.readFileSync(GENERIC_RESULT_SCHEMA, 'utf8');

function setup(t, limits = {}, hostEnv = process.env) {
  const runDir = makeTemporaryDir(t);
  const dbFile = path.join(runDir, 'state.sqlite');
  const store = Store.create(dbFile, { id: 'run-1', kind: 'test', label: 'attempt test', runDir });

  store.acquireLease({ token: 'owner-1', leaseMs: 60_000 });

  const runner = new AttemptRunner({
    store,
    runDir,
    ids: randomIds(),
    limits: { ...DEFAULT_LIMITS, terminateGraceMs: 1000, ...limits },
    ownerDb: dbFile,
    env: hostEnv,
  });

  let counter = 0;

  t.after(() => store.close());

  const run = async ({ profile, directive = {}, deadlineMs = 20_000, readOnly = false, onLaunched = null }) => {
    const taskId = `task-${++counter}`;

    store.ownerTx(() => store.insertTask({ id: taskId, ord: counter, spec: {}, state: 'ready' }));

    let attempt = runner.reserve({
      taskId,
      fromState: 'ready',
      kind: 'initial',
      session: { name: `${taskId}.1`, adapter: profile.adapter, profile: 'p' },
      profile,
      promptText: 'placeholder',
      schemaText: SCHEMA,
    });

    // the prompt includes the supervisor-allocated ids, as the scheduler does
    fs.writeFileSync(
      attempt.profile.files.prompt,
      fakePrompt(directive) + protocolFooter({ taskId, attemptId: attempt.id, kind: 'initial' }),
    );

    runner.launch(attempt, { cwd: runDir, deadlineMs, isGitRepo: false });

    if (onLaunched) {
      await onLaunched(store.attempt(attempt.id));
    }

    const observed = await runner.waitForExit(attempt.id);

    assert.ok(observed.exit, 'exit receipt expected');

    attempt = runner.ingestExit(store.attempt(attempt.id), observed.exit);

    return { attempt, evaluation: runner.evaluate(attempt, { generic: true, taskId, readOnly }) };
  };

  return { store, runner, run, runDir, dbFile };
}

test('claude success yields a validated payload and records the session', async (t) => {
  const { run, store } = setup(t);
  const { attempt, evaluation } = await run({ profile: claudeProfile(), directive: { sessionId: 'sess-42' } });

  assert.equal(evaluation.ok, true, evaluation.message);
  assert.equal(evaluation.payload.status, 'done');
  assert.equal(evaluation.provider.costUsd, 0.05);
  assert.equal(attempt.exit.code, 0);
  assert.equal(store.session(attempt.session_name).provider_session_id, 'sess-42');
  assert.ok(attempt.provider.identity.startTime, 'provider identity recorded');
});

test('a stop signal that reaches the host while it writes its exit receipt does not cost the receipt', async (t) => {
  // the host sends itself SIGTERM just before the receipt, as a cancelling or recovering supervisor could
  const { run } = setup(t, {}, { ...process.env, ORCHESTRATOR_FAULT: 'before-exit-receipt:SIGTERM' });
  const { attempt, evaluation } = await run({ profile: claudeProfile() });

  assert.equal(evaluation.ok, true, evaluation.message);
  assert.equal(attempt.exit.terminalReason, 'exited');
});

test('a stop request that arrives after the provider exited on its own does not change how the attempt ended', async (t) => {
  // the host signals itself once the provider is gone, while it still stops the descendant the provider left
  const { run } = setup(t, {}, { ...process.env, ORCHESTRATOR_FAULT: 'after-provider-exit:SIGTERM' });
  const { attempt, evaluation } = await run({ profile: claudeProfile(), directive: { child: 'attached' } });

  assert.equal(attempt.exit.descendants.present, true, 'the host was still stopping a descendant');
  assert.equal(attempt.exit.terminalReason, 'exited');
  assert.equal(evaluation.ok, true, evaluation.message);
});

test('codex success requires turn.completed and a valid final message', async (t) => {
  const { run } = setup(t);
  const { evaluation } = await run({ profile: codexProfile(), directive: { sessionId: 'thread-7' } });

  assert.equal(evaluation.ok, true, evaluation.message);
  assert.equal(evaluation.provider.sessionId, 'thread-7');
  assert.deepEqual(evaluation.provider.usage, { input_tokens: 10, cached_input_tokens: 4, output_tokens: 3 });
});

test('cursor success takes the final message as the payload and records the chat as the session', async (t) => {
  const { run, store } = setup(t);
  const { attempt, evaluation } = await run({ profile: cursorProfile(), directive: { sessionId: 'chat-9' } });

  assert.equal(evaluation.ok, true, evaluation.message);
  assert.equal(evaluation.payload.status, 'done');
  assert.equal(evaluation.provider.costUsd, null, 'unknown cost is null, never zero');
  assert.deepEqual(evaluation.provider.permissionDenials, ['Shell']);
  assert.equal(store.session(attempt.session_name).provider_session_id, 'chat-9');
});

test('a cursor failure without a result record is classified from stderr', async (t) => {
  const { run } = setup(t);

  const { evaluation } = await run({
    profile: cursorProfile(),
    directive: { cursorFail: 'Cannot use this model: cursor-test. Available models: auto' },
  });

  assert.equal(evaluation.ok, false);
  assert.equal(evaluation.failureClass, 'launch');
  assert.match(evaluation.message, /code 1; cursor-agent: Cannot use this model/);

  const toolLast = await run({ profile: cursorProfile(), directive: { cursorToolLast: true } });

  assert.equal(toolLast.evaluation.failureClass, 'protocol');
});

test('a valid-looking payload cannot override a nonzero exit', async (t) => {
  const { run } = setup(t);

  for (const profile of [claudeProfile(), codexProfile(), cursorProfile()]) {
    const { evaluation } = await run({ profile, directive: { resultThenFail: true } });

    assert.equal(evaluation.ok, false);
    assert.match(evaluation.message, /code 1/);
  }
});

test('a signal is recorded and fails the attempt', async (t) => {
  const { run } = setup(t);
  const { attempt, evaluation } = await run({ profile: claudeProfile(), directive: { signal: 'SIGKILL' } });

  assert.equal(attempt.exit.signal, 'SIGKILL');
  assert.equal(evaluation.ok, false);
  assert.match(evaluation.message, /signal SIGKILL/);
});

test('malformed results and wrong ids are protocol failures', async (t) => {
  const { run } = setup(t);

  for (const profile of [claudeProfile(), codexProfile(), cursorProfile()]) {
    const malformed = await run({ profile, directive: { malformed: true } });

    assert.equal(malformed.evaluation.failureClass, 'protocol');

    const wrong = await run({ profile, directive: { wrongIds: true } });

    assert.equal(wrong.evaluation.failureClass, 'protocol');
    assert.match(wrong.evaluation.message, /expected/);
  }
});

test('schema violations are rejected even when the provider reports success', async (t) => {
  const { run } = setup(t);
  const { evaluation } = await run({ profile: claudeProfile(), directive: { payload: { status: 'done' } } });

  assert.equal(evaluation.failureClass, 'protocol');
  assert.match(evaluation.message, /schema/);
});

test('provider-reported budget exhaustion and turn failures are classified', async (t) => {
  const { run } = setup(t);
  const budget = await run({ profile: claudeProfile(), directive: { claudeSubtype: 'error_max_budget_usd' } });

  assert.equal(budget.evaluation.failureClass, 'budget');

  const failed = await run({
    profile: codexProfile(),
    directive: { codexFail: 'stream disconnected before completion' },
  });

  assert.equal(failed.evaluation.failureClass, 'transient');

  const auth = await run({ profile: codexProfile(), directive: { codexFail: '401 Unauthorized' } });

  assert.equal(auth.evaluation.failureClass, 'auth');
});

test('a hung worker is stopped at its deadline', async (t) => {
  const { run } = setup(t);
  const { attempt, evaluation } = await run({ profile: claudeProfile(), directive: { hang: true }, deadlineMs: 1500 });

  assert.equal(attempt.exit.terminalReason, 'deadline');
  assert.equal(evaluation.failureClass, 'budget');
  assert.equal(isAlive(attempt.provider.pid), false);
});

test('owned descendants are stopped after the provider exits', async (t) => {
  const { run, runDir } = setup(t);
  const childPidFile = path.join(runDir, 'child.pid');

  const { attempt, evaluation } = await run({
    profile: claudeProfile(),
    directive: { child: 'attached', childPidFile },
  });

  const childPid = Number(fs.readFileSync(childPidFile, 'utf8'));

  assert.equal(attempt.exit.descendants.present, true);
  assert.equal(attempt.exit.descendants.stopped, true);
  assert.ok(await eventually(() => !isAlive(childPid)), 'descendant should be stopped');
  assert.equal(evaluation.ok, true, evaluation.message);
});

test('cancellation stops the provider and reports cancelled', async (t) => {
  const { run, runner } = setup(t);

  const { attempt, evaluation } = await run({
    profile: codexProfile(),
    directive: { hang: true },
    onLaunched: async (launched) => {
      assert.ok(await eventually(() => fs.existsSync(launched.profile.files.provider)));
      assert.equal(runner.requestCancel(launched, 'cancelled'), 'requested');
    },
  });

  assert.equal(attempt.exit.terminalReason, 'cancelled');
  assert.equal(evaluation.outcome, 'cancelled');
  assert.equal(isAlive(attempt.provider.pid), false);
});

test('an output flood is bounded and becomes a resource failure', async (t) => {
  const { run } = setup(t, { maxStdoutBytes: 64 * 1024 });

  const { attempt, evaluation } = await run({
    profile: claudeProfile(),
    directive: { flood: 1024 * 1024, hang: true },
  });

  assert.equal(attempt.exit.terminalReason, 'output-limit');
  assert.ok(fs.statSync(attempt.profile.files.stdout).size <= 64 * 1024);
  assert.equal(evaluation.failureClass, 'budget');
});

test('split records, unicode, stderr noise, and an oversized unrelated record do not decide success', async (t) => {
  const { run } = setup(t, { maxRecordBytes: 4096 });

  const { attempt, evaluation } = await run({
    profile: codexProfile(),
    directive: { chunked: true, bigRecordBytes: 10_000, stderr: 'MCP OAuth refresh failed' },
  });

  assert.equal(evaluation.ok, true, evaluation.message);
  assert.equal(attempt.exit.protocolErrors, 1);
});

test('a missing executable is a launch failure', async (t) => {
  const { run } = setup(t);
  const { evaluation } = await run({ profile: claudeProfile({ executable: ['/nonexistent/claude'] }) });

  assert.equal(evaluation.failureClass, 'launch');
});

test('a host cancels its provider when supervisor ownership moves to another generation', async (t) => {
  const { run, dbFile, store } = setup(t);

  const result = await run({
    profile: claudeProfile(),
    directive: { hang: true },
    onLaunched: async (launched) => {
      assert.ok(await eventually(() => fs.existsSync(launched.profile.files.provider)));

      const intruder = Store.open(dbFile);

      intruder.acquireLease({ token: 'owner-2', leaseMs: 60_000, allowSteal: true });
      intruder.close();

      // take the run back under a newer generation while the host still holds the old one
      store.acquireLease({ token: 'owner-1', leaseMs: 60_000, allowSteal: true });
    },
  });

  assert.equal(result.attempt.exit.terminalReason, 'owner-lost');
  assert.equal(result.evaluation.outcome, 'uncertain');
  assert.equal(isAlive(result.attempt.provider.pid), false);
});
