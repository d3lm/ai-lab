import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import claude from '../scripts/lib/adapters/claude-cli.mjs';
import { ADAPTERS } from '../scripts/lib/adapters/index.mjs';
import { git as runnerGit } from '../scripts/lib/artifacts.mjs';
import { PACKAGE_ROOT, loadManifest, protocolFooter } from '../scripts/lib/contracts.mjs';
import { sameBoot } from '../scripts/lib/process.mjs';
import { statusSnapshot } from '../scripts/lib/report.mjs';
import { linuxPrefix, probeSandbox, sandboxPrefix } from '../scripts/lib/sandbox.mjs';
import { Store } from '../scripts/lib/store.mjs';
import {
  MINIMUM_NODE,
  Supervisor,
  checkRuntime,
  cleanupRun,
  createRun,
  preflightRun,
  shellQuote,
} from '../scripts/lib/supervisor.mjs';
import {
  claudeProfile,
  codexProfile,
  git,
  makeTemporaryDir,
  makeTemporaryRepository,
  writeManifest,
} from './helpers.mjs';

function setup(t, files) {
  const dir = makeTemporaryDir(t);
  const repository = makeTemporaryRepository(t, files);

  fs.symlinkSync(repository, path.join(dir, 'repo'));

  return { dir, repository, env: { ...process.env } };
}

async function create(context, spec) {
  const file = writeManifest(context.dir, spec);
  const { runDir } = await createRun(file, { runsRoot: path.join(context.dir, 'runs'), env: context.env });

  return runDir;
}

async function supervise(context, runDir) {
  const supervisor = new Supervisor(runDir, { env: context.env, pollMs: 25 });

  try {
    const result = await supervisor.supervise();

    return { ...result, status: statusSnapshot(supervisor.store) };
  } finally {
    supervisor.close();
  }
}

function byId(status) {
  return Object.fromEntries(status.tasks.map((task) => [task.id, task]));
}

// the runner's git calls inherit process.env, so configuration injected here reaches them
function withGitConfig(t, entries) {
  const saved = { ...process.env };

  process.env.GIT_CONFIG_COUNT = String(entries.length);

  for (const [index, [key, value]] of entries.entries()) {
    process.env[`GIT_CONFIG_KEY_${index}`] = key;
    process.env[`GIT_CONFIG_VALUE_${index}`] = value;
  }

  t.after(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) {
        delete process.env[key];
      }
    }

    Object.assign(process.env, saved);
  });
}

test('patches keep their paths and contents under diff.noprefix and textconv configuration', async (t) => {
  withGitConfig(t, [
    ['diff.noprefix', 'true'],
    ['diff.upper.textconv', 'tr a-z A-Z'],
  ]);

  const context = setup(t, { 'README.md': '# demo\n', '.gitattributes': '*.txt diff=upper\n' });

  const runDir = await create(context, {
    profiles: { codex: codexProfile() },
    tasks: [
      {
        id: 'make',
        profile: 'codex',
        fake: {
          writes: [
            { path: 'scripts/lib/new.mjs', content: 'export {};\n' },
            { path: 'notes.txt', content: 'hello\n' },
          ],
        },
      },
      {
        id: 'use',
        profile: 'codex',
        dependsOn: ['make'],
        verify: [
          { name: 'path', argv: ['test', '-f', 'scripts/lib/new.mjs'] },
          { name: 'content', argv: ['grep', '-qx', 'hello', 'notes.txt'] },
        ],
      },
    ],
    integration: { checks: [{ name: 'combined', argv: ['grep', '-qx', 'hello', 'notes.txt'] }] },
  });

  const { outcome, status } = await supervise(context, runDir);

  assert.equal(outcome, 'succeeded', JSON.stringify(status.tasks.map((task) => task.failure)));
  assert.equal(status.integration.status, 'passed');

  const patch = fs.readFileSync(status.tasks[0].latestAttempt.patch.path, 'utf8');

  assert.match(patch, /^diff --git a\/notes\.txt b\/notes\.txt$/m);
  assert.match(patch, /^\+hello$/m, 'textconv did not rewrite the patch');
});

