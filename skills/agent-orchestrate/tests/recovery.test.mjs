import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AttemptRunner } from '../scripts/lib/attempt.mjs';
import { DEFAULT_LIMITS, randomIds, sha256File } from '../scripts/lib/contracts.mjs';
import { checkIdentity, processIdentity, writeJsonAtomic } from '../scripts/lib/process.mjs';
import { Store } from '../scripts/lib/store.mjs';
import {
  codexProfile,
  eventually,
  fakePrompt,
  isAlive,
  readFakeLog,
  runCli,
  spawnCli,
  makeTemporaryDir,
  makeTemporaryRepository,
  writeManifest,
} from './helpers.mjs';

/**
 * A host whose supervisor died cancels its provider once the lease has been gone for the grace
 * period, which with this lease is about 7.5 s after the crash. The tests that let such a host
 * finish on its own need that margin on a busy machine.
 */
const LEASE_MS = '3000';

function setup(t) {
  const dir = makeTemporaryDir(t);
  const repository = makeTemporaryRepository(t);

  fs.symlinkSync(repository, path.join(dir, 'repo'));

  const fakeLog = path.join(dir, 'fake.log');

  return {
    dir,
    repository,
    fakeLog,
    runs: path.join(dir, 'runs'),
    env: { FAKE_LOG: fakeLog, ORCHESTRATOR_LEASE_MS: LEASE_MS },
  };
}

function onlyRunDir(runs) {
  const [name] = fs.readdirSync(runs);

  return path.join(runs, name);
}

function readStatus(runDir) {
  const result = runCli(['status', runDir, '--json']);

  return JSON.parse(result.stdout);
}

function invocations(context, taskId) {
  return readFakeLog(context.fakeLog).filter((entry) => entry.stdin.includes(`Task id: \`${taskId}\``));
}

async function waitForLeaseExpiry(runDir) {
  assert.ok(await eventually(() => !readStatus(runDir).lease.live), 'lease should expire');
}

function openStore(runDir) {
  return Store.open(path.join(runDir, 'state.sqlite'), { readOnly: true });
}

const editingTask = {
  id: 'edit',
  profile: 'claude',
  fake: { writes: [{ path: 'out.txt', content: 'out\n' }] },
  verify: [{ name: 'present', argv: ['test', '-f', 'out.txt'] }],
};

for (const point of [
  'after-reserve',
  'after-launch-record',
  'after-host-spawn',
  'after-exit-ingest',
  'during-verification',
  'before-finish',
]) {
  test(`a supervisor crash at ${point} recovers without rerunning accepted or completed work`, async (t) => {
    const context = setup(t);
    const manifest = writeManifest(context.dir, { tasks: [editingTask] });

    const crashed = runCli(['run', manifest, '--runs-root', context.runs], {
      env: { ...context.env, ORCHESTRATOR_FAULT: point },
    });

    assert.equal(crashed.signal, 'SIGKILL', 'the supervisor was killed at the fault point');

    const runDir = onlyRunDir(context.runs);

    if (point === 'after-host-spawn') {
      // the detached host keeps running and writes its exit receipt while no supervisor exists
      assert.ok(
        await eventually(() =>
          fs
            .readdirSync(path.join(runDir, 'tasks', 'edit', 'attempts'))
            .some((id) => fs.existsSync(path.join(runDir, 'tasks', 'edit', 'attempts', id, 'exit.json'))),
        ),
      );
    }

    await waitForLeaseExpiry(runDir);

    const recovered = runCli(['recover', runDir], { env: context.env });

    assert.equal(recovered.code, 0, recovered.stderr);

    const status = readStatus(runDir);
    const task = status.tasks[0];

    assert.equal(task.state, 'succeeded');
    assert.equal(invocations(context, 'edit').length, 1, 'the provider ran exactly once');

    const store = openStore(runDir);
    const actions = store.events({ limit: 10_000 }).filter((event) => event.type === 'recovery.action');

    store.close();
    assert.equal(actions.length, 1, 'recovery reconciled the unfinished attempt');
  });
}

