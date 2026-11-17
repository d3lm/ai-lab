import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Store } from '../scripts/lib/store.mjs';
import { openWorkflow } from '../scripts/lib/workflow.mjs';
import {
  claudeProfile,
  codexProfile,
  eventually,
  fakePrompt,
  isAlive,
  makeTemporaryDir,
  readFakeLog,
} from './helpers.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'workflow-script.mjs');

function setup(t) {
  const dir = makeTemporaryDir(t);
  const runDir = path.join(dir, 'run');
  const schemaFile = path.join(dir, 'schema.json');
  const fakeLog = path.join(dir, 'fake.log');

  fs.mkdirSync(runDir);

  fs.writeFileSync(
    schemaFile,
    JSON.stringify({ type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } }),
  );

  const turn = (step, { profile = codexProfile({ sandbox: 'read-only' }), directive = {}, ...rest } = {}) => {
    return {
      step,
      session: 'reviewer',
      profile,
      promptText: fakePrompt({ payload: { ok: true }, ...directive }),
      schemaFile,
      files: {
        prompt: path.join(runDir, `${step}.prompt.md`),
        stdout: path.join(runDir, `${step}.out.jsonl`),
        stderr: path.join(runDir, `${step}.err.log`),
      },
      cwd: dir,
      isGitRepo: false,
      readOnly: true,
      deadlineMs: 60_000,
      ...rest,
    };
  };

  const open = async (options = {}) => {
    const workflow = await openWorkflow({
      runDir,
      kind: 'test',
      label: 'workflow test',
      env: { ...process.env, FAKE_LOG: fakeLog },
      ...options,
    });

    // a test that fails before it closes the workflow must not leave the lease heartbeat and signal handlers behind
    t.after(() => {
      try {
        workflow.close();
      } catch {
        // the test already closed it
      }
    });

    return workflow;
  };

  // probes carry no prompt, so only real turns remain
  const invocations = () => readFakeLog(fakeLog).filter((entry) => entry.stdin.trim() !== '');

  return { dir, runDir, turn, open, invocations };
}

async function startHangingScript(t, context, turn, env = {}) {
  const specFile = path.join(context.dir, 'turn.json');

  fs.writeFileSync(specFile, JSON.stringify(turn));

  const child = spawn(process.execPath, [SCRIPT, context.runDir, specFile], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  t.after(() => child.kill('SIGKILL'));

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });

  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const closed = new Promise((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });

  const attempts = path.join(context.runDir, 'tasks', turn.step, 'attempts');

  let providerPid = null;

  const started = await eventually(() => {
    const [id] = fs.existsSync(attempts) ? fs.readdirSync(attempts) : [];
    const receipt = id && path.join(attempts, id, 'provider.json');

    providerPid = receipt && fs.existsSync(receipt) ? JSON.parse(fs.readFileSync(receipt, 'utf8')).pid : null;

    return providerPid !== null;
  });

  assert.ok(started, 'the provider of the turn started');

  return { child, closed, providerPid };
}

test('a finished turn that no checkpoint consumed is replayed on resume, and a consumed one runs again', async (t) => {
  const context = setup(t);
  const first = await context.open();
  const original = await first.runTurn(context.turn('review-1'));

  assert.equal(original.ok, true, JSON.stringify(original.failure));
  assert.equal(original.replayed, false);
  assert.deepEqual(original.payload, { ok: true });
  first.close();

  const second = await context.open({ resume: true });

  assert.equal(second.latestCheckpoint(), null);

  const replayed = await second.runTurn(context.turn('review-1'));

  assert.equal(replayed.replayed, true);
  assert.equal(replayed.attemptId, original.attemptId);
  assert.deepEqual(replayed.payload, { ok: true });
  assert.equal(context.invocations().length, 1, 'the provider ran once for the two calls');

  second.checkpoint({ position: 1, notes: ['kept'] }, [replayed.taskId]);
  second.close();

  const third = await context.open({ resume: true });

  assert.deepEqual(third.latestCheckpoint().state, { position: 1, notes: ['kept'] });
  assert.deepEqual(third.latestCheckpoint().consumed, [original.taskId]);

  const rerun = await third.runTurn(context.turn('review-1'));

  assert.equal(rerun.ok, true, JSON.stringify(rerun.failure));
  assert.equal(rerun.replayed, false);
  assert.equal(rerun.taskId, 'review-1~2');

  const [, resumed] = context.invocations();

  assert.deepEqual(resumed.argv.slice(0, 3), ['exec', 'resume', 'thread-fake'], 'the named session is resumed');
  third.finish('done');
  third.close();

  const store = Store.open(path.join(context.runDir, 'state.sqlite'), { readOnly: true });

  assert.equal(store.run().outcome, 'done');
  assert.equal(store.run().status, 'finished');
  store.close();
});

