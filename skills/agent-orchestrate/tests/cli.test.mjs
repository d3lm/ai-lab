import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Store } from '../scripts/lib/store.mjs';
import { createRun } from '../scripts/lib/supervisor.mjs';
import { openWorkflow } from '../scripts/lib/workflow.mjs';
import { makeTemporaryDir, makeTemporaryRepository, runCli, writeManifest } from './helpers.mjs';

async function makeRun(t, tasks = [{ id: 'one', profile: 'claude' }]) {
  const dir = makeTemporaryDir(t);
  const repository = makeTemporaryRepository(t);

  fs.symlinkSync(repository, path.join(dir, 'repo'));

  const manifest = writeManifest(dir, { tasks });
  const { runDir } = await createRun(manifest, { runsRoot: path.join(dir, 'runs') });

  return { dir, manifest, runDir };
}

function openStore(runDir, { readOnly = true } = {}) {
  return Store.open(path.join(runDir, 'state.sqlite'), { readOnly });
}

test('argument mistakes are usage errors that explain themselves in one line and start nothing', async (t) => {
  const { dir, runDir } = await makeRun(t);
  const missing = path.join(dir, 'missing.json');
  const malformed = path.join(dir, 'malformed.json');
  const misshapen = path.join(dir, 'misshapen.json');

  fs.writeFileSync(malformed, '{"version": 1, "decisions": [');
  fs.writeFileSync(misshapen, JSON.stringify({ version: 1, decisions: [{ taskId: 'one', action: 'retry' }, null] }));

  const cases = [
    [['status', runDir, '--bogus'], /unknown option '--bogus'/i],
    [['watch', runDir, '--after', 'abc'], /--after must be a non-negative integer/],
    [['watch', runDir, '--timeout-ms', 'soon'], /--timeout-ms must be a non-negative integer/],
    [['recover', runDir, '--decision', missing], /cannot read the decision file/],
    [['recover', runDir, '--decision', malformed], /decision file .* is not valid JSON/],
    [
      ['recover', runDir, '--decision', misshapen],
      /decision file is invalid: \/decisions\/0 must have required property/,
    ],
    [['continue', runDir, '--task', 'one', '--prompt-file', missing], /cannot read the prompt file/],
    [['cancel', runDir, '--task', 'nope'], /unknown task nope/],
    [['cleanup', runDir, '--task', 'nope'], /unknown task nope/],
  ];

  for (const [args, message] of cases) {
    const result = runCli(args);
    const label = [args[0], ...args.slice(2)].join(' ');

    assert.equal(result.code, 64, `${label}: ${result.stderr}`);
    assert.match(result.stderr, message, label);
    assert.doesNotMatch(result.stderr, /^\s+at /m, `${label} prints no stack trace`);
    assert.equal(result.stdout, '', `${label} prints nothing on stdout`);
  }

  const store = openStore(runDir);

  assert.equal(store.task('one').state, 'pending');
  assert.deepEqual(store.eventsOfType('lease.acquired'), [], 'no command took the run');
  assert.deepEqual(store.controls(), [], 'no request was queued');
  store.close();
});

test('a failure inside the runner exits 70, which no run outcome uses', async (t) => {
  const { runDir } = await makeRun(t);

  fs.writeFileSync(path.join(runDir, 'state.sqlite'), 'this is not a database');

  const result = runCli(['status', runDir]);

  assert.equal(result.code, 70, result.stderr);
  assert.match(result.stderr, /internal error/);
});

test('commands that supervise a manifest run refuse a workflow run and name the script that owns it', async (t) => {
  const dir = makeTemporaryDir(t);
  const runDir = path.join(dir, 'run');
  const prompt = path.join(dir, 'prompt.md');

  fs.mkdirSync(runDir);
  fs.writeFileSync(prompt, 'continue\n');

  const workflow = await openWorkflow({ runDir, kind: 'plan-review', label: 'workflow' });

  workflow.finish('approved');
  workflow.close();

  for (const args of [
    ['recover', runDir],
    ['cancel', runDir],
    ['continue', runDir, '--task', 'one', '--prompt-file', prompt],
    ['cleanup', runDir],
  ]) {
    const result = runCli(args);

    assert.equal(result.code, 64, `${args[0]}: ${result.stderr}`);
    assert.match(result.stderr, /is a plan-review workflow run.*the script that created it/, args[0]);
  }

  const store = openStore(runDir);

  assert.deepEqual(store.controls(), [], 'no request was queued for a run that never reads them');
  store.close();

  assert.equal(runCli(['status', runDir]).code, 0);
  assert.equal(runCli(['report', runDir]).code, 0);
});

test('cancel applies the request itself when the lease holder stops without applying it', async (t) => {
  const { runDir } = await makeRun(t);
  const holder = openStore(runDir, { readOnly: false });

  t.after(() => holder.close());

  // a supervisor that died holds its lease until it expires and never looks at the request
  holder.acquireLease({ token: 'crashed', leaseMs: 1500 });

  const result = runCli(['cancel', runDir]);

  assert.equal(result.code, 4, result.stderr);
  assert.equal(holder.task('one').state, 'cancelled');

  assert.deepEqual(
    holder.controls().map((control) => control.status),
    ['applied'],
  );
});
