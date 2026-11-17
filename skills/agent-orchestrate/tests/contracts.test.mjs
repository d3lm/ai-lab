import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ADAPTERS } from '../scripts/lib/adapters/index.mjs';
import { canTransition, loadManifest, topologicalOrder } from '../scripts/lib/contracts.mjs';
import { openWorkflow } from '../scripts/lib/workflow.mjs';
import {
  claudeProfile,
  codexProfile,
  cursorProfile,
  makeTemporaryDir,
  makeTemporaryRepository,
  readFakeLog,
  runCli,
  writeManifest,
} from './helpers.mjs';

function setup(t) {
  const dir = makeTemporaryDir(t);
  const repository = makeTemporaryRepository(t);

  fs.symlinkSync(repository, path.join(dir, 'repo'));

  return dir;
}

const load = (file) => loadManifest(file, { adapters: ADAPTERS });

function rejects(t, spec, pattern) {
  const dir = setup(t);
  const file = writeManifest(dir, spec);

  assert.throws(() => load(file), pattern);
}

test('a valid manifest normalizes with defaults, inlined prompts, and a stable order', (t) => {
  const dir = setup(t);

  const file = writeManifest(dir, {
    tasks: [
      { id: 'b', profile: 'claude', dependsOn: ['a'] },
      { id: 'a', profile: 'codex' },
      { id: 'c', profile: 'codex', workspace: 'shared-readonly' },
    ],
    profiles: { claude: claudeProfile(), codex: codexProfile({ sandbox: 'read-only' }) },
  });

  const { manifest, sha256 } = load(file);

  assert.equal(sha256.length, 64);
  assert.deepEqual(manifest.order, ['a', 'b', 'c']);
  assert.equal(manifest.limits.concurrency, 2);
  assert.equal(manifest.limits.attemptDeadlineMs, 30 * 60 * 1000);
  assert.equal(manifest.tasks[0].retry.maxAttempts, 1, 'editing tasks default to one attempt');
  assert.equal(manifest.tasks[2].retry.maxAttempts, 2, 'read-only tasks may retry transient failures');
  assert.match(manifest.tasks[0].prompt.text, /FAKE:/);
  assert.equal(manifest.tasks[0].resultSchema.kind, 'generic');
});

test('duplicate ids, unknown dependencies, and cycles are rejected', (t) => {
  rejects(
    t,
    {
      tasks: [
        { id: 'a', profile: 'claude' },
        { id: 'a', profile: 'claude' },
      ],
    },
    /duplicate task id: a/,
  );

  rejects(t, { tasks: [{ id: 'a', profile: 'claude', dependsOn: ['ghost'] }] }, /unknown dependency ghost/);

  rejects(
    t,
    {
      tasks: [
        { id: 'a', profile: 'claude', dependsOn: ['c'] },
        { id: 'b', profile: 'claude', dependsOn: ['a'] },
        { id: 'c', profile: 'claude', dependsOn: ['b'] },
      ],
    },
    /dependency cycle among tasks: a, b, c/,
  );
});

test('invalid limits and unknown fields are rejected by the schema', (t) => {
  rejects(t, { tasks: [{ id: 'a', profile: 'claude' }], limits: { concurrency: 0 } }, /concurrency/);

  // the result parser reads at most 256 MiB of provider output, so a larger cap could never be honoured
  rejects(
    t,
    { tasks: [{ id: 'a', profile: 'claude' }], limits: { maxStdoutBytes: 256 * 1024 * 1024 + 1 } },
    /maxStdoutBytes must be <= 268435456/,
  );

  rejects(t, { tasks: [{ id: 'a', profile: 'claude', surprise: true }] }, /additional properties/);
  rejects(t, { tasks: [{ id: 'Bad Id', profile: 'claude' }] }, /pattern/);
});