test("a shared read-only task's checks run in a disposable checkout and cannot touch the shared input", async (t) => {
  const context = setup(t, { 'README.md': '# demo\n', '.gitignore': 'generated/\n' });

  const runDir = await create(context, {
    limits: { concurrency: 1 },
    profiles: { reader: codexProfile({ sandbox: 'read-only' }) },
    tasks: [
      {
        id: 'mutator',
        profile: 'reader',
        workspace: 'shared-readonly',
        verify: [
          {
            name: 'writes',
            argv: ['sh', '-c', 'echo extra >> README.md && mkdir -p generated && echo 1 > generated/x'],
          },
        ],
      },
      {
        id: 'reader',
        profile: 'reader',
        workspace: 'shared-readonly',
        verify: [{ name: 'clean', argv: ['sh', '-c', '! grep -q extra README.md && ! test -e generated'] }],
      },
    ],
  });

  const { status } = await supervise(context, runDir);
  const tasks = byId(status);
  const shared = tasks.mutator.latestAttempt.workspace;

  assert.equal(tasks.mutator.state, 'succeeded', tasks.mutator.failure?.message);
  assert.equal(tasks.reader.state, 'succeeded', tasks.reader.failure?.message);
  assert.equal(tasks.reader.latestAttempt.workspace, shared);
  assert.doesNotMatch(fs.readFileSync(path.join(shared, 'README.md'), 'utf8'), /extra/);

  assert.equal(
    fs.existsSync(path.join(runDir, 'workspaces', 'mutator', `${tasks.mutator.latestAttempt.id}-checks`)),
    false,
  );
});

test('a reader that leaves an ignored file in the shared checkout fails, and the next reader gets a fresh one', async (t) => {
  const context = setup(t, { 'README.md': '# demo\n', '.gitignore': '.cache/\n' });

  const runDir = await create(context, {
    limits: { concurrency: 1 },
    profiles: { reader: codexProfile({ sandbox: 'read-only' }) },
    tasks: [
      {
        id: 'litter',
        profile: 'reader',
        workspace: 'shared-readonly',
        fake: { writes: [{ path: '.cache/state.json', content: '{}\n' }] },
      },
      { id: 'reader', profile: 'reader', workspace: 'shared-readonly' },
    ],
  });

  const { status } = await supervise(context, runDir);
  const tasks = byId(status);

  assert.equal(tasks.litter.state, 'failed');
  assert.match(tasks.litter.failure.message, /a read-only task changed its input/);
  assert.equal(tasks.reader.state, 'succeeded', tasks.reader.failure?.message);
  assert.equal(path.basename(tasks.reader.latestAttempt.workspace), '_input-2');
  assert.equal(fs.existsSync(path.join(tasks.reader.latestAttempt.workspace, '.cache')), false);
});

test('a check that changes a live read-only root fails the task', async (t) => {
  const context = setup(t);

  const runDir = await create(context, {
    input: { root: context.repository, snapshot: 'none' },
    profiles: { reader: codexProfile({ sandbox: 'read-only' }) },
    tasks: [
      {
        id: 'look',
        profile: 'reader',
        workspace: 'shared-readonly',
        verify: [{ name: 'writes', argv: ['sh', '-c', 'echo extra >> README.md'] }],
      },
    ],
  });

  const { status } = await supervise(context, runDir);
  const [task] = status.tasks;

  assert.equal(task.state, 'failed');
  assert.match(task.failure.message, /the read-only input changed during verification/);
});

