import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { statusSnapshot } from '../scripts/lib/report.mjs';
import { Store } from '../scripts/lib/store.mjs';
import { Supervisor, createRun } from '../scripts/lib/supervisor.mjs';
import {
  codexProfile,
  cursorProfile,
  eventually,
  git,
  isAlive,
  makeTemporaryDir,
  makeTemporaryRepository,
  readFakeLog,
  runCli,
  writeManifest,
} from './helpers.mjs';

function setup(t, files) {
  const dir = makeTemporaryDir(t);
  const repository = makeTemporaryRepository(t, files);

  fs.symlinkSync(repository, path.join(dir, 'repo'));

  const fakeLog = path.join(dir, 'fake.log');
  const env = { ...process.env, FAKE_LOG: fakeLog };

  return { dir, repository, fakeLog, env };
}

async function create(context, spec) {
  const file = writeManifest(context.dir, spec);
  const { runDir } = await createRun(file, { runsRoot: path.join(context.dir, 'runs'), env: context.env });

  return runDir;
}

async function supervise(context, runDir, options = {}) {
  const supervisor = new Supervisor(runDir, { env: context.env, pollMs: 25 });

  try {
    const result = await supervisor.supervise(options);

    return { ...result, status: statusSnapshot(supervisor.store), store: supervisor.store };
  } finally {
    supervisor.close();
  }
}

function openStore(runDir) {
  return Store.open(path.join(runDir, 'state.sqlite'), { readOnly: true });
}

function invocationsFor(fakeLog, taskId) {
  return readFakeLog(fakeLog).filter((entry) => entry.stdin.includes(`Task id: \`${taskId}\``));
}

function flag(argv, name) {
  const index = argv.indexOf(name);

  return index === -1 ? null : argv[index + 1];
}

test('the concurrency limit holds and ready tasks start in manifest order', async (t) => {
  const context = setup(t);

  const runDir = await create(context, {
    limits: { concurrency: 2 },
    tasks: ['t1', 't2', 't3', 't4'].map((id) => {
      return { id, profile: 'claude', fake: { sleepMs: 400 } };
    }),
  });

  const result = await supervise(context, runDir);

  assert.equal(result.outcome, 'succeeded');

  const store = openStore(runDir);

  const intervals = store.tasks().map((task) => {
    const attempt = store.attempts(task.id)[0];

    return { id: task.id, start: Date.parse(attempt.created_at), end: Date.parse(attempt.ended_at) };
  });

  const firstDispatch = store.events({ limit: 1000 }).find((event) => event.type === 'dispatch.decision');

  store.close();

  // ends sort before starts at equal timestamps, so a task starting as another ends does not count as overlap
  const events = intervals
    .flatMap((interval) => [
      { at: interval.start, delta: 1 },
      { at: interval.end, delta: -1 },
    ])
    .toSorted((a, b) => a.at - b.at || a.delta - b.delta);

  let active = 0;
  let peak = 0;

  for (const event of events) {
    active += event.delta;
    peak = Math.max(peak, active);
  }

  assert.ok(peak <= 2, `${peak} attempts ran at once: ${JSON.stringify(intervals)}`);

  assert.deepEqual(
    firstDispatch.data.selected.map((item) => item.task),
    ['t1', 't2'],
  );

  assert.deepEqual(firstDispatch.data.deferred, [
    { task: 't3', reason: 'concurrency limit' },
    { task: 't4', reason: 'concurrency limit' },
  ]);
});

test('a failed dependency skips its dependents while independent tasks finish', async (t) => {
  const context = setup(t);

  const runDir = await create(context, {
    tasks: [
      { id: 'a', profile: 'claude', fake: { exitCode: 3 } },
      { id: 'b', profile: 'claude', dependsOn: ['a'] },
      { id: 'c', profile: 'codex' },
    ],
  });

  const { outcome, exitCode, status } = await supervise(context, runDir);
  const states = Object.fromEntries(status.tasks.map((task) => [task.id, task.state]));

  assert.deepEqual(states, { a: 'failed', b: 'skipped', c: 'succeeded' });
  assert.equal(outcome, 'failed');
  assert.equal(exitCode, 1);
  assert.equal(invocationsFor(context.fakeLog, 'b').length, 0);
});