test('a continuation interrupted before its provider starts runs again with the same prompt, session, and workspace', async (t) => {
  const context = setup(t);

  const manifest = writeManifest(context.dir, {
    tasks: [
      {
        id: 'edit',
        profile: 'claude',
        fake: { status: 'blocked', writes: [{ path: 'partial.txt', content: 'partial\n' }] },
      },
    ],
  });

  const blocked = runCli(['run', manifest, '--runs-root', context.runs], { env: context.env });

  assert.equal(blocked.code, 2, blocked.stderr);

  const runDir = onlyRunDir(context.runs);
  const answer = path.join(context.dir, 'answer.md');

  fs.writeFileSync(answer, fakePrompt({ writes: [{ path: 'done.txt', content: 'done\n' }] }, 'The operator answer.'));

  const crashed = runCli(['continue', runDir, '--task', 'edit', '--prompt-file', answer], {
    env: { ...context.env, ORCHESTRATOR_FAULT: 'after-reserve' },
  });

  assert.equal(crashed.signal, 'SIGKILL', 'the supervisor was killed after it reserved the continuation');
  await waitForLeaseExpiry(runDir);

  const recovered = runCli(['recover', runDir], { env: context.env });

  assert.equal(recovered.code, 0, recovered.stderr);

  const [initial, continuation, ...extra] = invocations(context, 'edit');

  assert.deepEqual(extra, [], 'the provider ran once for the blocked attempt and once for the continuation');
  assert.match(continuation.stdin, /The operator answer\./, 'the rerun carries the operator answer');
  assert.equal(continuation.argv[continuation.argv.indexOf('--resume') + 1], 'session-fake');
  assert.equal(continuation.cwd, initial.cwd, 'the rerun resumes in the blocked attempt workspace');

  const store = openStore(runDir);
  const attempts = store.attempts('edit');
  const patch = store.artifacts(attempts.at(-1).id).find((item) => item.kind === 'patch');

  store.close();

  assert.deepEqual(
    attempts.map((attempt) => [attempt.kind, attempt.outcome]),
    [
      ['initial', 'blocked'],
      ['continuation', 'interrupted'],
      ['continuation', 'succeeded'],
    ],
  );

  assert.deepEqual(
    patch.data.changes.map((change) => change.path),
    ['done.txt', 'partial.txt'],
  );
});

test('a recovery decision saves the partial change beside the attempt patch instead of replacing it', async (t) => {
  const context = setup(t);

  const manifest = writeManifest(context.dir, {
    limits: { terminateGraceMs: 500 },
    tasks: [{ id: 'edit', profile: 'claude', fake: { hang: true, writes: [{ path: 'half.txt', content: 'half\n' }] } }],
  });

  const running = spawnCli(t, ['run', manifest, '--runs-root', context.runs], { env: context.env });

  assert.ok(await eventually(() => fs.existsSync(context.runs) && fs.readdirSync(context.runs).length === 1));

  const runDir = onlyRunDir(context.runs);

  assert.ok(
    await eventually(() => {
      if (!fs.existsSync(path.join(runDir, 'state.sqlite'))) {
        return false;
      }

      const store = openStore(runDir);

      try {
        return Boolean(store.attempts('edit')[0]?.provider);
      } finally {
        store.close();
      }
    }),
    'the worker started',
  );

  running.child.kill('SIGKILL');
  await running.done;
  await waitForLeaseExpiry(runDir);

  const recovered = runCli(['recover', runDir], { env: context.env });

  assert.equal(recovered.code, 3, recovered.stderr);

  const before = openStore(runDir);
  const attempt = before.attempts('edit')[0];
  const recorded = before.artifacts(attempt.id).find((item) => item.kind === 'patch');
  const stateVersion = before.task('edit').state_version;

  before.close();
  assert.ok(recorded, 'the interrupted attempt recorded its candidate patch');

  // the operator changes the workspace while reconciling, so the partial change differs from the recorded patch
  fs.writeFileSync(path.join(attempt.workspace_path, 'salvaged.txt'), 'salvaged\n');

  const decision = path.join(context.dir, 'decision.json');

  fs.writeFileSync(
    decision,
    JSON.stringify({
      version: 1,
      decisions: [
        {
          taskId: 'edit',
          attemptId: attempt.id,
          stateVersion,
          evidence: 'inspected the workspace and kept one salvaged file',
          action: 'fail-preserving-artifacts',
        },
      ],
    }),
  );

  const decided = runCli(['recover', runDir, '--decision', decision], { env: context.env });

  assert.equal(decided.code, 1, decided.stderr);

  const after = openStore(runDir);
  const artifacts = after.artifacts(attempt.id);

  after.close();

  const patch = artifacts.find((item) => item.kind === 'patch');
  const partial = artifacts.find((item) => item.kind === 'partial-patch');

  assert.notEqual(partial.path, patch.path);
  assert.equal(sha256File(patch.path), patch.sha256, 'the attempt patch still matches its recorded hash');
  assert.equal(sha256File(partial.path), partial.sha256);

  assert.deepEqual(
    partial.data.changes.map((change) => change.path),
    ['half.txt', 'salvaged.txt'],
  );
});