test('a read-only continuation on a live root that changed while blocked stays blocked and keeps its baseline', async (t) => {
  const context = setup(t);

  const runDir = await create(context, {
    input: { root: context.repository, snapshot: 'none' },
    profiles: { reader: codexProfile({ sandbox: 'read-only' }) },
    tasks: [{ id: 'look', profile: 'reader', workspace: 'shared-readonly', fake: { status: 'blocked' } }],
  });

  const first = await supervise(context, runDir);

  assert.equal(first.outcome, 'blocked');

  fs.appendFileSync(path.join(context.repository, 'README.md'), 'edited while blocked\n');

  const continueWith = (text) => {
    const control = Store.open(path.join(runDir, 'state.sqlite'));

    control.enqueueControl({ kind: 'continue', taskId: 'look', data: { promptText: text } });
    control.close();
  };

  continueWith('Go on.\n\nFAKE: {}\n');

  const second = await supervise(context, runDir);
  const [task] = second.status.tasks;

  assert.equal(second.outcome, 'blocked');
  assert.equal(task.attempts, 2);
  assert.match(task.blocker.reason, /changed since attempt .* started/);

  // the refused attempt inherited the first baseline, so continuing again on the still-changed root is refused too
  continueWith('Go on.\n\nFAKE: {}\n');

  const third = await supervise(context, runDir);

  assert.equal(third.outcome, 'blocked');
  assert.equal(third.status.tasks[0].attempts, 3);
  assert.match(third.status.tasks[0].blocker.reason, /changed since attempt/);
});

test('a failed read-only worker that changed its input is not retried on top of the change', async (t) => {
  const context = setup(t);

  const runDir = await create(context, {
    profiles: { reader: codexProfile({ sandbox: 'read-only' }) },
    tasks: [
      {
        id: 'look',
        profile: 'reader',
        workspace: 'shared-readonly',
        retry: { backoffMs: 0 },
        fake: { writes: [{ path: 'README.md', content: 'changed\n' }], codexFail: 'stream disconnected' },
      },
    ],
  });

  const { status } = await supervise(context, runDir);
  const [task] = status.tasks;

  assert.equal(task.state, 'failed');
  assert.equal(task.attempts, 1);
  assert.equal(task.failure.class, 'verification');
  assert.match(task.failure.message, /a read-only task changed its input/);
});

test('cleanup keeps a worktree with ignored files until they are discarded, and reports the retained refs', async (t) => {
  const context = setup(t, { 'README.md': '# demo\n', '.gitignore': 'scratch/\n' });

  const runDir = await create(context, {
    profiles: { codex: codexProfile() },
    tasks: [
      {
        id: 'one',
        profile: 'codex',
        fake: {
          writes: [
            { path: 'kept.txt', content: 'in the patch\n' },
            { path: 'scratch/notes.txt', content: 'only copy\n' },
          ],
        },
      },
    ],
  });

  const { outcome, status } = await supervise(context, runDir);
  const workspace = status.tasks[0].latestAttempt.workspace;

  assert.equal(outcome, 'succeeded');

  let result = await cleanupRun(runDir);

  assert.deepEqual(result.removed, []);
  assert.match(result.kept[0].reason, /ignored files that no patch preserves \(scratch\/\)/);
  assert.ok(fs.existsSync(path.join(workspace, 'scratch', 'notes.txt')));
  assert.ok(result.retained.refs.some((ref) => ref.endsWith('/input')));
  assert.match(result.retained.removeRefs, /update-ref --stdin/);

  result = await cleanupRun(runDir, { discardIgnored: true });

  assert.deepEqual(result.removed, [workspace]);
  assert.deepEqual(result.retained.worktrees, []);
});

test('in-place tasks are refused on a root without git history, before any run directory exists', async (t) => {
  const dir = makeTemporaryDir(t);
  const plain = path.join(dir, 'plain');

  fs.mkdirSync(plain);

  const file = writeManifest(dir, {
    input: { root: plain, snapshot: 'none' },
    profiles: { codex: codexProfile() },
    tasks: [{ id: 'edit', profile: 'codex', workspace: 'in-place', scope: ['src/**'] }],
  });

  await assert.rejects(createRun(file, { runsRoot: path.join(dir, 'runs') }), /git work tree with at least one commit/);
  assert.equal(fs.existsSync(path.join(dir, 'runs')), false);
});

