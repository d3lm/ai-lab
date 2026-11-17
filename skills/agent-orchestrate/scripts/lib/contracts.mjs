import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileSchema } from './json-schema.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const PACKAGE_ROOT = path.resolve(HERE, '..', '..');
export const SCHEMA_DIR = path.join(PACKAGE_ROOT, 'schemas');
export const GENERIC_RESULT_SCHEMA = path.join(SCHEMA_DIR, 'worker-result.schema.json');
export const PROTOCOL_VERSION = 1;

export const FAILURE_CLASSES = Object.freeze([
  'launch',
  'auth',
  'transient',
  'protocol',
  'verification',
  'budget',
  'cancellation',
  'uncertain',
  'conflict',
]);

export class OrchestratorError extends Error {
  constructor(category, message, details) {
    super(message);

    this.name = 'OrchestratorError';
    this.category = category;
    this.details = details;
  }
}

export class LeaseLostError extends OrchestratorError {
  constructor(message = 'supervisor ownership was lost to another process') {
    super('lease', message);

    this.name = 'LeaseLostError';
  }
}

export const TASK_STATES = Object.freeze([
  'pending',
  'ready',
  'running',
  'verifying',
  'succeeded',
  'blocked',
  'failed',
  'cancelled',
  'skipped',
  'recovery_required',
]);

export const TERMINAL_TASK_STATES = new Set(['succeeded', 'failed', 'cancelled', 'skipped']);

const TRANSITIONS = {
  pending: ['ready', 'skipped', 'cancelled'],
  ready: ['running', 'skipped', 'cancelled'],
  running: ['verifying', 'ready', 'blocked', 'failed', 'cancelled', 'recovery_required'],
  verifying: ['succeeded', 'ready', 'blocked', 'failed', 'cancelled', 'recovery_required'],
  blocked: ['ready', 'cancelled'],
  recovery_required: ['ready', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
  skipped: [],
};

export function canTransition(from, to) {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(taskId, from, to) {
  if (!canTransition(from, to)) {
    throw new OrchestratorError('state', `task ${taskId}: transition ${from} -> ${to} is not allowed`);
  }
}

/**
 * Attempt phases describe how far the launch protocol got.
 * `active` attempts own their task and session.
 * - In `prepared`, the row is reserved and the workspace is being prepared, but no
 *   process has started.
 * - In `launching`, the attempt host may have been spawned.
 * - In `running`, the attempt host has recorded the provider process.
 * - In `exited`, the exit receipt has been ingested.
 * - In `verifying`, results and artifacts are being checked.
 * - In `finished`, an outcome is committed and the attempt is no longer active.
 */
export const ATTEMPT_PHASES = Object.freeze(['prepared', 'launching', 'running', 'exited', 'verifying', 'finished']);

export const WORKSPACE_MODES = Object.freeze(['worktree', 'shared-readonly', 'in-place']);

export const CAPABILITIES = Object.freeze([
  'resume',
  'streaming-events',
  'structured-output',
  'enforced-cost-limit',
  'sandbox',
  'tool-policy',
  'active-turn-steering',
]);

export const DEFAULT_LIMITS = Object.freeze({
  concurrency: 2,
  runDeadlineMs: 4 * 60 * 60 * 1000,
  attemptDeadlineMs: 30 * 60 * 1000,
  checkDeadlineMs: 10 * 60 * 1000,
  terminateGraceMs: 10_000,
  maxStdoutBytes: 64 * 1024 * 1024,
  maxStderrBytes: 8 * 1024 * 1024,
  maxRecordBytes: 16 * 1024 * 1024,
  maxCheckOutputBytes: 4 * 1024 * 1024,
  maxArtifactBytes: 256 * 1024 * 1024,
  spendThresholdUsd: null,
});

// these claude tools write to the filesystem, so a read-only task must not have them available or auto-approved
export const CLAUDE_WRITE_TOOLS = Object.freeze(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function sha256File(file) {
  return sha256(fs.readFileSync(file));
}

// object keys are sorted so equal values hash equally
export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .toSorted()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}

// ids come from an injectable source so tests can make them deterministic
export function randomIds() {
  return {
    next: (prefix) => `${prefix}-${crypto.randomBytes(5).toString('hex')}`,
    nonce: () => crypto.randomBytes(16).toString('hex'),
  };
}

export function slugify(text, max = 40) {
  return (
    text
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, '-')
      .replaceAll(/^-|-$/g, '')
      .slice(0, max) || 'run'
  );
}

export function timestampSlug(date = new Date()) {
  return date.toISOString().replaceAll(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
}

const compiled = new Map();

export function compileResultSchema(schemaText) {
  const key = sha256(schemaText);

  if (!compiled.has(key)) {
    let schema;

    try {
      schema = JSON.parse(schemaText);
    } catch (error) {
      throw new OrchestratorError('manifest', `result schema is not valid JSON: ${error.message}`);
    }

    try {
      compiled.set(key, compileSchema(schema));
    } catch (error) {
      throw new OrchestratorError('manifest', `result schema does not compile: ${error.message}`);
    }
  }

  return compiled.get(key);
}

export function formatSchemaErrors(errors) {
  return (errors ?? [])
    .slice(0, 8)
    .map((error) => `${error.instancePath || '/'} ${error.message}`)
    .join('; ');
}

const packagedValidators = new Map();

function packagedSchemaErrors(name, value) {
  if (!packagedValidators.has(name)) {
    packagedValidators.set(name, compileSchema(JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, name), 'utf8'))));
  }

  return packagedValidators.get(name)(value);
}

