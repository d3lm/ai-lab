import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { liveProcessReason } from '../scripts/lib/attempt.mjs';
import { runBounded } from '../scripts/lib/process.mjs';
import { statusSnapshot } from '../scripts/lib/report.mjs';
import { Supervisor, createRun } from '../scripts/lib/supervisor.mjs';
import { openWorkflow } from '../scripts/lib/workflow.mjs';
import {
  claudeProfile,
  eventually,
  fakePrompt,
  makeTemporaryDir,
  makeTemporaryRepository,
  writeManifest,
} from './helpers.mjs';

function setup(t) {
  const dir = makeTemporaryDir(t);
  const repository = makeTemporaryRepository(t);

  fs.symlinkSync(repository, path.join(dir, 'repo'));

  return { dir, repository };
}

async function runToEnd(runDir) {
  const supervisor = new Supervisor(runDir, { pollMs: 25 });

  try {
    const result = await supervisor.supervise();

    return { ...result, status: statusSnapshot(supervisor.store) };
  } finally {
    supervisor.close();
  }
}

test('a preparation failure that recurs every time stops after a bounded number of unstarted attempts', async (t) => {
  const context = setup(t);
  const file = writeManifest(context.dir, { tasks: [{ id: 'a', profile: 'claude' }] });
  const { runDir } = await createRun(file, { runsRoot: path.join(context.dir, 'runs') });

  fs.chmodSync(path.join(runDir, 'workspaces'), 0o555);

  let result;

  try {
    result = await runToEnd(runDir);
  } finally {
    fs.chmodSync(path.join(runDir, 'workspaces'), 0o755);
  }

  const { outcome, status } = result;
  const task = status.tasks[0];

  assert.equal(outcome, 'failed');
  assert.equal(task.state, 'failed');
  assert.equal(task.attempts, 3);
  assert.match(task.failure.message, /3 attempts failed before a provider started/);
});

test('a ready task behind a quarantined session does not keep the supervisor running', async (t) => {
  const context = setup(t);

  const file = writeManifest(context.dir, {
    input: { root: 'repo', snapshot: 'none' },
    tasks: [
      {
        id: 'first',
        profile: 'claude',
        workspace: 'in-place',
        session: 'shared',
        fake: { writes: [{ path: 'a.txt', content: 'a\n' }] },
      },
      { id: 'second', profile: 'claude', workspace: 'in-place', session: 'shared' },
    ],
  });

  const { runDir } = await createRun(file, { runsRoot: path.join(context.dir, 'runs') });

  process.env.ORCHESTRATOR_FAULT = 'artifact-enospc';

  t.after(() => delete process.env.ORCHESTRATOR_FAULT);

  const { outcome, status } = await runToEnd(runDir);

  assert.equal(outcome, 'recovery_required');
  assert.equal(status.tasks.find((task) => task.id === 'first').state, 'recovery_required');
  assert.equal(status.tasks.find((task) => task.id === 'second').state, 'ready');
});

test('a bounded command times out even when an escaped descendant holds its output open', async (t) => {
  const dir = makeTemporaryDir(t);
  const pidFile = path.join(dir, 'daemon.pid');
  const script = `require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] }).unref(); require('fs').writeFileSync(${JSON.stringify(pidFile)}, 'x'); setTimeout(() => {}, 20000);`;

  t.after(() => {
    spawn('pkill', ['-f', String.raw`setTimeout\(\(\) => \{\}, 20000\)`]);
  });

  const started = Date.now();

  const result = await runBounded([process.execPath, '-e', script], {
    cwd: dir,
    timeoutMs: 1000,
    maxOutputBytes: 1024,
    graceMs: 200,
  });

  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 8000, `settled after ${Date.now() - started} ms`);
});

test('an uncertain workflow turn is rerun only with explicit acceptance and once its processes are gone', async (t) => {
  const dir = makeTemporaryDir(t);
  const runDir = path.join(dir, 'run');

  fs.mkdirSync(runDir);

  const workflow = await openWorkflow({ runDir, kind: 'test', label: 'uncertain' });

  t.after(() => workflow.close());

  const schemaFile = path.join(dir, 'schema.json');

  fs.writeFileSync(
    schemaFile,
    JSON.stringify({ type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } }),
  );

  const spec = (directive) => {
    return {
      step: 'edit-1',
      session: 'claude',
      profile: claudeProfile(),
      promptText: fakePrompt({ payload: { ok: true }, ...directive }),
      schemaFile,
      files: {
        prompt: path.join(runDir, 'prompt-1.md'),
        stdout: path.join(runDir, 'out-1.json'),
        stderr: path.join(runDir, 'err-1.log'),
      },
      cwd: dir,
      isGitRepo: false,
      readOnly: false,
      deadlineMs: 60_000,
    };
  };

  // simulate the previous process losing ownership while an editing turn ran, so the host cancels it as owner-lost
  const running = workflow.runTurn(spec({ hang: true }));

  let attempt;

  assert.ok(
    await eventually(() => {
      attempt = workflow.store.activeAttempts()[0];

      return Boolean(attempt?.provider);
    }),
  );

  fs.writeFileSync(attempt.profile.files.cancel, JSON.stringify({ reason: 'owner-lost' }));
  process.kill(JSON.parse(fs.readFileSync(attempt.profile.files.launch, 'utf8')).host.pid, 'SIGTERM');

  const first = await running;

  assert.equal(first.ok, false);
  assert.equal(first.failure.class, 'uncertain');
  assert.ok(workflow.store.session('claude').quarantine, 'the session is quarantined');

  await assert.rejects(workflow.runTurn(spec({})), /ended uncertain/);

  // the exit receipt can land before the host process has finished exiting, and acceptance requires it to be gone
  assert.ok(await eventually(() => liveProcessReason(attempt) === null), 'the turn processes stopped');

  const accepted = await workflow.runTurn({ ...spec({}), acceptUncertain: true });

  assert.equal(accepted.ok, true, JSON.stringify(accepted.failure));
  assert.equal(workflow.store.session('claude').quarantine, null);

  assert.ok(
    fs.existsSync(path.join(attempt.attempt_dir, 'superseded', 'out-1.json')),
    'the earlier output is preserved',
  );
});