test('a git input root below the top level of its work tree is refused by doctor and by run', async (t) => {
  const context = setup(t, { 'README.md': '# demo\n', 'pkg/app.js': 'export const value = 1;\n' });
  const nested = path.join(context.repository, 'pkg');

  const specs = [
    { input: { root: nested }, tasks: [{ id: 'edit', profile: 'codex' }] },
    { input: { root: nested, snapshot: 'none' }, tasks: [{ id: 'edit', profile: 'codex', workspace: 'in-place' }] },
  ];

  for (const spec of specs) {
    const dir = makeTemporaryDir(t);
    const file = writeManifest(dir, { profiles: { codex: codexProfile() }, ...spec });
    const { manifest } = loadManifest(file, { adapters: ADAPTERS });
    const { problems } = await preflightRun(manifest);

    assert.match(problems.join('\n'), /is not the top level of its git work tree/);
    assert.ok(problems.join('\n').includes(`use ${context.repository}`), 'the problem names the top level to use');

    await assert.rejects(
      createRun(file, { runsRoot: path.join(dir, 'runs') }),
      /not the top level of its git work tree/,
    );

    assert.equal(fs.existsSync(path.join(dir, 'runs')), false);
  }
});

test('a runs root inside the input is refused, because run records would enter its snapshots and audits', async (t) => {
  const context = setup(t);
  const file = writeManifest(context.dir, { tasks: [{ id: 'edit', profile: 'claude' }] });

  for (const runsRoot of [context.repository, path.join(context.dir, 'repo', 'nested', 'runs')]) {
    await assert.rejects(createRun(file, { runsRoot, env: context.env }), /is inside input\.root/);
  }

  assert.equal(fs.existsSync(path.join(context.repository, 'nested')), false, 'nothing was created in the input');
  assert.equal(git(context.repository, 'for-each-ref', 'refs/orchestrator'), '', 'no snapshot was pinned');
});

test('doctor reports a snapshot input that is not a git work tree, as run does', async (t) => {
  const dir = makeTemporaryDir(t);
  const plain = path.join(dir, 'plain');

  fs.mkdirSync(plain);

  const file = writeManifest(dir, {
    input: { root: plain },
    profiles: { codex: codexProfile() },
    tasks: [{ id: 'edit', profile: 'codex' }],
  });

  const { manifest } = loadManifest(file, { adapters: ADAPTERS });
  const { problems } = await preflightRun(manifest);

  assert.match(problems.join('\n'), /is not a git work tree/);
  await assert.rejects(createRun(file, { runsRoot: path.join(dir, 'runs') }), /is not a git work tree/);
});

test('a git command whose output exceeds the capture limit fails instead of returning part of it', async (t) => {
  const repository = makeTemporaryRepository(t);
  const whole = await runnerGit(repository, ['ls-files']);

  assert.equal(whole.ok, true);
  assert.equal(whole.stdout, 'README.md\nsrc/app.js\n');

  const cut = await runnerGit(repository, ['ls-files'], { maxOutputBytes: 4 });

  assert.equal(cut.ok, false, 'a listing cut short is not a listing');
  assert.match(cut.stderr, /output exceeded 4 bytes/);
});

test('the sandbox probe judges the sandbox itself, whatever the manifest makes writable', async () => {
  // with the home directory writable, a probe that tried an outside write there would report an escape
  assert.deepEqual(await probeSandbox({ mode: 'os', writableRoots: [os.homedir()] }), { ok: true, problems: [] });

  const unusable = await probeSandbox({ mode: 'os', writableRoots: ['/dev/null/cache'] });

  assert.equal(unusable.ok, false, 'a writable root that cannot be created is reported before any check runs');
});

test('new ignored files written in place are listed and scope-checked', async (t) => {
  const context = setup(t, { 'src/app.js': 'export const value = 1;\n', '.gitignore': 'build/\n' });

  const runDir = await create(context, {
    input: { root: context.repository, snapshot: 'none' },
    profiles: { codex: codexProfile() },
    tasks: [
      {
        id: 'edit',
        profile: 'codex',
        workspace: 'in-place',
        scope: ['src/**'],
        fake: {
          writes: [
            { path: 'src/app.js', content: 'export const value = 2;\n' },
            { path: 'build/out.txt', content: 'generated\n' },
          ],
        },
      },
    ],
  });

  const { status } = await supervise(context, runDir);
  const [task] = status.tasks;

  assert.equal(task.state, 'failed');
  assert.match(task.failure.message, /changes outside the declared scope: build\/out\.txt/);
});

