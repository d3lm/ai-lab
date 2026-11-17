import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Store } from '../scripts/lib/store.mjs';
import { Supervisor, cleanupRun, createRun } from '../scripts/lib/supervisor.mjs';
import {
  codexProfile,
  eventually,
  fakePrompt,
  isAlive,
  makeTemporaryDir,
  makeTemporaryRepository,
  runCli,
  spawnCli,
  writeManifest,
} from './helpers.mjs';

function setup(t) {
  const dir = makeTemporaryDir(t);
  const repository = makeTemporaryRepository(t);

  fs.symlinkSync(repository, path.join(dir, 'repo'));

  return { dir, repository, runs: path.join(dir, 'runs'), env: { ...process.env } };
}

async function create(context, spec) {
  const file = writeManifest(context.dir, { profiles: { codex: codexProfile() }, ...spec });
  const { runDir } = await createRun(file, { runsRoot: context.runs, env: context.env });

  return runDir;
}

async function supervise(context, runDir) {
  const supervisor = new Supervisor(runDir, { env: context.env, pollMs: 25 });

  try {
    return await supervisor.supervise();
  } finally {
    supervisor.close();
  }
}

function openStore(runDir, { readOnly = true } = {}) {
  return Store.open(path.join(runDir, 'state.sqlite'), { readOnly });
}

function slowCheck(marker, effect, effectMs = 3000) {
  const code = [
    'const fs = require("node:fs");',
    'fs.writeFileSync(process.argv[1], String(process.pid));',
    `setTimeout(() => fs.writeFileSync(process.argv[2], "completed"), ${effectMs});`,
    `setTimeout(() => {}, ${effectMs + 2000});`,
  ].join('');

  return { name: 'slow', argv: [process.execPath, '-e', code, marker, effect], timeoutMs: 20_000 };
}

test('tasks listed before their dependencies are created completely and run in dependency order', async (t) => {
  const context = setup(t);

  const runDir = await create(context, {
    tasks: [
      { id: 'consumer', profile: 'codex', dependsOn: ['producer'] },
      { id: 'producer', profile: 'codex' },
    ],
  });

  const store = openStore(runDir);

  assert.deepEqual(
    store.tasks().map((task) => task.id),
    ['consumer', 'producer'],
  );

  assert.deepEqual(store.dependencies('consumer'), ['producer']);
  store.close();

  const result = await supervise(context, runDir);

  assert.equal(result.outcome, 'succeeded');

  const after = openStore(runDir);
  const producerEnd = Date.parse(after.attempts('producer')[0].ended_at);
  const consumerStart = Date.parse(after.attempts('consumer')[0].created_at);

  after.close();
  assert.ok(consumerStart >= producerEnd, 'the consumer started after its producer finished');
});