test('a blocked task holds its dependents; continue resumes the same session and workspace with the same profile', async (t) => {
  const context = setup(t);

  const runDir = await create(context, {
    tasks: [
      {
        id: 'a',
        profile: 'claude',
        fake: { status: 'blocked', writes: [{ path: 'partial.txt', content: 'partial\n' }] },
      },
      {
        id: 'b',
        profile: 'codex',
        dependsOn: ['a'],
        verify: [{ name: 'has-a', argv: ['sh', '-c', 'test -f partial.txt && test -f done.txt'] }],
      },
    ],
  });

  const first = await supervise(context, runDir);

  assert.equal(first.outcome, 'blocked');
  assert.equal(first.exitCode, 2);
  assert.equal(first.status.tasks.find((task) => task.id === 'a').blocker.needs, 'operator input');
  assert.equal(first.status.tasks.find((task) => task.id === 'b').state, 'pending');

  const store = Store.open(path.join(runDir, 'state.sqlite'));

  store.enqueueControl({
    kind: 'continue',
    taskId: 'a',
    data: {
      promptText: `Decision: go ahead.\n\nFAKE: ${JSON.stringify({ writes: [{ path: 'done.txt', content: 'done\n' }] })}\n`,
    },
  });

  store.close();

  const second = await supervise(context, runDir);

  assert.equal(second.outcome, 'succeeded');

  const [initial, continuation] = invocationsFor(context.fakeLog, 'a');

  assert.equal(flag(continuation.argv, '--resume'), 'session-fake');
  assert.equal(continuation.cwd, initial.cwd, 'continuation runs in the blocked attempt workspace');

  for (const name of [
    '--model',
    '--effort',
    '--permission-mode',
    '--permission-prompts',
    '--max-budget-usd',
    '--tools',
  ]) {
    assert.equal(flag(continuation.argv, name), flag(initial.argv, name), `${name} is reapplied`);
  }

  const reader = openStore(runDir);
  const attempts = reader.attempts('a');
  const patch = reader.artifacts(attempts[1].id).find((item) => item.kind === 'patch');

  reader.close();

  assert.equal(attempts[1].kind, 'continuation');
  assert.deepEqual(patch.data.changes.map((change) => change.path).toSorted(), ['done.txt', 'partial.txt']);
});