function validateManifestShape(manifest) {
  const errors = packagedSchemaErrors('run.schema.json', manifest);

  if (errors.length > 0) {
    throw new OrchestratorError('manifest', `manifest is invalid: ${formatSchemaErrors(errors)}`, { errors });
  }
}

export function validateDecisionDocument(document) {
  const errors = packagedSchemaErrors('decision.schema.json', document);

  if (errors.length > 0) {
    throw new OrchestratorError('usage', `decision file is invalid: ${formatSchemaErrors(errors)}`, { errors });
  }
}

/**
 * Resolves a manifest-relative file reference and rejects paths that escape the manifest directory,
 * which is the artifact namespace for prompts and schemas.
 */
function resolveInNamespace(namespace, reference, what) {
  if (path.isAbsolute(reference)) {
    throw new OrchestratorError('manifest', `${what}: absolute paths are not allowed (${reference})`);
  }

  const resolved = path.resolve(namespace, reference);
  const relative = path.relative(namespace, resolved);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new OrchestratorError('manifest', `${what}: ${reference} escapes the manifest directory`);
  }

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new OrchestratorError('manifest', `${what}: file not found: ${reference}`);
  }

  const real = fs.realpathSync(resolved);
  const realRelative = path.relative(fs.realpathSync(namespace), real);

  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    throw new OrchestratorError('manifest', `${what}: ${reference} resolves outside the manifest directory`);
  }

  return real;
}

function validateScopePattern(taskId, pattern) {
  if (path.isAbsolute(pattern) || pattern.split('/').includes('..')) {
    throw new OrchestratorError('manifest', `task ${taskId}: scope pattern ${pattern} must be repository-relative`);
  }
}

export function topologicalOrder(tasks) {
  const remaining = new Map(tasks.map((task) => [task.id, new Set(task.dependsOn)]));
  const order = [];

  while (remaining.size > 0) {
    const next = tasks.find((task) => remaining.has(task.id) && remaining.get(task.id).size === 0);

    if (!next) {
      throw new OrchestratorError('manifest', `dependency cycle among tasks: ${[...remaining.keys()].join(', ')}`);
    }

    order.push(next.id);
    remaining.delete(next.id);

    for (const dependencies of remaining.values()) {
      dependencies.delete(next.id);
    }
  }

  return order;
}

export function transitiveDependencies(tasksById, id) {
  const seen = new Set();

  const visit = (current) => {
    for (const dependency of tasksById.get(current).dependsOn) {
      if (!seen.has(dependency)) {
        seen.add(dependency);
        visit(dependency);
      }
    }
  };

  visit(id);

  return seen;
}