test('a run whose stored tasks do not match its manifest is refused instead of reported as succeeded', async (t) => {
  const context = setup(t);

  const runDir = await create(context, {
    tasks: [
      { id: 'producer', profile: 'codex' },
      { id: 'consumer', profile: 'codex', dependsOn: ['producer'] },
    ],
  });

  // simulate a database published before its tasks were written
  const store = openStore(runDir, { readOnly: false });

  store.db.exec('DELETE FROM task_deps; DELETE FROM tasks;');
  store.close();

  assert.throws(() => new Supervisor(runDir, { env: context.env }), /holds 0 of the manifest's 2 tasks/);

  const recovered = runCli(['recover', runDir]);

  assert.equal(recovered.code, 64, recovered.stderr);
  assert.match(recovered.stderr, /not created completely/);
});

test('cancelling a task during verification stops its check and the task ends cancelled', async (t) => {
  const context = setup(t);
  const marker = path.join(context.dir, 'check-started');
  const effect = path.join(context.dir, 'check-completed');

  const runDir = await create(context, {
    tasks: [{ id: 'one', profile: 'codex', verify: [slowCheck(marker, effect)] }],
  });

  const supervisor = new Supervisor(runDir, { env: context.env, pollMs: 25 });

  t.after(() => supervisor.close());

  const pending = supervisor.supervise();

  assert.ok(await eventually(() => fs.existsSync(marker), 60_000), 'the check started');

  const pid = Number(fs.readFileSync(marker, 'utf8'));

  supervisor.store.enqueueControl({ kind: 'cancel', taskId: 'one' });

  const result = await pending;

  assert.equal(result.outcome, 'cancelled');
  assert.equal(supervisor.store.task('one').state, 'cancelled');
  assert.equal(isAlive(pid), false, 'the check process was stopped');

  await new Promise((resolve) => setTimeout(resolve, 3500));
  assert.equal(fs.existsSync(effect), false, 'the check never finished its work');
});

test('reaching the run deadline during verification stops the check and fails the task', async (t) => {
  const context = setup(t);
  const marker = path.join(context.dir, 'check-started');
  const effect = path.join(context.dir, 'check-completed');

  const runDir = await create(context, {
    limits: { terminateGraceMs: 100 },
    tasks: [{ id: 'one', profile: 'codex', verify: [slowCheck(marker, effect, 8000)] }],
  });

  const result = await superviseUntilDeadline(context, runDir, marker);

  assert.equal(result.outcome, 'failed');
  assert.notEqual(result.exitCode, 0);

  const store = openStore(runDir);
  const task = store.task('one');

  assert.equal(task.state, 'failed');
  assert.equal(task.failure_class, 'budget');
  assert.match(task.failure_message, /run deadline exceeded/);
  assert.equal(store.run().dispatch_stopped, 'run-deadline');
  store.close();

  assert.equal(isAlive(Number(fs.readFileSync(marker, 'utf8'))), false, 'the check process was stopped');
  assert.equal(fs.existsSync(effect), false);
});

test('after a supervisor crash during a check, recovery stops the orphaned check before running it again', async (t) => {
  const context = setup(t);
  const log = path.join(context.dir, 'check-invocations.jsonl');
  const env = { ORCHESTRATOR_LEASE_MS: '1500' };

  // each invocation records itself and which earlier invocations are still alive
  const code = [
    'const fs = require("node:fs");',
    'const file = process.argv[1];',
    'let old = [];',
    String.raw`try { old = fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse); } catch {}`,
    'const live = old.filter((x) => { try { process.kill(x.pid, 0); return true; } catch { return false; } });',
    String.raw`fs.appendFileSync(file, JSON.stringify({ pid: process.pid, live: live.map((x) => x.pid) }) + "\n");`,
    'setTimeout(() => {}, 4000);',
  ].join('');

  const manifest = writeManifest(context.dir, {
    profiles: { codex: codexProfile() },
    tasks: [{ id: 'one', profile: 'codex', verify: [{ name: 'slow', argv: [process.execPath, '-e', code, log] }] }],
  });

  const first = spawnCli(t, ['run', manifest, '--runs-root', context.runs], { env });

  assert.ok(await eventually(() => fs.existsSync(log), 60_000), 'the first check started');
  first.child.kill('SIGKILL');
  await first.done;

  const [name] = fs.readdirSync(context.runs);
  const runDir = path.join(context.runs, name);

  const leaseExpired = await eventually(() => {
    const store = openStore(runDir);

    try {
      return store.run().lease_expires_at < Date.now();
    } finally {
      store.close();
    }
  }, 30_000);

  assert.ok(leaseExpired, 'the crashed supervisor lease expired');

  const recovered = runCli(['recover', runDir], { env });

  assert.equal(recovered.code, 0, recovered.stderr);

  const invocations = fs
    .readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

  assert.equal(invocations.length, 2, 'the check ran again after recovery');
  assert.deepEqual(invocations[1].live, [], 'the orphaned check was stopped before the second one started');
  assert.equal(isAlive(invocations[0].pid), false);
});

test('cleanup removes a worktree only while its patch artifact is intact and holds every change in it', async (t) => {
  const context = setup(t);

  const runDir = await create(context, {
    tasks: [{ id: 'one', profile: 'codex', fake: { writes: [{ path: 'unique.txt', content: 'only copy\n' }] } }],
  });

  const { outcome } = await supervise(context, runDir);

  assert.equal(outcome, 'succeeded');

  const store = openStore(runDir);
  const attempt = store.attempts('one').at(-1);
  const artifact = store.artifacts(attempt.id).find((item) => item.kind === 'patch');

  store.close();

  const workspace = attempt.workspace_path;
  const manual = path.join(workspace, 'manual.txt');

  // a change made after the attempt finished is not in the artifact
  fs.writeFileSync(manual, 'added later\n');

  let result = await cleanupRun(runDir);

  assert.deepEqual(result.removed, []);
  assert.match(result.kept[0].reason, /changes that patch artifact .* does not contain/);
  assert.ok(fs.existsSync(manual));

  fs.rmSync(manual);

  // a missing artifact preserves nothing
  const moved = `${artifact.path}.moved`;

  fs.renameSync(artifact.path, moved);

  result = await cleanupRun(runDir);

  assert.deepEqual(result.removed, []);
  assert.match(result.kept[0].reason, /missing or does not match its recorded hash/);
  assert.ok(fs.existsSync(workspace));

  fs.renameSync(moved, artifact.path);

  result = await cleanupRun(runDir);

  assert.deepEqual(result.removed, [workspace]);
  assert.equal(fs.existsSync(workspace), false);
});

test("an in-place continuation's artifact contains the changes of every attempt", async (t) => {
  const context = setup(t);

  const runDir = await create(context, {
    input: { root: context.repository, snapshot: 'none' },
    tasks: [
      {
        id: 'one',
        profile: 'codex',
        workspace: 'in-place',
        fake: { status: 'blocked', writes: [{ path: 'first.txt', content: 'first\n' }] },
      },
    ],
  });

  const first = await supervise(context, runDir);

  assert.equal(first.outcome, 'blocked');

  const control = openStore(runDir, { readOnly: false });

  control.enqueueControl({
    kind: 'continue',
    taskId: 'one',
    data: { promptText: fakePrompt({ writes: [{ path: 'second.txt', content: 'second\n' }] }) },
  });

  control.close();

  const continued = await supervise(context, runDir);

  assert.equal(continued.outcome, 'succeeded');

  const store = openStore(runDir);
  const attempt = store.attempts('one').at(-1);
  const artifact = store.artifacts(attempt.id).find((item) => item.kind === 'patch');

  store.close();

  assert.equal(attempt.kind, 'continuation');

  assert.deepEqual(
    artifact.data.changes.map((change) => change.path),
    ['first.txt', 'second.txt'],
  );
});

test("an in-place retry's artifact contains the changes of every attempt, so an earlier out-of-scope edit fails the task", async (t) => {
  const context = setup(t);

  const runDir = await create(context, {
    input: { root: context.repository, snapshot: 'none' },
    tasks: [
      {
        id: 'one',
        profile: 'codex',
        workspace: 'in-place',
        scope: ['src/**'],
        retry: { maxAttempts: 2, on: ['verification'], safeToRepeat: true, backoffMs: 0 },
        fake: {
          counterFile: path.join(context.dir, 'one.count'),
          perAttempt: [
            { writes: [{ path: 'outside.txt', content: 'outside\n' }] },
            { writes: [{ path: 'src/inside.js', content: 'inside\n' }] },
          ],
        },
      },
    ],
  });

  const { outcome } = await supervise(context, runDir);
  const store = openStore(runDir);
  const task = store.task('one');
  const attempt = store.attempts('one').at(-1);
  const artifact = store.artifacts(attempt.id).find((item) => item.kind === 'patch');

  store.close();

  assert.equal(attempt.number, 2);
  assert.ok(fs.existsSync(path.join(context.repository, 'outside.txt')), 'the first attempt left its edit in the root');

  assert.deepEqual(
    artifact.data.changes.map((change) => change.path),
    ['outside.txt', 'src/inside.js'],
  );

  assert.equal(outcome, 'failed');
  assert.equal(task.failure_class, 'verification');
  assert.match(task.failure_message, /outside the declared scope: outside\.txt/);
});

test('an unfinished in-place task keeps the input root, so each artifact holds only its own task changes', async (t) => {
  const context = setup(t);

  const runDir = await create(context, {
    input: { root: context.repository, snapshot: 'none' },
    tasks: [
      {
        id: 'first',
        profile: 'codex',
        workspace: 'in-place',
        scope: ['first/**'],
        fake: { status: 'blocked', writes: [{ path: 'first/partial.txt', content: 'partial\n' }] },
      },
      {
        id: 'second',
        profile: 'codex',
        workspace: 'in-place',
        scope: ['second/**'],
        fake: { writes: [{ path: 'second/file.txt', content: 'second\n' }] },
      },
    ],
  });

  const blocked = await supervise(context, runDir);
  const held = openStore(runDir);

  assert.equal(blocked.outcome, 'blocked');
  assert.equal(held.task('second').state, 'ready', 'the second task waits for the root');
  assert.equal(held.attempts('second').length, 0);

  assert.deepEqual(
    held.eventsOfType('dispatch.decision').at(-1).data.deferred,
    [{ task: 'second', reason: 'task first holds the input root until it finishes' }],
    'the deferral names the task that holds the root',
  );

  held.close();

  const control = openStore(runDir, { readOnly: false });

  control.enqueueControl({
    kind: 'continue',
    taskId: 'first',
    data: { promptText: fakePrompt({ writes: [{ path: 'first/done.txt', content: 'done\n' }] }) },
  });

  control.close();

  const continued = await supervise(context, runDir);

  assert.equal(continued.outcome, 'succeeded');

  const store = openStore(runDir);

  const changesOf = (id) =>
    store
      .artifacts(store.task(id).result_attempt_id)
      .find((item) => item.kind === 'patch')
      .data.changes.map((change) => change.path);

  assert.deepEqual(changesOf('first'), ['first/done.txt', 'first/partial.txt']);
  assert.deepEqual(changesOf('second'), ['second/file.txt']);
  store.close();
});

async function superviseUntilDeadline(context, runDir, marker) {
  const supervisor = new Supervisor(runDir, { env: context.env, pollMs: 25 });

  try {
    const pending = supervisor.supervise();

    assert.ok(await eventually(() => fs.existsSync(marker), 60_000), 'the check started');
    supervisor.store.db.prepare('UPDATE runs SET deadline_at = ?').run(Date.now());

    return await pending;
  } finally {
    supervisor.close();
  }
}

function integrationRun(context, { effectMs = 3000 } = {}) {
  const marker = path.join(context.dir, 'check-started');
  const effect = path.join(context.dir, 'check-completed');

  return {
    marker,
    effect,
    runDir: create(context, {
      limits: { terminateGraceMs: 100 },
      tasks: [{ id: 'one', profile: 'codex' }],
      integration: { checks: [slowCheck(marker, effect, effectMs)] },
    }),
  };
}

test('cancelling the run during integration stops the integration check and the run ends cancelled', async (t) => {
  const context = setup(t);
  const made = integrationRun(context);
  const supervisor = new Supervisor(await made.runDir, { env: context.env, pollMs: 25 });

  t.after(() => supervisor.close());

  const pending = supervisor.supervise();

  assert.ok(await eventually(() => fs.existsSync(made.marker), 60_000), 'the integration check started');

  const pid = Number(fs.readFileSync(made.marker, 'utf8'));

  supervisor.store.enqueueControl({ kind: 'cancel' });

  const result = await pending;
  const integration = supervisor.store.latestIntegration();

  assert.equal(result.outcome, 'cancelled');
  assert.equal(supervisor.store.controls()[0].status, 'applied');
  assert.equal(integration.status, 'failed');
  assert.equal(integration.detail.stoppedBy, 'cancelled');
  assert.equal(isAlive(pid), false, 'the integration check was stopped');

  await new Promise((resolve) => setTimeout(resolve, 3500));
  assert.equal(fs.existsSync(made.effect), false, 'the integration check never finished its work');
});

test('reaching the run deadline during integration stops the integration check and fails the run', async (t) => {
  const context = setup(t);
  const made = integrationRun(context, { effectMs: 8000 });
  const runDir = await made.runDir;
  const result = await superviseUntilDeadline(context, runDir, made.marker);

  assert.equal(result.outcome, 'failed');

  const store = openStore(runDir);
  const integration = store.latestIntegration();

  assert.equal(integration.status, 'failed');
  assert.equal(integration.detail.stoppedBy, 'run-deadline');
  assert.ok(integration.detail.failures.includes('run deadline exceeded'));
  store.close();

  assert.equal(isAlive(Number(fs.readFileSync(made.marker, 'utf8'))), false, 'the integration check was stopped');
  assert.equal(fs.existsSync(made.effect), false);
});

test('after a supervisor crash during integration, recovery closes out the interrupted integration and runs a new one', async (t) => {
  const context = setup(t);
  const made = integrationRun(context, { effectMs: 8000 });
  const runDir = await made.runDir;
  const env = { ORCHESTRATOR_LEASE_MS: '1500' };

  const first = spawnCli(t, ['recover', runDir], { env });

  assert.ok(await eventually(() => fs.existsSync(made.marker), 60_000), 'the first integration check started');

  const orphan = Number(fs.readFileSync(made.marker, 'utf8'));

  first.child.kill('SIGKILL');
  await first.done;

  const leaseExpired = await eventually(() => {
    const store = openStore(runDir);

    try {
      return store.run().lease_expires_at < Date.now();
    } finally {
      store.close();
    }
  }, 30_000);

  assert.ok(leaseExpired, 'the crashed supervisor lease expired');
  fs.rmSync(made.marker);

  const recovered = runCli(['recover', runDir], { env });

  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal(isAlive(orphan), false, 'the orphaned integration check was stopped');

  const store = openStore(runDir);
  const [interrupted, rerun] = store.integrations();

  store.close();

  assert.equal(interrupted.status, 'error');
  assert.equal(interrupted.detail.number, 1);
  assert.match(interrupted.detail.error, /interrupted before it recorded a result/);
  assert.equal(fs.existsSync(interrupted.detail.workspace), false, 'the interrupted workspace was replaced');

  assert.equal(rerun.status, 'passed');
  assert.equal(rerun.detail.number, 2);
  assert.ok(fs.existsSync(rerun.detail.workspace));
});

for (const command of ['recover past the deadline', 'cancel']) {
  test(`${command} after a crash during integration stops the orphaned integration check`, async (t) => {
    const context = setup(t);
    const made = integrationRun(context, { effectMs: 30_000 });
    const runDir = await made.runDir;
    const env = { ORCHESTRATOR_LEASE_MS: '1500' };

    const first = spawnCli(t, ['recover', runDir], { env });

    assert.ok(await eventually(() => fs.existsSync(made.marker), 60_000), 'the integration check started');

    const orphan = Number(fs.readFileSync(made.marker, 'utf8'));

    first.child.kill('SIGKILL');
    await first.done;

    if (command === 'cancel') {
      assert.ok(
        await eventually(() => {
          const store = openStore(runDir);

          try {
            return store.run().lease_expires_at < Date.now();
          } finally {
            store.close();
          }
        }, 30_000),
        'the crashed supervisor lease expired',
      );
    } else {
      const store = openStore(runDir, { readOnly: false });

      store.db.prepare('UPDATE runs SET deadline_at = ?, lease_expires_at = 0').run(Date.now() - 1);
      store.close();
    }

    const next = runCli(command === 'cancel' ? ['cancel', runDir] : ['recover', runDir], { env });

    assert.equal(next.code, command === 'cancel' ? 4 : 1, next.stderr);
    assert.equal(isAlive(orphan), false, 'the orphaned integration check was stopped');

    const store = openStore(runDir);
    const [interrupted] = store.integrations();

    store.close();
    assert.equal(interrupted.status, 'error');
    assert.match(interrupted.detail.error, /interrupted before it recorded a result/);
  });
}

for (const stop of ['cancelled', 'run-deadline']) {
  test(`a ${stop} stop recorded before the final integration write outranks a passing result`, async (t) => {
    const context = setup(t);
    const made = integrationRun(context);
    const supervisor = new Supervisor(await made.runDir, { env: context.env, pollMs: 25 });

    t.after(() => supervisor.close());
    supervisor.store.acquireLease({ token: 'test', leaseMs: 60_000 });

    // the stop lands after every asynchronous step of the integration has finished
    if (stop === 'cancelled') {
      supervisor.store.db.prepare('UPDATE runs SET cancel_requested = 1').run();
    } else {
      supervisor.store.db.prepare('UPDATE runs SET deadline_at = ?').run(Date.now() - 1);
    }

    supervisor.recordIntegration('passed', { number: 1, failures: [], stoppedBy: null });

    const integration = supervisor.store.latestIntegration();

    assert.equal(integration.status, 'failed');
    assert.equal(integration.detail.stoppedBy, stop);
    assert.ok(integration.detail.failures.length > 0);
  });
}