test('release test: interrupting the supervisor mid-run preserves accepted work, never overlaps attempts, and surfaces uncertainty', async (t) => {
  const context = setup(t);
  const counter = (name) => path.join(context.dir, `${name}.count`);

  const manifest = writeManifest(context.dir, {
    limits: { concurrency: 3, terminateGraceMs: 500 },
    profiles: {
      claude: {
        adapter: 'claude-cli',
        executable: [process.execPath, path.resolve('tests/fixtures/fake-cli.mjs')],
        model: 'm',
        permissionMode: 'acceptEdits',
        permissionPrompts: 'none',
      },
      reader: codexProfile({ sandbox: 'read-only' }),
    },
    tasks: [
      { id: 'done', profile: 'claude', fake: { writes: [{ path: 'done.txt', content: 'd\n' }] } },
      {
        id: 'editing',
        profile: 'claude',
        fake: {
          counterFile: counter('editing'),
          perAttempt: [{ hang: true }, { writes: [{ path: 'e.txt', content: 'e\n' }] }],
        },
      },
      {
        id: 'reading',
        profile: 'reader',
        workspace: 'shared-readonly',
        retry: { backoffMs: 0 },
        fake: { counterFile: counter('reading'), perAttempt: [{ hang: true }, {}] },
      },
      { id: 'later', profile: 'claude', dependsOn: ['reading'] },
    ],
  });

  const running = spawnCli(t, ['run', manifest, '--runs-root', context.runs], { env: context.env });

  assert.ok(await eventually(() => fs.existsSync(context.runs) && fs.readdirSync(context.runs).length === 1));

  const runDir = onlyRunDir(context.runs);

  let providers = [];

  assert.ok(
    await eventually(() => {
      if (!fs.existsSync(path.join(runDir, 'state.sqlite'))) {
        return false;
      }

      const store = openStore(runDir);

      try {
        const done = store.task('done')?.state === 'succeeded';

        providers = ['editing', 'reading'].map((id) => store.attempts(id)[0]?.provider?.pid ?? null);

        // a worker has taken its first directive once it has written its counter
        const reading = ['editing', 'reading'].every((id) => fs.existsSync(counter(id)));

        return done && reading && providers.every(Boolean);
      } finally {
        store.close();
      }
    }),
    'workers reach different stages',
  );

  running.child.kill('SIGKILL');
  await running.done;
  await waitForLeaseExpiry(runDir);

  const recovered = runCli(['recover', runDir], { env: context.env });

  assert.equal(recovered.code, 3, recovered.stderr);

  const status = readStatus(runDir);
  const byId = Object.fromEntries(status.tasks.map((task) => [task.id, task]));

  assert.equal(byId.done.state, 'succeeded');
  assert.equal(invocations(context, 'done').length, 1, 'accepted work is not rerun');
  assert.equal(byId.editing.state, 'recovery_required', 'an interrupted editing worker is surfaced, not retried');
  assert.equal(byId.reading.state, 'succeeded', JSON.stringify(byId.reading.failure));
  assert.equal(byId.reading.attempts, 2);
  assert.equal(byId.later.state, 'succeeded', JSON.stringify(byId.later.failure));

  for (const pid of providers) {
    assert.equal(isAlive(pid), false, `provider ${pid} was stopped`);
  }

  const store = openStore(runDir);

  for (const task of store.tasks()) {
    const attempts = store.attempts(task.id);

    assert.ok(attempts.every((attempt) => !attempt.active));

    for (let index = 1; index < attempts.length; index++) {
      assert.ok(
        Date.parse(attempts[index].created_at) >= Date.parse(attempts[index - 1].ended_at),
        `attempts of ${task.id} do not overlap`,
      );
    }
  }

  const editingAttempt = store.attempts('editing')[0];
  const stateVersion = store.task('editing').state_version;

  store.close();

  // a stale decision is rejected, and a current one retries after reconciliation
  const stale = path.join(context.dir, 'stale.json');

  fs.writeFileSync(
    stale,
    JSON.stringify({
      version: 1,
      decisions: [
        {
          taskId: 'editing',
          attemptId: editingAttempt.id,
          stateVersion: stateVersion - 1,
          evidence: 'inspected the workspace, nothing external',
          action: 'retry-after-reconciliation',
        },
      ],
    }),
  );

  const rejected = runCli(['recover', runDir, '--decision', stale], { env: context.env });

  assert.match(rejected.stderr, /stale decision/);
  assert.equal(readStatus(runDir).tasks.find((task) => task.id === 'editing').state, 'recovery_required');

  const decision = path.join(context.dir, 'decision.json');

  fs.writeFileSync(
    decision,
    JSON.stringify({
      version: 1,
      decisions: [
        {
          taskId: 'editing',
          attemptId: editingAttempt.id,
          stateVersion: readStatus(runDir).tasks.find((task) => task.id === 'editing').stateVersion,
          evidence: 'inspected the workspace; the partial edit is discarded',
          action: 'retry-after-reconciliation',
        },
      ],
    }),
  );

  const retried = runCli(['recover', runDir, '--decision', decision], { env: context.env });

  assert.equal(retried.code, 0, retried.stderr);

  const final = readStatus(runDir);

  assert.equal(final.outcome, 'succeeded');
  assert.equal(final.tasks.find((task) => task.id === 'editing').attempts, 2);

  const reader = openStore(runDir);

  assert.ok(
    reader.artifacts(editingAttempt.id).some((item) => item.kind === 'partial-patch' || item.kind === 'patch'),
    'partial changes are preserved',
  );

  reader.close();
});