// prompts and schemas are inlined with their hashes so the run no longer depends on the original files
export function normalizeManifest(raw, manifestDir, { adapters }) {
  validateManifestShape(raw);

  const namespace = fs.realpathSync(manifestDir);
  const root = path.resolve(namespace, raw.input.root);

  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new OrchestratorError('manifest', `input.root is not a directory: ${root}`);
  }

  const limits = { ...DEFAULT_LIMITS, ...raw.limits };
  const ids = new Set();

  for (const task of raw.tasks) {
    if (ids.has(task.id)) {
      throw new OrchestratorError('manifest', `duplicate task id: ${task.id}`);
    }

    ids.add(task.id);
  }

  const genericSchemaText = fs.readFileSync(GENERIC_RESULT_SCHEMA, 'utf8');
  const sessionProfiles = new Map();

  const tasks = raw.tasks.map((task) => {
    const profile = raw.profiles[task.profile];

    if (!profile) {
      throw new OrchestratorError('manifest', `task ${task.id}: unknown profile ${task.profile}`);
    }

    const dependsOn = task.dependsOn ?? [];

    for (const dependency of dependsOn) {
      if (!ids.has(dependency)) {
        throw new OrchestratorError('manifest', `task ${task.id}: unknown dependency ${dependency}`);
      }

      if (dependency === task.id) {
        throw new OrchestratorError('manifest', `task ${task.id}: depends on itself`);
      }
    }

    const adapter = adapters[profile.adapter];

    if (!adapter) {
      throw new OrchestratorError('manifest', `task ${task.id}: no adapter named ${profile.adapter}`);
    }

    const requires = task.requires ?? [];
    const unsupported = requires.filter((capability) => !adapter.capabilities.has(capability));

    if (unsupported.length > 0) {
      throw new OrchestratorError(
        'manifest',
        `task ${task.id}: adapter ${profile.adapter} does not support ${unsupported.join(', ')}`,
      );
    }

    if (task.session) {
      const previous = sessionProfiles.get(task.session);

      if (previous && previous !== task.profile) {
        throw new OrchestratorError(
          'manifest',
          `session ${task.session} is shared by tasks with different profiles (${previous}, ${task.profile})`,
        );
      }

      sessionProfiles.set(task.session, task.profile);
    }

    const workspace = task.workspace ?? 'worktree';

    let prompt;

    if (typeof task.prompt === 'string') {
      const file = resolveInNamespace(namespace, task.prompt, `task ${task.id} prompt`);

      prompt = { source: file, text: fs.readFileSync(file, 'utf8') };
    } else {
      prompt = { source: null, text: task.prompt.text };
    }

    let resultSchema;

    if (task.resultSchema) {
      const file = resolveInNamespace(namespace, task.resultSchema, `task ${task.id} resultSchema`);
      const text = fs.readFileSync(file, 'utf8');

      compileResultSchema(text);

      resultSchema = { kind: 'custom', source: file, text, sha256: sha256(text) };
    } else {
      resultSchema = {
        kind: 'generic',
        source: GENERIC_RESULT_SCHEMA,
        text: genericSchemaText,
        sha256: sha256(genericSchemaText),
      };
    }

    const scopePatterns = task.scope ?? [];

    for (const pattern of scopePatterns) {
      validateScopePattern(task.id, pattern);
    }

    const readOnly = workspace === 'shared-readonly';

    const retry = {
      maxAttempts: task.retry?.maxAttempts ?? (readOnly ? 2 : 1),
      on: task.retry?.on ?? ['transient'],
      backoffMs: task.retry?.backoffMs ?? 5000,
      safeToRepeat: task.retry?.safeToRepeat ?? readOnly,
    };

    if (retry.maxAttempts > 1 && !retry.safeToRepeat) {
      throw new OrchestratorError(
        'manifest',
        `task ${task.id}: retries of an editing task require retry.safeToRepeat: true`,
      );
    }

    return {
      id: task.id,
      profile: task.profile,
      dependsOn: task.dependsOn ?? [],
      workspace,
      session: task.session ?? null,
      prompt: { ...prompt, sha256: sha256(prompt.text) },
      resultSchema,
      scope: task.scope ?? null,
      verify: (task.verify ?? []).map((check) => {
        return { ...check, timeoutMs: check.timeoutMs ?? limits.checkDeadlineMs };
      }),
      requires,
      deadlineMs: task.deadlineMs ?? limits.attemptDeadlineMs,
      retry,
    };
  });

  const order = topologicalOrder(tasks);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const codeTasks = tasks.filter((task) => task.workspace !== 'shared-readonly').map((task) => task.id);

  let integration = null;

  if (raw.integration) {
    const integrationOrder = raw.integration.order ?? order.filter((id) => codeTasks.includes(id));

    for (const id of integrationOrder) {
      if (!byId.has(id)) {
        throw new OrchestratorError('manifest', `integration.order names unknown task ${id}`);
      }
    }

    for (const id of codeTasks) {
      if (!integrationOrder.includes(id)) {
        throw new OrchestratorError('manifest', `integration.order omits code-producing task ${id}`);
      }
    }

    for (const [index, id] of integrationOrder.entries()) {
      const dependencies = transitiveDependencies(byId, id);

      for (const dependency of dependencies) {
        if (integrationOrder.indexOf(dependency) > index) {
          throw new OrchestratorError('manifest', `integration.order puts ${id} before its dependency ${dependency}`);
        }
      }
    }

    integration = {
      order: integrationOrder,
      checks: (raw.integration.checks ?? []).map((check) => {
        return {
          ...check,
          timeoutMs: check.timeoutMs ?? limits.checkDeadlineMs,
        };
      }),
    };
  }

  // dependents apply patches in the integration order, so each builds on the combination integration will compose
  const composeOrder = integration?.order ?? order;

  const profiles = Object.fromEntries(
    Object.entries(raw.profiles).map(([name, profile]) => {
      validateProfilePolicy(name, profile);
      return [name, { ...profile }];
    }),
  );

  const snapshotPolicy =
    raw.input.snapshot ?? (tasks.some((task) => task.workspace === 'in-place') ? 'none' : 'revision');

  for (const task of tasks) {
    validateWorkspacePolicy(task, profiles[task.profile], snapshotPolicy);
  }

  // provider sessions are bound to a working directory, so tasks that share one must run in a stable directory
  for (const task of tasks) {
    if (!task.session || tasks.filter((other) => other.session === task.session).length < 2) {
      continue;
    }

    const codeDependencies = [...transitiveDependencies(byId, task.id)].filter(
      (id) => byId.get(id).workspace !== 'shared-readonly',
    );

    const stable =
      task.workspace === 'in-place' || (task.workspace === 'shared-readonly' && codeDependencies.length === 0);

    if (!stable) {
      throw new OrchestratorError(
        'manifest',
        `task ${task.id}: a session shared between tasks needs a stable working directory (in-place, or shared-readonly without code dependencies)`,
      );
    }
  }

  const inPlace = tasks.filter((task) => task.workspace === 'in-place');

  if (inPlace.length > 0 && raw.input.snapshot && raw.input.snapshot !== 'none') {
    throw new OrchestratorError('manifest', 'in-place tasks edit input.root directly; set input.snapshot to "none"');
  }

  if (inPlace.length > 0 && raw.integration) {
    throw new OrchestratorError(
      'manifest',
      'integration composes patches on a snapshot; a run with in-place tasks has no snapshot, so drop integration',
    );
  }

  if (inPlace.length > 0 && tasks.some((task) => task.workspace === 'worktree')) {
    throw new OrchestratorError(
      'manifest',
      'in-place and worktree tasks cannot share a run: worktrees need a snapshot, in-place tasks edit the live root',
    );
  }

  if (raw.input.snapshot === 'none' && tasks.some((task) => task.workspace === 'worktree')) {
    throw new OrchestratorError('manifest', 'worktree tasks need input.snapshot "revision" or "working-tree"');
  }

  return {
    version: raw.version,
    label: raw.label,
    input: {
      root: fs.realpathSync(root),
      revision: raw.input.revision ?? 'HEAD',
      snapshot: raw.input.snapshot ?? (inPlace.length > 0 ? 'none' : 'revision'),
    },
    limits,
    profiles,
    tasks,
    order,
    composeOrder,
    integration,
    checkSandbox: {
      mode: raw.checkSandbox?.mode ?? 'os',
      writableRoots: raw.checkSandbox?.writableRoots ?? [],
    },
  };
}