test('checks run in an OS sandbox that refuses writes outside their workspace unless the manifest opts out', async (t) => {
  const outsideDir = fs.mkdtempSync(path.join(os.homedir(), '.orchestrator-sandbox-test-'));

  t.after(() => fs.rmSync(outsideDir, { recursive: true, force: true }));

  const target = path.join(outsideDir, 'escaped.txt');
  const escape = { name: 'escape', argv: ['sh', '-c', `echo escaped > ${JSON.stringify(target)}`] };

  const sandboxed = setup(t);

  const confined = await create(sandboxed, {
    profiles: { codex: codexProfile() },
    tasks: [{ id: 'one', profile: 'codex', verify: [escape] }],
  });

  const first = await supervise(sandboxed, confined);

  assert.equal(first.status.tasks[0].state, 'failed');
  assert.match(first.status.tasks[0].failure.message, /check escape failed/);
  assert.equal(fs.existsSync(target), false);

  const open = setup(t);

  const file = writeManifest(open.dir, {
    profiles: { codex: codexProfile() },
    tasks: [{ id: 'one', profile: 'codex', verify: [escape] }],
  });

  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));

  fs.writeFileSync(file, JSON.stringify({ ...manifest, checkSandbox: { mode: 'none' } }));

  const { runDir } = await createRun(file, { runsRoot: path.join(open.dir, 'runs'), env: open.env });
  const second = await supervise(open, runDir);

  assert.equal(second.status.tasks[0].state, 'succeeded');
  assert.equal(fs.readFileSync(target, 'utf8'), 'escaped\n');
  assert.match(fs.readFileSync(path.join(runDir, 'run.md'), 'utf8'), /Check sandbox: \*\*none\*\*/);
});