test('a cursor task builds on a codex patch, blocks, and continues in its saved chat and workspace', async (t) => {
  const context = setup(t);

  const runDir = await create(context, {
    profiles: { codex: codexProfile(), cursor: cursorProfile() },
    tasks: [
      { id: 'api', profile: 'codex', fake: { writes: [{ path: 'api.txt', content: 'api\n' }] } },
      {
        id: 'ui',
        profile: 'cursor',
        dependsOn: ['api'],
        fake: { status: 'blocked', sessionId: 'chat-ui', writes: [{ path: 'ui.txt', content: 'draft\n' }] },
        verify: [{ name: 'both', argv: ['sh', '-c', 'test -f api.txt && grep -qx final ui.txt'] }],
      },
    ],
    integration: { checks: [{ name: 'all', argv: ['sh', '-c', 'test -f api.txt && test -f ui.txt'] }] },
  });

  const first = await supervise(context, runDir);

  assert.equal(first.outcome, 'blocked');

  const store = Store.open(path.join(runDir, 'state.sqlite'));

  store.enqueueControl({
    kind: 'continue',
    taskId: 'ui',
    data: {
      promptText: `Go ahead.\n\nFAKE: ${JSON.stringify({ writes: [{ path: 'ui.txt', content: 'final\n' }] })}\n`,
    },
  });

  store.close();

  const second = await supervise(context, runDir);

  assert.equal(second.outcome, 'succeeded', JSON.stringify(second.status.tasks, null, 2));
  assert.equal(second.status.integration.status, 'passed');

  const [initial, continuation] = invocationsFor(context.fakeLog, 'ui');

  assert.equal(flag(initial.argv, '--resume'), null);
  assert.equal(flag(continuation.argv, '--resume'), 'chat-ui');
  assert.equal(continuation.cwd, initial.cwd, 'continuation runs in the blocked attempt workspace');
  assert.equal(flag(continuation.argv, '--workspace'), initial.cwd);

  for (const name of ['--model', '--sandbox', '--output-format']) {
    assert.equal(flag(continuation.argv, name), flag(initial.argv, name), `${name} is reapplied`);
  }

  for (const invocation of [initial, continuation]) {
    assert.match(invocation.stdin, /"required": \["taskId", "attemptId", "status"/, 'the prompt carries the schema');
  }

  const reader = openStore(runDir);
  const attempts = reader.attempts('ui');

  assert.equal(fs.readFileSync(path.join(attempts[1].attempt_dir, 'prompt.md'), 'utf8'), continuation.stdin);
  reader.close();
});

test('read-only transient failures retry within the limit; editing tasks do not retry', async (t) => {
  const context = setup(t);
  const counter = (name) => path.join(context.dir, `${name}.count`);

  const flaky = (name) => {
    return { counterFile: counter(name), perAttempt: [{ codexFail: 'stream disconnected before completion' }, {}] };
  };

  const runDir = await create(context, {
    profiles: { reader: codexProfile({ sandbox: 'read-only' }), writer: codexProfile() },
    tasks: [
      { id: 'look', profile: 'reader', workspace: 'shared-readonly', retry: { backoffMs: 0 }, fake: flaky('look') },
      { id: 'edit', profile: 'writer', fake: flaky('edit') },
    ],
  });

  const { status } = await supervise(context, runDir);
  const look = status.tasks.find((task) => task.id === 'look');
  const edit = status.tasks.find((task) => task.id === 'edit');

  assert.equal(look.state, 'succeeded');
  assert.equal(look.attempts, 2);
  assert.equal(edit.state, 'failed');
  assert.equal(edit.attempts, 1);
  assert.equal(edit.failure.class, 'transient');
});

test('changes outside the declared scope fail verification and the candidate artifact is kept', async (t) => {
  const context = setup(t);

  const runDir = await create(context, {
    tasks: [
      {
        id: 'a',
        profile: 'claude',
        scope: ['src/**'],
        fake: {
          writes: [
            { path: 'src/ok.js', content: '1\n' },
            { path: 'docs/extra.md', content: 'x\n' },
          ],
        },
      },
    ],
  });

  const { status } = await supervise(context, runDir);
  const task = status.tasks[0];

  assert.equal(task.state, 'failed');
  assert.equal(task.failure.class, 'verification');
  assert.match(task.failure.message, /docs\/extra\.md/);
  assert.equal(task.latestAttempt.patch.changes, 2);
});

test('checks bind to the artifact; a failing check fails and a mutating check invalidates evidence', async (t) => {
  const context = setup(t);

  const runDir = await create(context, {
    tasks: [
      {
        id: 'pass',
        profile: 'claude',
        fake: { writes: [{ path: 'x.txt', content: 'x\n' }] },
        verify: [{ name: 'present', argv: ['test', '-f', 'x.txt'] }],
      },
      { id: 'fail', profile: 'claude', verify: [{ name: 'absent', argv: ['test', '-f', 'nope.txt'] }] },
      { id: 'mutate', profile: 'claude', verify: [{ name: 'writes', argv: ['sh', '-c', 'echo extra >> README.md'] }] },
    ],
  });

  const { status } = await supervise(context, runDir);
  const byId = Object.fromEntries(status.tasks.map((task) => [task.id, task]));

  assert.equal(byId.pass.state, 'succeeded');
  assert.equal(byId.fail.state, 'failed');
  assert.match(byId.fail.failure.message, /check absent failed/);
  assert.equal(byId.mutate.state, 'failed');
  assert.match(byId.mutate.failure.message, /modified the workspace/);

  const store = openStore(runDir);
  const attempt = store.attempts('pass')[0];
  const [check] = store.checks({ attemptId: attempt.id });
  const patch = store.artifacts(attempt.id).find((item) => item.kind === 'patch');

  store.close();

  assert.equal(check.ok, 1);
  assert.equal(check.subject_sha256, patch.data.tree, 'the check names the exact tree it validated');
  assert.ok(fs.existsSync(check.log_path));
});

test('artifacts carry binary, deleted, executable, symlinked, and new files to dependents without duplicating them', async (t) => {
  const context = setup(t);
  const binary = Buffer.from([0, 1, 2, 255, 254, 0, 10]).toString('base64');

  const runDir = await create(context, {
    tasks: [
      {
        id: 'a',
        profile: 'claude',
        fake: {
          writes: [
            { path: 'bin.dat', content: binary, base64: true },
            { path: 'tool.sh', content: '#!/bin/sh\necho hi\n', mode: '755' },
          ],
          deletes: ['README.md'],
          symlinks: [{ path: 'link', target: 'tool.sh' }],
        },
      },
      { id: 'b', profile: 'codex', dependsOn: ['a'], fake: { writes: [{ path: 'b.txt', content: 'b\n' }] } },
      {
        id: 'c',
        profile: 'claude',
        dependsOn: ['b'],
        fake: { writes: [{ path: 'c.txt', content: 'c\n' }] },
        verify: [
          {
            name: 'inherited',
            argv: [
              'sh',
              '-c',
              'test ! -e README.md && test -x tool.sh && test -L link && test -f bin.dat && test -f b.txt',
            ],
          },
        ],
      },
    ],
    integration: {
      checks: [
        {
          name: 'combined',
          argv: ['sh', '-c', 'test -x tool.sh && test -L link && test -f c.txt && test ! -e README.md'],
        },
      ],
    },
  });

  const { outcome, status } = await supervise(context, runDir);

  assert.equal(outcome, 'succeeded');
  assert.equal(status.integration.status, 'passed');

  const store = openStore(runDir);

  const changesOf = (id) =>
    store
      .artifacts(store.task(id).result_attempt_id)
      .find((item) => item.kind === 'patch')
      .data.changes.map((change) => `${change.status} ${change.path}`)
      .toSorted();

  assert.deepEqual(changesOf('a'), ['A bin.dat', 'A link', 'A tool.sh', 'D README.md']);
  assert.deepEqual(changesOf('b'), ['A b.txt']);
  assert.deepEqual(changesOf('c'), ['A c.txt'], 'inherited changes are not exported again');
  store.close();
});

test('a working-tree snapshot includes uncommitted and untracked work and leaves the checkout, index, and refs alone', async (t) => {
  const context = setup(t, {
    'README.md': '# demo\n',
    'src/app.js': 'export const value = 1;\n',
    '.gitignore': 'secret.log\n',
  });

  fs.writeFileSync(path.join(context.repository, 'src/app.js'), 'export const value = 2; // modified\n');
  fs.writeFileSync(path.join(context.repository, 'notes.txt'), 'untracked\n');
  fs.writeFileSync(path.join(context.repository, 'secret.log'), 'ignored\n');
  git(context.repository, 'add', 'notes.txt');
  git(context.repository, 'reset', '-q', 'notes.txt');

  const before = {
    status: git(context.repository, 'status', '--porcelain'),
    head: git(context.repository, 'rev-parse', 'HEAD'),
    staged: git(context.repository, 'diff', '--cached'),
    branches: git(context.repository, 'branch', '--list'),
  };

  const runDir = await create(context, {
    input: { root: 'repo', snapshot: 'working-tree' },
    tasks: [
      {
        id: 'a',
        profile: 'claude',
        fake: { writes: [{ path: 'new.txt', content: 'n\n' }] },
        verify: [
          {
            name: 'sees-user-work',
            argv: ['sh', '-c', 'grep -q modified src/app.js && test -f notes.txt && test ! -e secret.log'],
          },
        ],
      },
    ],
  });

  const { outcome, status } = await supervise(context, runDir);

  assert.equal(outcome, 'succeeded', JSON.stringify(status.tasks[0].failure));
  assert.equal(status.input.dirty, true);

  assert.deepEqual(
    {
      status: git(context.repository, 'status', '--porcelain'),
      head: git(context.repository, 'rev-parse', 'HEAD'),
      staged: git(context.repository, 'diff', '--cached'),
      branches: git(context.repository, 'branch', '--list'),
    },
    before,
  );

  assert.equal(
    fs.existsSync(path.join(context.repository, 'new.txt')),
    false,
    'the worker never wrote to the user checkout',
  );
});

test('conflicting dependency artifacts block the dependent before it launches', async (t) => {
  const context = setup(t);

  const runDir = await create(context, {
    tasks: [
      { id: 'a', profile: 'claude', fake: { writes: [{ path: 'README.md', content: '# from a\n' }] } },
      { id: 'b', profile: 'codex', fake: { writes: [{ path: 'README.md', content: '# from b\n' }] } },
      { id: 'c', profile: 'claude', dependsOn: ['a', 'b'] },
    ],
  });

  const { outcome, status } = await supervise(context, runDir);
  const c = status.tasks.find((task) => task.id === 'c');

  assert.equal(outcome, 'blocked');
  assert.equal(c.state, 'blocked');
  assert.equal(c.failure.class, 'conflict');
  assert.equal(invocationsFor(context.fakeLog, 'c').length, 0, 'no worker starts against a conflicting input');
});

test('cancelling a running task stops its worker and marks it cancelled', async (t) => {
  const context = setup(t);

  const runDir = await create(context, {
    tasks: [
      { id: 'slow', profile: 'claude', fake: { hang: true } },
      { id: 'quick', profile: 'codex' },
    ],
  });

  const supervisor = new Supervisor(runDir, { env: context.env, pollMs: 25 });
  const running = supervisor.supervise();

  let providerPid = null;

  assert.ok(
    await eventually(() => {
      const attempt = supervisor.store.attempts('slow')[0];

      providerPid = attempt?.provider?.pid ?? null;

      return providerPid !== null;
    }),
  );

  const control = Store.open(path.join(runDir, 'state.sqlite'));

  control.enqueueControl({ kind: 'cancel', taskId: 'slow' });
  control.close();

  const result = await running;
  const status = statusSnapshot(supervisor.store);

  supervisor.close();

  assert.equal(status.tasks.find((task) => task.id === 'slow').state, 'cancelled');
  assert.equal(status.tasks.find((task) => task.id === 'quick').state, 'succeeded');
  assert.equal(result.outcome, 'cancelled');
  assert.equal(isAlive(providerPid), false);
});

test('reaching the reported spend threshold stops new dispatch but labels it as reported spend', async (t) => {
  const context = setup(t);

  const runDir = await create(context, {
    limits: { concurrency: 1, spendThresholdUsd: 0.01 },
    tasks: [
      { id: 'first', profile: 'claude' },
      { id: 'second', profile: 'claude' },
    ],
  });

  const { outcome, exitCode, status } = await supervise(context, runDir);

  assert.equal(outcome, 'stopped');
  assert.equal(exitCode, 5);
  assert.equal(status.dispatchStopped, 'spend-threshold');
  assert.equal(status.tasks.find((task) => task.id === 'second').state, 'ready');
  assert.match(fs.readFileSync(path.join(runDir, 'run.md'), 'utf8'), /reported usage, not an enforced cap/);
});

test('the run deadline stops active work', async (t) => {
  const context = setup(t);

  const runDir = await create(context, {
    limits: { runDeadlineMs: 1500 },
    tasks: [{ id: 'slow', profile: 'claude', fake: { hang: true } }],
  });

  const { status } = await supervise(context, runDir);
  const task = status.tasks[0];

  assert.equal(task.state, 'failed');
  assert.equal(task.failure.class, 'budget');
  assert.equal(status.dispatchStopped, 'run-deadline');
});

test('a failing integration check fails the run even though every task succeeded', async (t) => {
  const context = setup(t);

  const runDir = await create(context, {
    tasks: [{ id: 'a', profile: 'claude', fake: { writes: [{ path: 'a.txt', content: 'a\n' }] } }],
    integration: { checks: [{ name: 'never', argv: ['false'] }] },
  });

  const { outcome, status } = await supervise(context, runDir);

  assert.equal(status.tasks[0].state, 'succeeded');
  assert.equal(status.integration.status, 'failed');
  assert.equal(outcome, 'failed');
});

test('the report separates claims from checks, survives write failures, and regenerates', async (t) => {
  const context = setup(t);

  const runDir = await create(context, {
    tasks: [
      {
        id: 'a',
        profile: 'claude',
        fake: { writes: [{ path: 'a.txt', content: 'a\n' }] },
        verify: [{ name: 'present', argv: ['test', '-f', 'a.txt'] }],
      },
    ],
  });

  const report = path.join(runDir, 'run.md');

  fs.rmSync(report);
  fs.mkdirSync(report);

  const { outcome } = await supervise(context, runDir);

  assert.equal(outcome, 'succeeded', 'state commits even when the report cannot be written');

  fs.rmSync(report, { recursive: true });

  const regenerated = runCli(['report', runDir]);

  assert.equal(regenerated.code, 0, regenerated.stderr);

  const text = fs.readFileSync(report, 'utf8');

  assert.match(text, /Worker claim: done/);
  assert.match(text, /Host check present: pass/);
  assert.match(text, /Artifact patch/);
});

test('a storage failure while capturing artifacts never yields success', async (t) => {
  const context = setup(t);

  const runDir = await create(context, {
    tasks: [{ id: 'a', profile: 'claude', fake: { writes: [{ path: 'a.txt', content: 'a\n' }] } }],
  });

  process.env.ORCHESTRATOR_FAULT = 'artifact-enospc';

  t.after(() => delete process.env.ORCHESTRATOR_FAULT);

  const { status } = await supervise(context, runDir);
  const task = status.tasks[0];

  assert.equal(task.state, 'recovery_required');
  assert.match(task.failure.message, /ENOSPC/);
  assert.equal(task.latestAttempt.patch, null, 'no partial artifact is recorded as accepted');
});
