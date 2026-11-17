import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const FAKE_CLI = path.join(HERE, 'fixtures', 'fake-cli.mjs');
export const ORCHESTRATOR = path.resolve(HERE, '..', 'scripts', 'orchestrator.mjs');

export function makeTemporaryDir(t, prefix = 'orch-test-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  return dir;
}

export function claudeProfile(overrides = {}) {
  return {
    adapter: 'claude-cli',
    executable: [process.execPath, FAKE_CLI],
    model: 'claude-test',
    effort: 'high',
    permissionMode: 'acceptEdits',
    permissionPrompts: 'none',
    tools: ['Read', 'Edit', 'Write'],
    allowedTools: ['Read'],
    maxBudgetUsd: 1,
    ...overrides,
  };
}

export function codexProfile(overrides = {}) {
  return {
    adapter: 'codex-cli',
    executable: [process.execPath, FAKE_CLI],
    model: 'codex-test',
    effort: 'high',
    sandbox: 'workspace-write',
    ...overrides,
  };
}

export function cursorProfile(overrides = {}) {
  return {
    adapter: 'cursor-cli',
    executable: [process.execPath, FAKE_CLI],
    model: 'cursor-test',
    sandbox: 'enabled',
    ...overrides,
  };
}

export function fakePrompt(directive = {}, text = 'Do the task.') {
  return `${text}\n\nFAKE: ${JSON.stringify(directive)}\n`;
}

export function git(cwd, ...args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });

  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }

  return result.stdout.trim();
}

const DEFAULT_REPO_FILES = Object.freeze({ 'README.md': '# demo\n', 'src/app.js': 'export const value = 1;\n' });

export function makeTemporaryRepository(t, files = DEFAULT_REPO_FILES) {
  const dir = makeTemporaryDir(t, 'orch-repo-');

  git(dir, 'init', '-q', '-b', 'main');

  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }

  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');

  t.after(() => {
    spawnSync('git', ['worktree', 'prune'], { cwd: dir });
  });

  return dir;
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// the limit only bounds a failing test, so it is generous enough for a machine that is busy with other work
export async function eventually(predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return false;
}

export function runCli(args, { cwd, env = {}, input } = {}) {
  const result = spawnSync(process.execPath, [ORCHESTRATOR, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    input,
    timeout: 120_000,
  });

  return { code: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr };
}

export function writeManifest(dir, { tasks, profiles, limits, integration, input, label = 'test run' }) {
  const manifest = {
    version: 1,
    label,
    input: input ?? { root: 'repo' },
    profiles: profiles ?? { claude: claudeProfile(), codex: codexProfile() },
    tasks: tasks.map((task) => {
      return {
        ...task,
        prompt: task.prompt ?? { text: fakePrompt(task.fake ?? {}, `Task ${task.id}.`) },
        fake: undefined,
      };
    }),
    ...(limits ? { limits } : {}),
    ...(integration ? { integration } : {}),
  };

  const file = path.join(dir, 'manifest.json');

  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));

  return file;
}

export function readFakeLog(file) {
  if (!fs.existsSync(file)) {
    return [];
  }

  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function spawnCli(t, args, { env = {} } = {}) {
  const child = spawn(process.execPath, [ORCHESTRATOR, ...args], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // a failed assertion would leave the command running, and its open pipes would keep the test process alive
  t.after(() => child.kill('SIGKILL'));

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });

  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const done = new Promise((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });

  return { child, done };
}