function validateProfilePolicy(name, profile) {
  if (profile.adapter === 'claude-cli' && profile.permissionMode === 'bypassPermissions' && !profile.externalSandbox) {
    throw new OrchestratorError(
      'manifest',
      `profile ${name}: permissionMode bypassPermissions requires externalSandbox: true; a worktree is not a sandbox`,
    );
  }

  if (profile.adapter === 'codex-cli' && profile.sandbox === 'danger-full-access' && !profile.externalSandbox) {
    throw new OrchestratorError(
      'manifest',
      `profile ${name}: sandbox danger-full-access requires externalSandbox: true; a worktree is not a sandbox`,
    );
  }

  // a worker that can edit a script and also run it unprompted can run anything, which is what bypassPermissions allows
  if (profile.adapter === 'claude-cli' && !profile.bashSandbox && !profile.externalSandbox) {
    const shellRules = claudeShellRules(profile);
    const editing = claudeEditingTools(profile);

    if (shellRules.length > 0 && editing.length > 0) {
      throw new OrchestratorError(
        'manifest',
        `profile ${name}: it can edit files (${editing.join(', ')}) and auto-approves ${shellRules.join(', ')}, so the worker can edit a script and run it unsandboxed; set bashSandbox: true (or externalSandbox: true inside a real sandbox)`,
      );
    }
  }

  /**
   * An allow rule that names a write tool without a path approves that tool everywhere on disk.
   * Edits inside the working directory need no such rule, because acceptEdits approves them,
   * so the rule only adds the reach beyond it.
   */
  if (profile.adapter === 'claude-cli' && !profile.externalSandbox && claudeWriteToolsInSession(profile).length > 0) {
    const unscoped = (profile.allowedTools ?? []).filter((rule) => CLAUDE_WRITE_TOOLS.includes(rule));

    if (unscoped.length > 0) {
      throw new OrchestratorError(
        'manifest',
        `profile ${name}: allowedTools ${unscoped.join(', ')} approves file writes anywhere on disk, not only in the workspace; permissionMode acceptEdits already approves edits inside the working directory, so remove ${unscoped.join(', ')} or give it a path such as Edit(src/**) (or set externalSandbox: true inside a real sandbox)`,
      );
    }
  }

  // --force lets cursor-agent run shell commands and file edits outside the workspace even with its sandbox enabled
  if (
    profile.adapter === 'cursor-cli' &&
    (profile.force || profile.sandbox !== 'enabled') &&
    !profile.externalSandbox
  ) {
    throw new OrchestratorError(
      'manifest',
      `profile ${name}: ${profile.force ? 'force' : `sandbox ${profile.sandbox}`} requires externalSandbox: true; a worktree is not a sandbox`,
    );
  }
}