test('a second supervisor cannot take a run with a live lease, and cancel reaches the live one', async (t) => {
  const context = setup(t);
  const manifest = writeManifest(context.dir, { tasks: [{ id: 'slow', profile: 'claude', fake: { hang: true } }] });
  const running = spawnCli(t, ['run', manifest, '--runs-root', context.runs], { env: context.env });

  assert.ok(await eventually(() => fs.existsSync(context.runs) && fs.readdirSync(context.runs).length === 1));

  const runDir = onlyRunDir(context.runs);

  assert.ok(
    await eventually(
      () => fs.existsSync(path.join(runDir, 'state.sqlite')) && readStatus(runDir).tasks[0].state === 'running',
      20_000,
    ),
  );

  const second = runCli(['recover', runDir], { env: context.env });

  assert.equal(second.code, 64);
  assert.match(second.stderr, /valid lease/);

  const cancel = runCli(['cancel', runDir], { env: context.env });

  assert.equal(cancel.code, 0);
  assert.match(cancel.stderr, /the running supervisor applied the cancellation/);

  const result = await running.done;

  assert.equal(result.code, 4, result.stderr);
  assert.equal(readStatus(runDir).tasks[0].state, 'cancelled');
});

test('a killed attempt host leaves its provider to the supervisor, which stops it and requires recovery', async (t) => {
  const context = setup(t);

  const manifest = writeManifest(context.dir, {
    limits: { terminateGraceMs: 500 },
    tasks: [{ id: 'slow', profile: 'claude', fake: { hang: true } }],
  });

  const running = spawnCli(t, ['run', manifest, '--runs-root', context.runs], { env: context.env });

  assert.ok(await eventually(() => fs.existsSync(context.runs) && fs.readdirSync(context.runs).length === 1));

  const runDir = onlyRunDir(context.runs);

  let attempt;

  assert.ok(
    await eventually(() => {
      if (!fs.existsSync(path.join(runDir, 'state.sqlite'))) {
        return false;
      }

      const store = openStore(runDir);

      attempt = store.attempts('slow')[0];

      store.close();

      return Boolean(attempt?.provider);
    }),
  );

  const launch = JSON.parse(fs.readFileSync(attempt.profile.files.launch, 'utf8'));

  process.kill(launch.host.pid, 'SIGKILL');

  const result = await running.done;

  assert.equal(result.code, 3, result.stderr);
  assert.equal(isAlive(attempt.provider.pid), false, 'the orphaned provider was stopped by identity');
  assert.equal(readStatus(runDir).tasks[0].state, 'recovery_required');
});

test('a truncated exit receipt is never trusted', async (t) => {
  const context = setup(t);
  const manifest = writeManifest(context.dir, { tasks: [editingTask] });

  runCli(['run', manifest, '--runs-root', context.runs], {
    env: { ...context.env, ORCHESTRATOR_FAULT: 'after-host-spawn' },
  });

  const runDir = onlyRunDir(context.runs);
  const attemptsDir = path.join(runDir, 'tasks', 'edit', 'attempts');

  let exitFile;

  assert.ok(
    await eventually(() => {
      const [id] = fs.readdirSync(attemptsDir);

      exitFile = path.join(attemptsDir, id, 'exit.json');

      return fs.existsSync(exitFile);
    }),
  );

  fs.writeFileSync(exitFile, '{"protocol": 1, "nonce": "');
  await waitForLeaseExpiry(runDir);

  const recovered = runCli(['recover', runDir], { env: context.env });

  assert.equal(recovered.code, 3, recovered.stderr);
  assert.equal(readStatus(runDir).tasks[0].state, 'recovery_required');
});