test('a claude allow rule that names a write tool without a path is refused, because it reaches beyond the workspace', (t) => {
  const dir = makeTemporaryDir(t);

  fs.mkdirSync(path.join(dir, 'repo'));

  const load = (overrides) =>
    loadManifest(
      writeManifest(dir, { profiles: { claude: claudeProfile(overrides) }, tasks: [{ id: 'one', profile: 'claude' }] }),
      { adapters: ADAPTERS },
    );

  for (const allowedTools of [['Read', 'Edit', 'Write'], ['Write'], ['NotebookEdit']]) {
    assert.throws(
      () => load({ tools: ['Read', 'Edit', 'Write', 'NotebookEdit'], allowedTools }),
      /approves file writes anywhere on disk.*acceptEdits already approves edits inside the working directory/,
      allowedTools.join(', '),
    );
  }

  // claude applies an Edit rule to every file-editing tool, so it counts while any of them is available
  assert.throws(
    () => load({ tools: ['Read', 'Write'], allowedTools: ['Edit'] }),
    /approves file writes anywhere on disk/,
  );

  // a rule with a path stays inside it, and a rule for a tool that the session does not have approves nothing
  load({ allowedTools: ['Read', 'Edit(src/**)', 'Write(docs/**)'] });
  load({ tools: ['Read'], allowedTools: ['Read', 'Edit'] });
  load({ disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'], allowedTools: ['Write'] });
  load({ allowedTools: ['Read', 'Edit'], externalSandbox: true });
});

test('a claude profile that can edit files and auto-run Bash needs its Bash sandbox', (t) => {
  const dir = makeTemporaryDir(t);

  fs.mkdirSync(path.join(dir, 'repo'));

  const unsafe = claudeProfile({
    tools: ['Read', 'Edit', 'Bash'],
    allowedTools: ['Read', 'Bash(npm test:*)'],
  });

  const file = (profile) =>
    writeManifest(dir, { profiles: { claude: profile }, tasks: [{ id: 'one', profile: 'claude' }] });

  assert.throws(() => loadManifest(file(unsafe), { adapters: ADAPTERS }), /set bashSandbox: true/);

  // a scoped Edit rule still approves writes, and Claude applies it to every file-editing tool
  assert.throws(
    () =>
      loadManifest(
        file({
          ...unsafe,
          permissionMode: 'default',
          tools: ['Edit', 'Bash'],
          allowedTools: ['Edit(scripts/**)', 'Bash(node scripts/check.mjs)'],
        }),
        { adapters: ADAPTERS },
      ),
    /set bashSandbox: true/,
  );

  assert.throws(
    () =>
      loadManifest(
        file({
          ...unsafe,
          tools: ['Read', 'Write', 'Bash'],
          permissionMode: 'default',
          allowedTools: ['Write', 'Bash'],
        }),
        { adapters: ADAPTERS },
      ),
    /set bashSandbox: true/,
  );

  const { manifest } = loadManifest(file({ ...unsafe, bashSandbox: true }), { adapters: ADAPTERS });

  const argv = claude.buildInvocation({
    profile: { ...manifest.profiles.claude, executable: ['claude'] },
    schemaText: '{}',
  }).argv;

  const settings = JSON.parse(argv[argv.indexOf('--settings') + 1]);

  assert.deepEqual(settings, { sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false } });

  // running Bash without editing, or editing without auto-approved Bash, needs no sandbox
  loadManifest(
    file({ ...unsafe, tools: ['Read', 'Bash'], allowedTools: ['Read', 'Bash(npm test:*)'], permissionMode: 'default' }),
    {
      adapters: ADAPTERS,
    },
  );

  loadManifest(file(claudeProfile()), { adapters: ADAPTERS });
});

test('a git filter driver that runs a tracked script is sandboxed during snapshots and can still write the LFS store', async (t) => {
  const outsideDir = fs.mkdtempSync(path.join(os.homedir(), '.orchestrator-filter-test-'));

  t.after(() => fs.rmSync(outsideDir, { recursive: true, force: true }));

  const target = path.join(outsideDir, 'escaped.txt');

  const store =
    'mkdir -p "$(git rev-parse --git-common-dir)/lfs/objects" && date > "$(git rev-parse --git-common-dir)/lfs/objects/marker"';

  const context = setup(t, {
    'README.md': '# demo\n',
    '.gitattributes': '*.dat filter=fake\n',
    'clean.sh': `${store}\ncat\n`,
  });

  git(context.repository, 'config', 'filter.fake.clean', 'sh ./clean.sh');

  const runDir = await create(context, {
    profiles: { codex: codexProfile() },
    tasks: [
      {
        id: 'one',
        profile: 'codex',
        fake: {
          writes: [
            {
              path: 'clean.sh',
              content: [
                `echo escaped > ${JSON.stringify(target)} 2>/dev/null`,

                // the repository lives under $TMPDIR, so this only fails if the shared git directory is protected
                `echo '[orch] tampered = true' >> "$(git rev-parse --git-common-dir)/config" 2>/dev/null`,
                store,
                'cat',
                '',
              ].join('\n'),
            },
            { path: 'data.dat', content: 'payload\n' },
          ],
        },
      },

      // preparing a dependent applies that patch and resets its index, which runs the filter again
      {
        id: 'two',
        profile: 'codex',
        dependsOn: ['one'],
        fake: { writes: [{ path: 'more.dat', content: 'more\n' }] },
      },
    ],
    integration: { checks: [] },
  });

  const { outcome, status } = await supervise(context, runDir);

  assert.equal(outcome, 'succeeded', JSON.stringify(status.tasks.map((task) => task.failure)));
  assert.equal(status.integration.status, 'passed');
  assert.equal(fs.existsSync(target), false, 'the worker-edited filter script wrote outside the sandbox');
  assert.doesNotMatch(fs.readFileSync(path.join(context.repository, '.git', 'config'), 'utf8'), /tampered/);
  assert.ok(fs.existsSync(path.join(context.repository, '.git', 'lfs', 'objects', 'marker')));
  assert.match(fs.readFileSync(status.tasks[0].latestAttempt.patch.path, 'utf8'), /^\+payload$/m);
});

test("the runner's git commands never run a configured fsmonitor command", async (t) => {
  const context = setup(t, { 'README.md': '# demo\n', 'fsmon.sh': 'exit 1\n' });
  const marker = path.join(context.dir, 'fsmonitor-ran');

  git(context.repository, 'config', 'core.fsmonitor', 'sh ./fsmon.sh');

  const runDir = await create(context, {
    profiles: { codex: codexProfile(), reader: codexProfile({ sandbox: 'read-only' }) },
    tasks: [
      {
        id: 'one',
        profile: 'codex',
        fake: { writes: [{ path: 'fsmon.sh', content: `touch ${JSON.stringify(marker)}\nexit 1\n` }] },
      },
      { id: 'look', profile: 'reader', workspace: 'shared-readonly', dependsOn: ['one'] },
    ],
    integration: { checks: [] },
  });

  const { outcome } = await supervise(context, runDir);

  await cleanupRun(runDir, { discardIgnored: true });

  assert.equal(outcome, 'succeeded');
  assert.equal(fs.existsSync(marker), false, 'a worker-edited fsmonitor script ran on the host');
});

test('sandbox prefixes create configured roots, mask host service sockets on Linux, and shell quoting is literal', (t) => {
  const dir = makeTemporaryDir(t);
  const cache = path.join(dir, 'cache', 'tool');
  const prefix = sandboxPrefix({ mode: 'os', writableRoots: [cache] }, { cwd: dir });

  assert.ok(fs.existsSync(cache), 'a configured writable root that did not exist is created');
  assert.ok(prefix.length > 0);

  const linux = linuxPrefix([dir]);

  assert.deepEqual(linux.slice(0, 8), [
    'bwrap',
    '--die-with-parent',
    '--ro-bind',
    '/',
    '/',
    '--dev-bind',
    '/dev',
    '/dev',
  ]);

  assert.ok(linux.join(' ').includes('--unsetenv DBUS_SESSION_BUS_ADDRESS'));
  assert.ok(linux.join(' ').includes(`--bind ${dir} ${dir}`));
  assert.ok(linux.indexOf('--unsetenv') < linux.indexOf('--bind'));
  assert.equal(linux.at(-1), '--');

  assert.equal(shellQuote(`/tmp/it's $HOME/\`x\``), String.raw`'/tmp/it'\''s $HOME/` + '`x`' + "'");
});

test('the protocol footer describes the generic envelope only when the task uses it', () => {
  const generic = protocolFooter({ taskId: 't', attemptId: 'a-1', kind: 'initial' });
  const custom = protocolFooter({ taskId: 't', attemptId: 'a-1', kind: 'initial', generic: false });

  assert.match(generic, /blocker\.reason/);
  assert.doesNotMatch(custom, /blocker|`files`|`status`/);
  assert.match(custom, /Task id: `t`/);
});

test('a boot id rules a process out only when both sides know theirs', () => {
  const a = '2b0a361b-4bcc-43f1-85b5-0c5cc3a57995';
  const b = '3c1b472c-5cdd-44f2-96c6-1d6dd4b68aa6';

  assert.equal(sameBoot(a, a), true);
  assert.equal(sameBoot(a, b), false);
  assert.equal(sameBoot('unknown', a), true);
  assert.equal(sameBoot(a, 'unknown'), true);
  assert.equal(sameBoot(undefined, a), true, 'a receipt without a boot id defers to the start time');
});

test('the runtime check refuses Node releases below the minimum that package.json declares, and other platforms', () => {
  const { engines } = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));

  assert.equal(engines.node, `>=${MINIMUM_NODE.major}.${MINIMUM_NODE.minor}.0`);

  assert.match(
    checkRuntime({ version: '24.14.1' }).problems.join('\n'),
    /Node 24\.14\.1 is too old; the runner needs 24\.15 or later/,
  );

  assert.match(checkRuntime({ version: '22.22.3' }).problems.join('\n'), /too old/);

  for (const version of ['24.15.0', '25.0.0', '26.8.0-alpha.0.0.0']) {
    for (const platform of ['darwin', 'linux']) {
      assert.deepEqual(checkRuntime({ version, platform }), { node: `v${version}`, platform, problems: [] });
    }
  }

  assert.deepEqual(checkRuntime({ version: '24.15.0', platform: 'win32' }).problems, [
    'the runner supports macOS and Linux, not win32',
  ]);

  assert.deepEqual(checkRuntime().problems, [], 'the tests themselves run on a supported runtime');
});