function claudeShellRules(profile) {
  if (profile.tools && !profile.tools.includes('Bash')) {
    return [];
  }

  return (profile.allowedTools ?? []).filter((tool) => tool === 'Bash' || tool.startsWith('Bash('));
}

// claude applies Edit rules to every file-editing tool, and a scoped rule such as Edit(src/**) still approves writes
function approvesWrites(profile) {
  return (profile.allowedTools ?? []).some((rule) =>
    CLAUDE_WRITE_TOOLS.some((tool) => rule === tool || rule.startsWith(`${tool}(`)),
  );
}

function claudeWriteToolsInSession(profile) {
  const disallowed = new Set(profile.disallowedTools);

  return CLAUDE_WRITE_TOOLS.filter((tool) => (!profile.tools || profile.tools.includes(tool)) && !disallowed.has(tool));
}

function claudeEditingTools(profile) {
  const approved = profile.permissionMode === 'acceptEdits' || approvesWrites(profile);

  return approved ? claudeWriteToolsInSession(profile) : [];
}

function validateWorkspacePolicy(task, profile, snapshot) {
  if (task.workspace !== 'shared-readonly') {
    return;
  }

  if (profile.adapter === 'codex-cli' && profile.sandbox !== 'read-only') {
    throw new OrchestratorError('manifest', `task ${task.id}: shared-readonly requires codex sandbox read-only`);
  }

  // cursor-agent's plan mode still runs shell commands and its sandbox leaves the workspace writable
  if (profile.adapter === 'cursor-cli') {
    throw new OrchestratorError(
      'manifest',
      `task ${task.id}: shared-readonly is not available for cursor-cli because cursor-agent has no mode that prevents writes; use a worktree`,
    );
  }

  if (profile.adapter === 'claude-cli') {
    const approved = new Set(profile.allowedTools);

    if (claudeWriteToolsInSession(profile).length > 0 || approvesWrites(profile)) {
      throw new OrchestratorError(
        'manifest',
        `task ${task.id}: shared-readonly requires the claude profile to exclude ${CLAUDE_WRITE_TOOLS.join(', ')} (via tools or disallowedTools)`,
      );
    }

    // unrestricted shell access can write anywhere, so on the live root (no snapshot) no shell rule is accepted
    const shellRules = [...approved].filter((tool) => tool === 'Bash' || tool.startsWith('Bash('));
    const unrestricted = shellRules.filter((tool) => ['Bash', 'Bash(*)', 'Bash(:*)'].includes(tool));

    if (unrestricted.length > 0 || (snapshot === 'none' && shellRules.length > 0)) {
      const refused = unrestricted.length > 0 ? unrestricted : shellRules;

      throw new OrchestratorError(
        'manifest',
        `task ${task.id}: shared-readonly cannot auto-approve ${refused.join(', ')}${snapshot === 'none' ? ' on the live input root' : ''}`,
      );
    }

    if (['acceptEdits', 'bypassPermissions'].includes(profile.permissionMode)) {
      throw new OrchestratorError(
        'manifest',
        `task ${task.id}: shared-readonly cannot use permissionMode ${profile.permissionMode}`,
      );
    }
  }
}