test('a result schema the validator cannot enforce is rejected when the manifest loads', (t) => {
  const dir = setup(t);

  fs.writeFileSync(path.join(dir, 'result.schema.json'), JSON.stringify({ type: 'object', requried: ['ok'] }));

  const file = writeManifest(dir, { tasks: [{ id: 'a', profile: 'claude', resultSchema: 'result.schema.json' }] });

  assert.throws(() => load(file), /result schema does not compile: #: unsupported keyword "requried"/);
});

test('a workflow turn with an uncompilable result schema fails before any task or attempt is recorded', async (t) => {
  const dir = makeTemporaryDir(t);
  const runDir = path.join(dir, 'run');
  const schemaFile = path.join(dir, 'schema.json');

  fs.mkdirSync(runDir);

  fs.writeFileSync(
    schemaFile,
    JSON.stringify({ type: 'object', properties: { url: { type: 'string', format: 'uri' } } }),
  );

  const workflow = await openWorkflow({ runDir, kind: 'test', label: 'bad schema' });

  t.after(() => workflow.close());

  await assert.rejects(
    workflow.runTurn({
      step: 'turn-1',
      session: 'claude',
      profile: claudeProfile(),
      promptText: 'Do the task.',
      schemaFile,
      files: {
        prompt: path.join(runDir, 'prompt-1.md'),
        stdout: path.join(runDir, 'out-1.json'),
        stderr: path.join(runDir, 'err-1.log'),
      },
      cwd: dir,
      isGitRepo: false,
    }),
    /result schema does not compile: #\/properties\/url: unsupported keyword "format"/,
  );

  assert.equal(workflow.store.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0);
  assert.equal(workflow.store.db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n, 0, 'nothing was launched');
});

test('unsupported capabilities are rejected before dispatch', (t) => {
  rejects(
    t,
    { tasks: [{ id: 'a', profile: 'codex', requires: ['enforced-cost-limit'] }] },
    /does not support enforced-cost-limit/,
  );

  rejects(
    t,
    { tasks: [{ id: 'a', profile: 'claude', requires: ['active-turn-steering'] }] },
    /does not support active-turn-steering/,
  );

  rejects(
    t,
    { tasks: [{ id: 'a', profile: 'cursor', requires: ['structured-output'] }], profiles: { cursor: cursorProfile() } },
    /adapter cursor-cli does not support structured-output/,
  );
});

test('a cursor task needs no capability by default and its profile is validated like the others', (t) => {
  const dir = setup(t);

  const file = writeManifest(dir, {
    tasks: [
      { id: 'a', profile: 'claude' },
      { id: 'b', profile: 'cursor', dependsOn: ['a'] },
    ],
    profiles: { claude: claudeProfile(), cursor: cursorProfile({ addDirs: ['/extra'] }) },
  });

  const { manifest } = load(file);

  assert.deepEqual(manifest.tasks[1].requires, []);
  assert.equal(manifest.profiles.cursor.adapter, 'cursor-cli');

  rejects(
    t,
    { tasks: [{ id: 'a', profile: 'cursor' }], profiles: { cursor: cursorProfile({ sandbox: 'sometimes' }) } },
    /manifest is invalid/,
  );

  rejects(
    t,
    { tasks: [{ id: 'a', profile: 'cursor' }], profiles: { cursor: cursorProfile({ effort: 'high' }) } },
    /manifest is invalid/,
  );
});

test('permission settings that would broaden access need an external sandbox', (t) => {
  rejects(
    t,
    {
      tasks: [{ id: 'a', profile: 'claude' }],
      profiles: { claude: claudeProfile({ permissionMode: 'bypassPermissions' }) },
    },
    /externalSandbox/,
  );

  rejects(
    t,
    { tasks: [{ id: 'a', profile: 'codex' }], profiles: { codex: codexProfile({ sandbox: 'danger-full-access' }) } },
    /a worktree is not a sandbox/,
  );

  rejects(
    t,
    { tasks: [{ id: 'a', profile: 'cursor' }], profiles: { cursor: cursorProfile({ force: true }) } },
    /profile cursor: force requires externalSandbox: true/,
  );

  rejects(
    t,
    { tasks: [{ id: 'a', profile: 'cursor' }], profiles: { cursor: cursorProfile({ sandbox: 'disabled' }) } },
    /profile cursor: sandbox disabled requires externalSandbox: true/,
  );

  const dir = setup(t);

  const file = writeManifest(dir, {
    tasks: [{ id: 'a', profile: 'cursor' }],
    profiles: { cursor: cursorProfile({ force: true, sandbox: 'disabled', externalSandbox: true }) },
  });

  assert.equal(load(file).manifest.profiles.cursor.force, true, 'an external sandbox makes force acceptable');
});

test('shared read-only tasks require a profile that prevents writes', (t) => {
  rejects(t, { tasks: [{ id: 'a', profile: 'codex', workspace: 'shared-readonly' }] }, /read-only/);
  rejects(t, { tasks: [{ id: 'a', profile: 'claude', workspace: 'shared-readonly' }] }, /exclude Edit/);

  rejects(
    t,
    { tasks: [{ id: 'a', profile: 'cursor', workspace: 'shared-readonly' }], profiles: { cursor: cursorProfile() } },
    /shared-readonly is not available for cursor-cli/,
  );
});

test('editing tasks cannot retry unless declared safe to repeat', (t) => {
  rejects(t, { tasks: [{ id: 'a', profile: 'claude', retry: { maxAttempts: 2 } }] }, /safeToRepeat/);
});

test('prompt and schema paths cannot escape the manifest directory', (t) => {
  const dir = setup(t);
  const outside = path.join(path.dirname(dir), `${path.basename(dir)}-outside.md`);

  fs.writeFileSync(outside, 'outside');
  t.after(() => fs.rmSync(outside, { force: true }));

  const file = writeManifest(dir, { tasks: [{ id: 'a', profile: 'claude', prompt: `../${path.basename(outside)}` }] });

  assert.throws(() => load(file), /escapes the manifest directory/);
});

test('sessions shared between tasks need a stable working directory', (t) => {
  rejects(
    t,
    {
      tasks: [
        { id: 'a', profile: 'claude', session: 's' },
        { id: 'b', profile: 'claude', session: 's', dependsOn: ['a'] },
      ],
    },
    /stable working directory/,
  );
});

test('integration order must include every code task after its dependencies', (t) => {
  rejects(
    t,
    {
      tasks: [
        { id: 'a', profile: 'claude' },
        { id: 'b', profile: 'claude', dependsOn: ['a'] },
      ],
      integration: { order: ['b', 'a'] },
    },
    /before its dependency a/,
  );

  rejects(
    t,
    {
      tasks: [
        { id: 'a', profile: 'claude' },
        { id: 'b', profile: 'claude' },
      ],
      integration: { order: ['a'] },
    },
    /omits code-producing task b/,
  );
});

test('an invalid manifest starts nothing and creates no run directory', (t) => {
  const dir = setup(t);
  const fakeLog = path.join(dir, 'fake.log');
  const file = writeManifest(dir, { tasks: [{ id: 'a', profile: 'claude', dependsOn: ['a'] }] });
  const runsRoot = path.join(dir, 'runs');
  const result = runCli(['run', file, '--runs-root', runsRoot], { env: { FAKE_LOG: fakeLog } });

  assert.equal(result.code, 64);
  assert.match(result.stderr, /depends on itself|dependency cycle/);
  assert.equal(fs.existsSync(runsRoot), false);
  assert.deepEqual(readFakeLog(fakeLog), []);
});

test('task transitions follow the documented state machine', () => {
  assert.equal(canTransition('pending', 'ready'), true);
  assert.equal(canTransition('blocked', 'ready'), true);
  assert.equal(canTransition('recovery_required', 'ready'), true);
  assert.equal(canTransition('failed', 'ready'), false, 'terminal failures are not reopened');
  assert.equal(canTransition('succeeded', 'ready'), false, 'consumed results are not reopened');
  assert.equal(canTransition('recovery_required', 'succeeded'), false, 'recovery cannot declare success');
});

test('topological order keeps manifest order among ready tasks', () => {
  const order = topologicalOrder([
    { id: 'x', dependsOn: [] },
    { id: 'y', dependsOn: ['z'] },
    { id: 'z', dependsOn: [] },
    { id: 'w', dependsOn: [] },
  ]);

  assert.deepEqual(order, ['x', 'z', 'y', 'w']);
});
