/**
 * Runs bounded smoke tests against the real Claude Code, Codex, and Cursor CLIs. They invoke
 * models, use the authentication and permission settings already configured on this machine, and
 * cost money, so they run only when ORCHESTRATOR_PROVIDER_TESTS=1 is set, as in this command:
 *
 * ```sh
 * ORCHESTRATOR_PROVIDER_TESTS=1 npm run test:providers
 * ```
 *
 * Each worker gets a small budget (claude) and a short deadline, and prompts ask for one
 * tiny file. Models follow the skill defaults, but effort is lowered to keep the runs
 * short. Add `--test-name-pattern cursor` to run only the cursor-agent tests.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { statusSnapshot } from '../../scripts/lib/report.mjs';
import { Store } from '../../scripts/lib/store.mjs';
import { Supervisor, createRun } from '../../scripts/lib/supervisor.mjs';
import { eventually, isAlive, makeTemporaryDir, makeTemporaryRepository } from '../helpers.mjs';

const enabled = process.env.ORCHESTRATOR_PROVIDER_TESTS === '1';

const PROFILES = {
  claude: {
    adapter: 'claude-cli',
    model: 'claude-fable-5-1',
    effort: 'low',
    permissionMode: 'acceptEdits',
    permissionPrompts: 'none',
    tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write'],
    allowedTools: ['Read', 'Glob', 'Grep'],
    maxBudgetUsd: 0.5,
  },
  codex: { adapter: 'codex-cli', model: 'gpt-6-astra', effort: 'low', sandbox: 'workspace-write' },
  cursor: { adapter: 'cursor-cli', model: 'claude-opus-5-5-low', sandbox: 'enabled' },
};

function manifest(dir, spec) {
  const file = path.join(dir, 'manifest.json');

  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      label: 'provider smoke',
      input: { root: 'repo' },
      limits: { concurrency: 2, attemptDeadlineMs: 600_000, runDeadlineMs: 1_800_000, terminateGraceMs: 5000 },
      profiles: PROFILES,
      ...spec,
    }),
  );

  return file;
}

function setup(t) {
  const dir = makeTemporaryDir(t, 'orch-smoke-');
  const repository = makeTemporaryRepository(t, { 'README.md': '# smoke\n' });

  fs.symlinkSync(repository, path.join(dir, 'repo'));

  return { dir, repository, runs: path.join(dir, 'runs') };
}

async function supervise(runDir) {
  const supervisor = new Supervisor(runDir, { pollMs: 250 });

  try {
    const result = await supervisor.supervise();

    return { ...result, status: statusSnapshot(supervisor.store) };
  } finally {
    supervisor.close();
  }
}

test(
  'a mixed claude -> codex dependency run produces, hands off, and integrates real changes',
  { skip: !enabled },
  async (t) => {
    const context = setup(t);

    const file = manifest(context.dir, {
      tasks: [
        {
          id: 'hello',
          profile: 'claude',
          prompt: {
            text: 'Create a file named hello.txt containing exactly the line: hello from claude\nDo not change any other file.',
          },
          scope: ['hello.txt'],
          verify: [{ name: 'hello', argv: ['grep', '-qx', 'hello from claude', 'hello.txt'] }],
        },
        {
          id: 'reply',
          profile: 'codex',
          dependsOn: ['hello'],
          prompt: {
            text: 'hello.txt already exists. Create reply.txt containing exactly the line: hello from codex\nDo not change any other file.',
          },
          scope: ['reply.txt'],
          verify: [{ name: 'both', argv: ['sh', '-c', 'test -f hello.txt && grep -qx "hello from codex" reply.txt'] }],
        },
      ],
      integration: { checks: [{ name: 'combined', argv: ['sh', '-c', 'test -f hello.txt && test -f reply.txt'] }] },
    });

    const { runDir } = await createRun(file, { runsRoot: context.runs });
    const { outcome, status } = await supervise(runDir);

    assert.equal(outcome, 'succeeded', JSON.stringify(status.tasks, null, 2));
    assert.equal(status.integration.status, 'passed');

    const sessionsRecorded = status.tasks.every((task) => task.latestAttempt.providerSessionId);

    assert.ok(sessionsRecorded, 'sessions were recorded');
    assert.equal(fs.existsSync(path.join(context.repository, 'hello.txt')), false, 'the user checkout is untouched');
  },
);

test(
  'a blocked claude task continues in its saved session with the recorded profile',
  { skip: !enabled },
  async (t) => {
    const context = setup(t);

    const file = manifest(context.dir, {
      tasks: [
        {
          id: 'decide',
          profile: 'claude',
          prompt: {
            text: 'You need an operator decision before doing anything. Do not create or change files yet. Report status blocked with blocker.reason "waiting for the operator" and blocker.needs "say which word to write".',
          },
          verify: [{ name: 'word', argv: ['grep', '-qx', 'banana', 'word.txt'] }],
        },
      ],
    });

    const { runDir } = await createRun(file, { runsRoot: context.runs });
    const first = await supervise(runDir);

    assert.equal(first.outcome, 'blocked', JSON.stringify(first.status.tasks, null, 2));

    const sessionBefore = first.status.tasks[0].latestAttempt.providerSessionId;
    const store = Store.open(path.join(runDir, 'state.sqlite'));

    store.enqueueControl({
      kind: 'continue',
      taskId: 'decide',
      data: {
        promptText:
          'Decision: write the word banana. Create word.txt containing exactly the line: banana\nThen report done.',
      },
    });

    store.close();

    const second = await supervise(runDir);

    assert.equal(second.outcome, 'succeeded', JSON.stringify(second.status.tasks, null, 2));
    assert.equal(second.status.tasks[0].latestAttempt.kind, 'continuation');
    assert.equal(second.status.tasks[0].latestAttempt.providerSessionId, sessionBefore, 'the same session resumed');
  },
);

test(
  'a cursor worker blocks, continues in its saved chat, and produces a verified, integrated change',
  { skip: !enabled },
  async (t) => {
    const context = setup(t);

    const file = manifest(context.dir, {
      tasks: [
        {
          id: 'decide',
          profile: 'cursor',
          prompt: {
            text: 'You need an operator decision before doing anything. Do not create or change files yet. Report status blocked with blocker.reason "waiting for the operator" and blocker.needs "say which word to write".',
          },
          scope: ['word.txt'],
          verify: [{ name: 'word', argv: ['grep', '-qx', 'banana', 'word.txt'] }],
        },
      ],
      integration: { checks: [{ name: 'combined', argv: ['grep', '-qx', 'banana', 'word.txt'] }] },
    });

    const { runDir } = await createRun(file, { runsRoot: context.runs });
    const first = await supervise(runDir);

    assert.equal(first.outcome, 'blocked', JSON.stringify(first.status.tasks, null, 2));

    const sessionBefore = first.status.tasks[0].latestAttempt.providerSessionId;
    const store = Store.open(path.join(runDir, 'state.sqlite'));

    store.enqueueControl({
      kind: 'continue',
      taskId: 'decide',
      data: {
        promptText:
          'Decision: write the word banana. Create word.txt containing exactly the line: banana\nDo not change any other file. Then report done.',
      },
    });

    store.close();

    const second = await supervise(runDir);

    assert.equal(second.outcome, 'succeeded', JSON.stringify(second.status.tasks, null, 2));
    assert.equal(second.status.integration.status, 'passed');
    assert.ok(sessionBefore, 'a chat id was recorded');
    assert.equal(second.status.tasks[0].latestAttempt.providerSessionId, sessionBefore, 'the same chat resumed');
    assert.equal(fs.existsSync(path.join(context.repository, 'word.txt')), false, 'the user checkout is untouched');
  },
);

test(
  'no worker of any adapter can write outside its workspace with the default profiles',
  { skip: !enabled },
  async (t) => {
    const context = setup(t);

    // the temporary directories are writable in some provider sandboxes by design, so the target lies elsewhere
    const outside = fs.mkdtempSync(path.join(os.homedir(), '.orchestrator-smoke-outside-'));

    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));

    const task = (id) => {
      return {
        id,
        profile: id,
        prompt: {
          text: [
            'This is a permission test in a scratch area that the operator set up for it.',
            `First try to create the file ${path.join(outside, `${id}.txt`)} containing the line: outside`,
            'Use your file-writing tool for that, and a shell command as well if you have one.',
            'Whether or not that works, then create inside.txt in your working directory containing the line: inside',
            'Report done, and say in the summary whether the first write was allowed.',
          ].join('\n'),
        },
        verify: [{ name: 'inside', argv: ['grep', '-qx', 'inside', 'inside.txt'] }],
      };
    };

    const file = manifest(context.dir, {
      limits: { concurrency: 3, attemptDeadlineMs: 600_000, runDeadlineMs: 1_800_000, terminateGraceMs: 5000 },
      tasks: [task('claude'), task('codex'), task('cursor')],
    });

    const { runDir } = await createRun(file, { runsRoot: context.runs });
    const { outcome, status } = await supervise(runDir);

    assert.deepEqual(fs.readdirSync(outside), [], 'nothing was written outside the workspaces');
    assert.equal(outcome, 'succeeded', JSON.stringify(status.tasks, null, 2));
  },
);

test('cancelling a real cursor worker stops its process', { skip: !enabled }, async (t) => {
  const context = setup(t);

  const file = manifest(context.dir, {
    tasks: [
      {
        id: 'slow',
        profile: 'cursor',
        prompt: { text: 'Write a 2000-word essay about process supervision into essay.md, one paragraph at a time.' },
      },
    ],
  });

  const { runDir } = await createRun(file, { runsRoot: context.runs });
  const supervisor = new Supervisor(runDir, { pollMs: 250 });
  const running = supervisor.supervise();

  let pid = null;

  assert.ok(
    await eventually(() => {
      pid = supervisor.store.attempts('slow')[0]?.provider?.pid ?? null;

      return pid !== null;
    }, 120_000),
  );

  const control = Store.open(path.join(runDir, 'state.sqlite'));

  control.enqueueControl({ kind: 'cancel', taskId: 'slow' });
  control.close();

  const result = await running;

  supervisor.close();

  assert.equal(result.outcome, 'cancelled');
  assert.equal(isAlive(pid), false);
});

test('cancelling a real codex worker stops its process', { skip: !enabled }, async (t) => {
  const context = setup(t);

  const file = manifest(context.dir, {
    tasks: [
      {
        id: 'slow',
        profile: 'codex',
        prompt: { text: 'Write a 2000-word essay about process supervision into essay.md, one paragraph at a time.' },
      },
    ],
  });

  const { runDir } = await createRun(file, { runsRoot: context.runs });
  const supervisor = new Supervisor(runDir, { pollMs: 250 });
  const running = supervisor.supervise();

  let pid = null;

  assert.ok(
    await eventually(() => {
      pid = supervisor.store.attempts('slow')[0]?.provider?.pid ?? null;

      return pid !== null;
    }, 120_000),
  );

  const control = Store.open(path.join(runDir, 'state.sqlite'));

  control.enqueueControl({ kind: 'cancel', taskId: 'slow' });
  control.close();

  const result = await running;

  supervisor.close();

  assert.equal(result.outcome, 'cancelled');
  assert.equal(isAlive(pid), false);
});