test('resume needs a run of the same kind, and a fresh open sets the previous state aside', async (t) => {
  const context = setup(t);
  const empty = path.join(context.dir, 'empty');

  fs.mkdirSync(empty);

  await assert.rejects(
    openWorkflow({ runDir: empty, kind: 'test', label: 'none', resume: true }),
    /has no state\.sqlite, so there is no run to resume/,
  );

  const first = await context.open();

  await first.runTurn(context.turn('review-1'));
  first.close();

  await assert.rejects(context.open({ kind: 'other', resume: true }), /is a test run, not other/);

  const fresh = await context.open();

  assert.equal(fresh.recordedTurn('review-1'), null, 'a fresh run starts without the earlier turns');
  fresh.close();

  const archived = fs.readdirSync(context.runDir).filter((name) => /^state\.\d{8}T\d+Z\.sqlite$/.test(name));

  assert.equal(archived.length, 1, 'the earlier state is kept under a dated name');
});

test('the first interrupt stops the running worker, fails its turn as cancelled, and lets the script finish', async (t) => {
  const context = setup(t);

  const turn = context.turn('edit-1', {
    profile: claudeProfile(),
    directive: { hang: true },
    readOnly: false,
  });

  const { child, closed, providerPid } = await startHangingScript(t, context, turn);

  child.kill('SIGINT');

  const { code, stdout, stderr } = await closed;

  assert.equal(code, 0, `the script ran to its end after the interrupt: ${stderr}`);

  const result = JSON.parse(stdout);

  assert.equal(result.ok, false);
  assert.equal(result.failure.class, 'cancellation');
  assert.equal(result.exit.terminalReason, 'cancelled');
  assert.equal(isAlive(providerPid), false, 'the worker was stopped');
});

test('a read-only turn whose script was killed is settled on resume, and the step then runs again', async (t) => {
  const context = setup(t);
  const counterFile = path.join(context.dir, 'turn.count');

  const turn = context.turn('review-1', {
    directive: { counterFile, perAttempt: [{ hang: true }, {}] },
  });

  const { child, closed, providerPid } = await startHangingScript(t, context, turn, {
    ORCHESTRATOR_LEASE_MS: '1500',
  });

  // the worker takes its first directive when it writes the counter, and only then is the next invocation the second
  assert.ok(await eventually(() => fs.existsSync(counterFile)), 'the worker read its prompt');
  child.kill('SIGKILL');
  await closed;

  const leaseExpired = await eventually(() => {
    const store = Store.open(path.join(context.runDir, 'state.sqlite'), { readOnly: true });

    try {
      return store.run().lease_expires_at < Date.now();
    } finally {
      store.close();
    }
  });

  assert.ok(leaseExpired, 'the lease of the killed script expired');

  const workflow = await context.open({ resume: true });
  const interrupted = workflow.recordedTurn('review-1');

  assert.equal(interrupted.ok, false);
  assert.equal(interrupted.failure.class, 'transient', 'an interrupted read-only turn is not left uncertain');
  assert.equal(isAlive(providerPid), false, 'the orphaned worker was stopped');

  const rerun = await workflow.runTurn(turn);

  assert.equal(rerun.ok, true, JSON.stringify(rerun.failure));
  assert.equal(rerun.taskId, 'review-1~2');
  workflow.close();
});
