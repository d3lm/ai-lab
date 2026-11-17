import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OrchestratorError, sha256, sha256File } from './contracts.mjs';
import { runBounded } from './process.mjs';
import { sandboxPrefix } from './sandbox.mjs';

// fixed identity and dates make snapshot commits content-addressed and independent of user git config
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'orchestrator',
  GIT_AUTHOR_EMAIL: 'orchestrator@localhost',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'orchestrator',
  GIT_COMMITTER_EMAIL: 'orchestrator@localhost',
  GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  LC_ALL: 'C',
};

const MAX_GIT_OUTPUT = 64 * 1024 * 1024;

// git runs asynchronously so the supervisor keeps renewing its lease while a long command runs
export async function git(
  cwd,
  args,
  { env = {}, input = null, timeoutMs = 300_000, prefix = [], maxOutputBytes = MAX_GIT_OUTPUT } = {},
) {
  // hooks and the fsmonitor command are configured programs git would run on the host, so both are switched off
  const result = await runBounded(
    [...prefix, 'git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
    {
      cwd,
      env: { ...process.env, ...GIT_ENV, ...env },
      input,
      timeoutMs,
      maxOutputBytes,
      capture: true,
    },
  );

  // callers act on listings and trees, so output that was cut at the limit is a failure and never a shorter answer
  if (result.truncated) {
    return { ok: false, code: result.code, stdout: '', stderr: `output exceeded ${maxOutputBytes} bytes` };
  }

  return {
    ok: result.code === 0,
    code: result.code,
    stdout: result.stdout ?? '',
    stderr: result.spawnError ?? (result.stderr || (result.timedOut ? 'timed out' : '')),
  };
}

async function gitOrThrow(cwd, args, options) {
  const result = await git(cwd, args, options);

  if (!result.ok) {
    throw new OrchestratorError(
      'launch',
      `git ${args.join(' ')} failed in ${cwd}: ${result.stderr.trim().slice(0, 500)}`,
    );
  }

  return result.stdout.trim();
}

export async function isGitWorkTree(dir) {
  const result = await git(dir, ['rev-parse', '--is-inside-work-tree']);

  return result.ok && result.stdout.trim() === 'true';
}

export async function resolveCommit(root, revision) {
  return gitOrThrow(root, ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`]);
}

let snapshotSandbox = null;

const filterSandboxCache = new Map();

/**
 * Snapshots run the repository's clean and process filter drivers, and a driver that calls
 * a tracked script runs whatever a worker wrote into it. When the check sandbox is on and
 * the repository configures such a driver, the snapshot's git commands run in the sandbox
 * with write access only to the private index, the object store, and the Git LFS store.
 */
export function configureSnapshotSandbox(config) {
  snapshotSandbox = config ?? null;

  filterSandboxCache.clear();
}

/**
 * Returns the sandbox prefix for a git command in `dir` that may run filter drivers on worker-written files,
 * or an empty prefix when the sandbox is off or no driver is configured. With `worktree`, the command may
 * also write the files of `dir` and the linked worktree's private git directory (its index and HEAD), never
 * the shared one.
 */
async function filterPrefix(dir, { worktree = false, writable = [] } = {}) {
  if (!snapshotSandbox || snapshotSandbox.mode === 'none') {
    return [];
  }

  const common = await gitOrThrow(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);

  if (!filterSandboxCache.has(common)) {
    const drivers = await filterDrivers(dir);

    filterSandboxCache.set(common, drivers.length > 0);
  }

  if (!filterSandboxCache.get(common)) {
    return [];
  }

  // bwrap binds only existing paths, so the LFS store is created now rather than by a filter under a read-only parent
  const objects = path.join(common, 'objects');
  const lfs = path.join(common, 'lfs');

  fs.mkdirSync(lfs, { recursive: true });

  const roots = [...writable, objects, lfs];

  if (worktree) {
    const gitDir = await gitOrThrow(dir, ['rev-parse', '--path-format=absolute', '--git-dir']);

    if (gitDir === common) {
      throw new OrchestratorError('launch', `${dir} is not a linked worktree, so its git directory cannot be confined`);
    }

    roots.push(gitDir);
  }

  // the blanket temporary directories are left out, so a repository that lives under one keeps its .git protected
  return sandboxPrefix(snapshotSandbox, { cwd: dir, cwdWritable: worktree, temporary: false, writable: roots });
}

// commands that update a linked worktree's files or index can run filters on content a worker wrote
export async function gitInWorktree(dir, args) {
  return git(dir, args, { prefix: await filterPrefix(dir, { worktree: true }) });
}

// the index starts from `startCommit` so tracked-but-ignored files stay in the tree
export async function snapshotTree(dir, startCommit) {
  const indexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-index-'));
  const env = { GIT_INDEX_FILE: path.join(indexDir, 'index') };

  try {
    // write-tree can run the filters again for racily clean entries, so every step shares the sandbox
    const prefix = await filterPrefix(dir, { writable: [indexDir] });

    await gitOrThrow(dir, ['read-tree', startCommit], { env, prefix });
    await gitOrThrow(dir, ['add', '-A', '--', '.'], { env, prefix });

    return await gitOrThrow(dir, ['write-tree'], { env, prefix });
  } finally {
    fs.rmSync(indexDir, { recursive: true, force: true });
  }
}

export async function commitTree(dir, tree, parent, message) {
  return gitOrThrow(dir, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message]);
}

export async function treeOf(dir, commit) {
  return gitOrThrow(dir, ['rev-parse', `${commit}^{tree}`]);
}

export async function pinRef(root, ref, commit) {
  await gitOrThrow(root, ['update-ref', ref, commit]);
}

/**
 * Names what makes `root` unusable as the input of a run, or returns null. Snapshots, worktrees,
 * and the change audit of an in-place task all cover a whole git work tree, so a git input must be
 * the top level of its work tree. An input below it would hide every change outside that directory
 * from the snapshot and from the audit.
 */
export async function inputProblem({ root, snapshot, inPlace = false }) {
  const needsHistory = `in-place tasks need input.root ${root} to be a git work tree with at least one commit, so their changes can be captured and scope-checked`;

  if (!(await isGitWorkTree(root))) {
    if (snapshot !== 'none') {
      return `input.root ${root} is not a git work tree; worktree tasks need git (or set input.snapshot to "none")`;
    }

    return inPlace ? needsHistory : null;
  }

  const prefix = await gitOrThrow(root, ['rev-parse', '--show-prefix']);

  if (prefix) {
    const top = await gitOrThrow(root, ['rev-parse', '--show-toplevel']);

    return `input.root ${root} is not the top level of its git work tree; use ${top} and name ${prefix} in the prompts and scopes`;
  }

  const head = inPlace ? await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']) : null;

  return head && !head.ok ? needsHistory : null;
}

export async function prepareRunInput({ root, revision, snapshot, runId, inPlace = false }) {
  const problem = await inputProblem({ root, snapshot, inPlace });

  if (problem) {
    throw new OrchestratorError('manifest', problem);
  }

  if (snapshot === 'none') {
    return { snapshot, root, commit: null, tree: null, git: await isGitWorkTree(root) };
  }

  const head = await resolveCommit(root, revision);
  const result = { snapshot, root, revision, head, git: true, untracked: [], dirty: false };

  if (snapshot === 'revision') {
    result.commit = head;
    result.tree = await treeOf(root, head);
  } else {
    const listing = await gitOrThrow(root, ['ls-files', '--others', '--exclude-standard', '-z']);
    const untracked = listing.split('\0').filter(Boolean);

    const tree = await snapshotTree(root, head);

    result.untracked = untracked;
    result.tree = tree;
    result.dirty = tree !== (await treeOf(root, head));

    result.commit = result.dirty
      ? await commitTree(root, tree, head, `orchestrator input snapshot for ${runId}`)
      : head;
  }

  // no branch may reach the input commit, so this ref keeps git gc from pruning it while the run needs it
  await pinRef(root, `refs/orchestrator/${runId}/input`, result.commit);

  return result;
}

export async function addWorktree(root, dir, commit) {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await gitOrThrow(root, ['worktree', 'add', '--detach', dir, commit]);
}

export async function removeWorktree(root, dir) {
  const result = await git(root, ['worktree', 'remove', '--force', dir]);

  if (!result.ok && fs.existsSync(dir)) {
    throw new OrchestratorError('storage', `cannot remove worktree ${dir}: ${result.stderr.trim()}`);
  }

  await git(root, ['worktree', 'prune']);
}

export async function applyPatches(dir, patches) {
  for (const patch of patches) {
    const actual = sha256File(patch.path);

    if (actual !== patch.sha256) {
      throw new OrchestratorError(
        'uncertain',
        `artifact ${patch.path} hash mismatch (expected ${patch.sha256}, found ${actual})`,
      );
    }

    if (fs.statSync(patch.path).size === 0) {
      continue;
    }

    // reading the preimage from the worktree runs clean filters, whose scripts an earlier patch may have changed
    const check = await gitInWorktree(dir, ['apply', '--check', '--binary', '--whitespace=nowarn', patch.path]);

    if (!check.ok) {
      return {
        ok: false,
        conflict: { taskId: patch.taskId, path: patch.path, message: check.stderr.trim().slice(0, 4000) },
      };
    }

    const applied = await gitInWorktree(dir, ['apply', '--binary', '--whitespace=nowarn', patch.path]);

    if (!applied.ok) {
      throw new OrchestratorError(
        'launch',
        `git apply ${patch.path} failed in ${dir}: ${applied.stderr.trim().slice(0, 500)}`,
      );
    }
  }

  return { ok: true };
}

/**
 * User and repository configuration can change what `git diff` prints (diff.noprefix, mnemonic or custom
 * prefixes, textconv drivers, ignored submodules, relative paths), so every option that shapes a patch
 * is pinned here.
 */
const PATCH_FORMAT = Object.freeze([
  '--binary',
  '--full-index',
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--no-renames',
  '--no-relative',
  '--ignore-submodules=none',
  '--src-prefix=a/',
  '--dst-prefix=b/',
]);

/**
 * Applies the patch to `baseTree` in a private index and requires the result to be exactly `tree`,
 * so a patch that would land files at other paths or with other contents is never accepted.
 */
export async function assertPatchReproduces({ dir, patchFile, baseTree, tree }) {
  const indexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-roundtrip-'));
  const env = { GIT_INDEX_FILE: path.join(indexDir, 'index') };

  try {
    await gitOrThrow(dir, ['read-tree', baseTree], { env });

    if (fs.statSync(patchFile).size > 0) {
      await gitOrThrow(dir, ['apply', '--cached', '--binary', '--whitespace=nowarn', patchFile], { env });
    }

    const result = await gitOrThrow(dir, ['write-tree'], { env });

    if (result !== tree) {
      throw new OrchestratorError(
        'uncertain',
        `patch ${patchFile} does not reproduce its tree (applying it to ${baseTree} gives ${result}, expected ${tree})`,
      );
    }
  } finally {
    fs.rmSync(indexDir, { recursive: true, force: true });
  }
}

// git's binary diff is used so binary files, deletions, renames, modes, symlinks, and new files all survive the patch
export async function captureChange({ dir, baseTree, startCommit, patchFile, maxBytes }) {
  const tree = await snapshotTree(dir, startCommit);

  // write beside the target and rename, so a re-verification after a crash replaces the earlier read-only file
  const temporary = `${patchFile}.${process.pid}.tmp`;

  fs.mkdirSync(path.dirname(patchFile), { recursive: true });

  await gitOrThrow(dir, ['diff', ...PATCH_FORMAT, `--output=${temporary}`, baseTree, tree]);

  const bytes = fs.statSync(temporary).size;

  if (bytes > maxBytes) {
    fs.rmSync(temporary, { force: true });
    throw new OrchestratorError('budget', `patch artifact is ${bytes} bytes, above the ${maxBytes}-byte limit`);
  }

  try {
    await assertPatchReproduces({ dir, patchFile: temporary, baseTree, tree });
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }

  fs.chmodSync(temporary, 0o444);
  fs.renameSync(temporary, patchFile);

  const nameStatus = await gitOrThrow(dir, [
    'diff',
    '--name-status',
    '-z',
    '-M',
    '--no-relative',
    '--ignore-submodules=none',
    baseTree,
    tree,
  ]);

  const status = nameStatus.split('\0').filter(Boolean);

  const changes = [];

  let index = 0;

  while (index < status.length) {
    const code = status[index++];

    if (code.startsWith('R') || code.startsWith('C')) {
      changes.push({ status: code[0], from: status[index++], path: status[index++] });
    } else {
      changes.push({ status: code, path: status[index++] });
    }
  }

  return { tree, patchFile, sha256: sha256File(patchFile), bytes, changes };
}

/**
 * Lists untracked files that git ignores. Snapshots and patches never contain them, so callers that
 * delete a workspace or audit a live root must look at them separately. With `collapse`, a wholly
 * ignored directory is listed once, with a trailing slash, and otherwise every file is listed.
 */
export async function ignoredPaths(dir, { collapse = true } = {}) {
  const listing = await gitOrThrow(dir, [
    'ls-files',
    '--others',
    '--ignored',
    '--exclude-standard',
    ...(collapse ? ['--directory'] : []),
    '-z',
  ]);

  return listing.split('\0').filter(Boolean).toSorted();
}

/**
 * Names the git filter drivers whose clean or process command runs on the host whenever the runner
 * snapshots a tree. They come from the user's own git configuration, but a driver that invokes a
 * tracked script runs whatever a worker wrote into that script.
 */
export async function filterDrivers(root) {
  const result = await git(root, ['config', '--get-regexp', String.raw`^filter\..*\.(clean|process)$`]);

  if (!result.ok) {
    return [];
  }

  return result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const space = line.indexOf(' ');

      return { key: line.slice(0, space), command: line.slice(space + 1) };
    });
}

function globToRegExp(pattern) {
  let source = '';

  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];

    if (char === '*' && pattern[index + 1] === '*') {
      const slash = pattern[index + 2] === '/';

      source += slash ? '(?:.*/)?' : '.*';
      index += slash ? 2 : 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replaceAll(/[.+^${}()|[\]\\]/g, String.raw`\$&`);
    }
  }

  if (pattern.endsWith('/')) {
    source += '.*';
  }

  return new RegExp(`^${source}$`);
}

// both sides of a rename are checked so a rename cannot remove a file outside the scope
export function scopeViolations(changes, scope) {
  if (!scope) {
    return [];
  }

  const patterns = scope.map((pattern) => globToRegExp(pattern));
  const covered = (file) => patterns.some((pattern) => pattern.test(file));
  const paths = changes.flatMap((change) => (change.from ? [change.from, change.path] : [change.path]));

  return [...new Set(paths.filter((file) => !covered(file)))];
}

const DIGEST_SKIP = new Set(['.git', 'node_modules']);

// a read-only input outside git has no commit to compare against, so its mutation is detected by this digest
export function directoryDigest(root, { maxFiles = 50_000 } = {}) {
  const entries = [];

  const walk = (dir) => {
    const sorted = fs.readdirSync(dir, { withFileTypes: true }).toSorted((a, b) => a.name.localeCompare(b.name));

    for (const entry of sorted) {
      if (DIGEST_SKIP.has(entry.name)) {
        continue;
      }

      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full);

      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isSymbolicLink()) {
        entries.push(`l ${relative} ${fs.readlinkSync(full)}`);
      } else if (entry.isFile()) {
        const stat = fs.statSync(full);

        entries.push(`f ${relative} ${stat.mode.toString(8)} ${sha256File(full)}`);
      }

      if (entries.length > maxFiles) {
        throw new OrchestratorError('budget', `input ${root} has more than ${maxFiles} files; use a git input instead`);
      }
    }
  };

  walk(root);

  return sha256(entries.join('\n'));
}

export async function workspaceFingerprint(dir, { gitRepo, startCommit }) {
  if (gitRepo) {
    return `tree:${await snapshotTree(dir, startCommit ?? 'HEAD')}`;
  }

  return `digest:${directoryDigest(dir)}`;
}

const IGNORED_MARK = '|ignored:';

// ignored files are outside the tree, so their names, sizes, and modification times are digested on their own
async function ignoredDigest(dir) {
  const entries = [];
  const files = await ignoredPaths(dir, { collapse: false });

  for (const file of files) {
    try {
      const stat = fs.lstatSync(path.join(dir, file));

      entries.push(`${file}\t${stat.size}\t${stat.mtimeMs}`);
    } catch {
      entries.push(`${file}\tmissing`);
    }
  }

  return sha256(entries.join('\n'));
}

/**
 * Fingerprints the input of a read-only task. For a git workspace it covers the tracked and
 * untracked tree and also the ignored files, so a reader or a check that leaves generated
 * files behind is caught.
 */
export async function readOnlyFingerprint(dir, { gitRepo, startCommit }) {
  const base = await workspaceFingerprint(dir, { gitRepo, startCommit });

  return gitRepo ? `${base}${IGNORED_MARK}${await ignoredDigest(dir)}` : base;
}

export async function fingerprintLike(dir, recorded, { startCommit }) {
  return readOnlyFingerprint(dir, { gitRepo: recorded.startsWith('tree:'), startCommit });
}