export function loadManifest(file, dependencies) {
  const absolute = path.resolve(file);

  let text;

  try {
    text = fs.readFileSync(absolute, 'utf8');
  } catch (error) {
    throw new OrchestratorError('usage', `cannot read manifest ${absolute}: ${error.message}`);
  }

  let raw;

  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new OrchestratorError('manifest', `manifest is not valid JSON: ${error.message}`);
  }

  const manifest = normalizeManifest(raw, path.dirname(absolute), dependencies);

  return { manifest, source: absolute, sha256: sha256(text) };
}

// the ids come from the supervisor, never from the worker, and a custom schema defines its own fields
export function protocolFooter({ taskId, attemptId, kind, generic = true }) {
  const envelope = generic
    ? [
        '- Finish with the structured result the schema requires. Copy the task id and attempt id exactly.',
        '- Set `status` to `blocked`, with `blocker.reason` and `blocker.needs`, when you cannot finish without a decision, access, or input you do not have. Otherwise set `status` to `done` and `blocker` to null.',
        '- `files` and `checks` are your own account; the supervisor records actual changes and runs its own checks.',
      ]
    : [
        '- Finish with the structured result the schema requires. Where it asks for the task or attempt id, copy them exactly.',
      ];

  return [
    '',
    '---',
    '',
    'Execution protocol (from the supervisor):',
    '',
    `- Task id: \`${taskId}\``,
    `- Attempt id: \`${attemptId}\` (${kind})`,
    ...envelope,
    '- Stay inside the task scope. Do not commit, push, or modify files outside your working directory.',
    '',
  ].join('\n');
}