test('a reused PID is never signalled during reconciliation', async (t) => {
  const dir = makeTemporaryDir(t);
  const victim = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });

  t.after(() => victim.kill('SIGKILL'));
  await eventually(() => processIdentity(victim.pid) !== null);

  const stale = { pid: victim.pid, startTime: 'Thu Jan  1 00:00:00 1970', bootId: processIdentity(victim.pid).bootId };

  assert.equal(checkIdentity(stale), 'reused');

  const files = {
    launch: path.join(dir, 'launch.json'),
    provider: path.join(dir, 'provider.json'),
    exit: path.join(dir, 'exit.json'),
    cancel: path.join(dir, 'cancel.json'),
  };

  writeJsonAtomic(files.launch, { nonce: 'n', host: stale });
  writeJsonAtomic(files.provider, { nonce: 'n', pid: victim.pid, pgid: victim.pid, identity: stale });

  const runner = new AttemptRunner({
    store: null,
    runDir: dir,
    ids: randomIds(),
    limits: { ...DEFAULT_LIMITS, terminateGraceMs: 200 },
    ownerDb: null,
  });

  const decision = await runner.reconcile({ id: 'a-1', phase: 'running', nonce: 'n', profile: { files } });

  assert.ok(['interrupted', 'uncertain'].includes(decision.action));
  assert.equal(decision.evidence.provider, 'reused');
  assert.equal(isAlive(victim.pid), true, 'the unrelated process is untouched');
});

test('an exit receipt that lands while reconciliation inspects the processes is still ingested', async (t) => {
  const dir = makeTemporaryDir(t);
  const gone = { pid: process.pid, startTime: 'never', bootId: '00000000-0000-4000-8000-000000000000' };
  const receipt = path.join(dir, 'exit.json');

  assert.equal(checkIdentity(gone), 'gone');

  let reads = 0;

  // the host writes its receipt and exits between the first look at the receipt and the look at the process
  const files = {
    launch: path.join(dir, 'launch.json'),
    provider: path.join(dir, 'provider.json'),
    cancel: path.join(dir, 'cancel.json'),
    get exit() {
      return reads++ === 0 ? path.join(dir, 'not-written-yet.json') : receipt;
    },
  };

  writeJsonAtomic(files.launch, { nonce: 'n', host: gone });
  writeJsonAtomic(files.provider, { nonce: 'n', pid: gone.pid, pgid: 2_000_000_000, identity: gone });
  writeJsonAtomic(receipt, { nonce: 'n', code: 0, terminalReason: 'exited', providerStarted: true });

  const runner = new AttemptRunner({
    store: null,
    runDir: dir,
    ids: randomIds(),
    limits: DEFAULT_LIMITS,
    ownerDb: null,
  });

  const decision = await runner.reconcile({ id: 'a-1', phase: 'running', nonce: 'n', profile: { files } });

  assert.equal(decision.action, 'ingest', JSON.stringify(decision));
  assert.equal(decision.exit.code, 0);
});

test('the database enforces one live lease and one active attempt per task', (t) => {
  const dir = makeTemporaryDir(t);
  const store = Store.create(path.join(dir, 'state.sqlite'), { id: 'r', kind: 'test', label: 'l', runDir: dir });

  t.after(() => store.close());
  store.acquireLease({ token: 'one', leaseMs: 60_000 });

  const other = Store.open(path.join(dir, 'state.sqlite'));

  assert.throws(() => other.acquireLease({ token: 'two', leaseMs: 60_000 }), /owned by a live supervisor/);
  other.close();

  store.ownerTx(() => store.insertTask({ id: 't', ord: 0, spec: {}, state: 'ready' }));

  const attempt = (id, number) => {
    return {
      id,
      task_id: 't',
      number,
      kind: 'initial',
      phase: 'running',
      active: 1,
      nonce: id,
      owner_generation: 1,
      attempt_dir: dir,
      profile_json: {},
      prompt_sha256: 'x',
    };
  };

  store.ownerTx(() => store.insertAttempt(attempt('a1', 1)));
  assert.throws(() => store.ownerTx(() => store.insertAttempt(attempt('a2', 2))), /UNIQUE constraint failed/);
});
