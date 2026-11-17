import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveExecutable } from './adapters/common.mjs';
import { ADAPTERS, getAdapter } from './adapters/index.mjs';
import {
  addWorktree,
  applyPatches,
  captureChange,
  commitTree,
  configureSnapshotSandbox,
  filterDrivers,
  fingerprintLike,
  git,
  gitInWorktree,
  ignoredPaths,
  inputProblem,
  isGitWorkTree,
  prepareRunInput,
  readOnlyFingerprint,
  removeWorktree,
  scopeViolations,
  snapshotTree,
  workspaceFingerprint,
} from './artifacts.mjs';
import { AttemptRunner, LEASE, liveProcessReason, startedAttempts } from './attempt.mjs';
import {
  LeaseLostError,
  OrchestratorError,
  TERMINAL_TASK_STATES,
  loadManifest,
  protocolFooter,
  randomIds,
  sha256File,
  slugify,
  timestampSlug,
  transitiveDependencies,
  validateDecisionDocument,
} from './contracts.mjs';
import {
  checkIdentity,
  faultPoint,
  groupExists,
  processIdentity,
  readJsonReceipt,
  runBounded,
  terminateGroup,
  writeJsonAtomic,
} from './process.mjs';
import { writeReport } from './report.mjs';
import { probeSandbox, sandboxPrefix, sandboxUnavailableHint } from './sandbox.mjs';
import { Store } from './store.mjs';

const MAX_UNSTARTED_ATTEMPTS = 3;

export const EXIT_CODES = Object.freeze({
  succeeded: 0,
  failed: 1,
  blocked: 2,
  recovery_required: 3,
  cancelled: 4,
  stopped: 5,
  running: 6,
  usage: 64,
  internal: 70,
});

export function defaultRunsRoot(env = process.env) {
  return env.ORCHESTRATOR_HOME ? path.resolve(env.ORCHESTRATOR_HOME) : path.join(os.homedir(), '.orchestrator');
}

// the first release in which node:sqlite, which holds the run state, is no longer experimental
export const MINIMUM_NODE = Object.freeze({ major: 24, minor: 15 });

// process groups, signals, and the check sandbox are implemented for these platforms only
const SUPPORTED_PLATFORMS = Object.freeze(['darwin', 'linux']);

export function checkRuntime({ version = process.versions.node, platform = process.platform } = {}) {
  const [major, minor] = version.split('.').map(Number);
  const problems = [];

  if (major < MINIMUM_NODE.major || (major === MINIMUM_NODE.major && minor < MINIMUM_NODE.minor)) {
    problems.push(`Node ${version} is too old; the runner needs ${MINIMUM_NODE.major}.${MINIMUM_NODE.minor} or later`);
  }

  if (!SUPPORTED_PLATFORMS.includes(platform)) {
    problems.push(`the runner supports macOS and Linux, not ${platform}`);
  }

  return { node: `v${version}`, platform, problems };
}

// preflight must never invoke a model, so it only checks that each executable accepts the profile's arguments
export async function preflightProfiles(profiles, { env = process.env, cwd = os.tmpdir() } = {}) {
  const resolved = {};
  const problems = [];
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-probe-'));

  try {
    const schemaFile = path.join(probeDir, 'schema.json');

    fs.writeFileSync(schemaFile, '{"type":"object"}');

    for (const [name, profile] of Object.entries(profiles)) {
      const adapter = getAdapter(profile.adapter);
      const context = { cwd, env, schemaFile, lastMessageFile: path.join(probeDir, 'last.json') };

      let executable;

      try {
        executable = await resolveExecutable(adapter, {
          profileExecutable: profile.executable ?? null,
          env,
          accept: (argv) => adapter.probe({ ...profile, executable: argv }, context),
        });
      } catch (error) {
        problems.push(`profile ${name}: ${error.message}`);

        continue;
      }

      resolved[name] = {
        ...profile,
        executable: executable.argv,
        resolution: {
          version: executable.version,
          source: executable.source,
          adapterVersion: adapter.adapterVersion,
          skipped: executable.rejected,
        },
      };
    }
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }

  return { resolved, problems };
}

export async function preflightRun(manifest, { env = process.env } = {}) {
  const runtime = checkRuntime();

  const usedProfiles = Object.fromEntries(
    [...new Set(manifest.tasks.map((task) => task.profile))].map((name) => [name, manifest.profiles[name]]),
  );

  const { resolved, problems } = await preflightProfiles(usedProfiles, { env, cwd: manifest.input.root });
  const warnings = [];
  const hasChecks = manifest.tasks.some((task) => task.verify.length > 0) || manifest.integration?.checks.length > 0;
  const drivers = (await isGitWorkTree(manifest.input.root)) ? await filterDrivers(manifest.input.root) : [];
  const confined = manifest.checkSandbox.mode !== 'none';

  // filter drivers run inside the same sandbox during snapshots, so it must work even for a run without checks
  if (hasChecks || (confined && drivers.length > 0)) {
    const sandbox = await probeSandbox(manifest.checkSandbox);

    problems.push(...sandbox.problems.map((problem) => `${problem}; ${sandboxUnavailableHint()}`));
  }

  const inputIssue = await inputProblem({
    root: manifest.input.root,
    snapshot: manifest.input.snapshot,
    inPlace: manifest.tasks.some((task) => task.workspace === 'in-place'),
  });

  if (inputIssue) {
    problems.push(inputIssue);
  }

  for (const driver of drivers) {
    warnings.push(
      confined
        ? `git ${driver.key} runs \`${driver.command}\` during snapshots; it runs in the check sandbox with write access only to the object store, the Git LFS store, and a private index`
        : `git ${driver.key} runs \`${driver.command}\` on the host, unsandboxed, whenever the runner snapshots a workspace; if it invokes a file in the repository, a worker can change what it runs`,
    );
  }

  return { runtime, resolved, problems: [...runtime.problems, ...problems], warnings };
}

export function deriveOutcome(tasks, { integration = null, integrationRequired = false, stoppedBy = null } = {}) {
  const states = tasks.map((task) => task.state);

  if (states.some((state) => state === 'running' || state === 'verifying')) {
    return 'running';
  }

  if (states.every((state) => state === 'succeeded')) {
    if (integrationRequired && integration?.status !== 'passed') {
      // an integration stopped by cancellation, or kept from starting by it, leaves the run cancelled
      return (integration?.detail?.stoppedBy ?? stoppedBy) === 'cancelled' ? 'cancelled' : 'failed';
    }

    return 'succeeded';
  }

  if (states.includes('recovery_required')) {
    return 'recovery_required';
  }

  if (states.includes('blocked')) {
    return 'blocked';
  }

  if (states.some((state) => state === 'ready' || state === 'pending')) {
    return 'stopped';
  }

  if (states.some((state) => state === 'failed' || state === 'skipped')) {
    return 'failed';
  }

  return 'cancelled';
}

function taskGraphProblem(store, manifest) {
  const stored = new Map(store.tasks().map((task) => [task.id, task]));
  const missing = manifest.tasks.filter((task) => !stored.has(task.id)).map((task) => task.id);
  const expected = new Set(manifest.tasks.map((task) => task.id));
  const extra = [...stored.keys()].filter((id) => !expected.has(id));

  if (missing.length > 0 || extra.length > 0) {
    const detail = [
      missing.length > 0 ? `missing ${missing.join(', ')}` : null,
      extra.length > 0 ? `unexpected ${extra.join(', ')}` : null,
    ].filter(Boolean);

    return `the run state holds ${stored.size} of the manifest's ${manifest.tasks.length} tasks (${detail.join('; ')})`;
  }

  for (const task of manifest.tasks) {
    const want = [...(task.dependsOn ?? [])].toSorted((a, b) => a.localeCompare(b)).join(',');

    const have = store
      .dependencies(task.id)
      .toSorted((a, b) => a.localeCompare(b))
      .join(',');

    if (want !== have) {
      return `task ${task.id} depends on [${have}] in the run state but on [${want}] in the manifest`;
    }
  }

  return null;
}

// resolves symlinks in the part of a path that exists, so a directory that is yet to be created still compares
function realPath(target) {
  const missing = [];

  let existing = path.resolve(target);

  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) {
    missing.unshift(path.basename(existing));

    existing = path.dirname(existing);
  }

  return path.join(fs.realpathSync(existing), ...missing);
}

// run records inside the input would be picked up by its snapshots and by the change audit of in-place tasks
function assertRunsRootOutsideInput(runsRoot, inputRoot) {
  const relative = path.relative(inputRoot, realPath(runsRoot));

  if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
    throw new OrchestratorError(
      'usage',
      `the runs root ${runsRoot} is inside input.root ${inputRoot}; keep run directories outside the work they act on`,
    );
  }
}

export async function createRun(
  manifestPath,
  { runsRoot = defaultRunsRoot(), env = process.env, ids = randomIds(), clock } = {},
) {
  const { manifest, sha256: manifestSha256, source } = loadManifest(manifestPath, { adapters: ADAPTERS });

  assertRunsRootOutsideInput(runsRoot, manifest.input.root);

  const { runtime, resolved, problems, warnings } = await preflightRun(manifest, { env });

  if (problems.length > 0) {
    throw new OrchestratorError('launch', `preflight failed:\n${problems.join('\n')}`);
  }

  const runId = `${timestampSlug(clock ? new Date(clock.now()) : new Date())}-${slugify(manifest.label)}-${ids.next('r').slice(2, 8)}`;

  configureSnapshotSandbox(manifest.checkSandbox);

  // the input is checked before the run directory exists, so a rejected input leaves no half-created run behind
  const input = await prepareRunInput({
    ...manifest.input,
    runId,
    inPlace: manifest.tasks.some((task) => task.workspace === 'in-place'),
  });

  fs.mkdirSync(runsRoot, { recursive: true });

  const runDir = path.join(runsRoot, runId);

  fs.mkdirSync(runDir);

  for (const sub of ['tasks', 'artifacts', 'checks', 'workspaces']) {
    fs.mkdirSync(path.join(runDir, sub));
  }

  writeJsonAtomic(path.join(runDir, 'manifest.json'), { source, sha256: manifestSha256, manifest });

  const now = clock ? clock.now() : Date.now();

  const store = Store.create(
    path.join(runDir, 'state.sqlite'),
    {
      id: runId,
      kind: 'manifest',
      label: manifest.label,
      runDir,
      manifestSha256,
      manifest,
      input,
      runtime: { ...runtime, profiles: resolved, warnings },
      deadlineAt: now + manifest.limits.runDeadlineMs,
    },
    {
      clock,
      tasks: manifest.tasks.map((task, index) => {
        return { id: task.id, ord: index, spec: task, sessionName: task.session, dependsOn: task.dependsOn };
      }),
    },
  );

  writeReport(store);
  store.close();

  return { runId, runDir };
}

export class Supervisor {
  constructor(runDir, { env = process.env, ids = randomIds(), clock, pollMs = 200, log = () => {} } = {}) {
    this.runDir = path.resolve(runDir);
    this.dbFile = path.join(this.runDir, 'state.sqlite');
    this.store = Store.open(this.dbFile, { clock });
    this.env = env;
    this.ids = ids;
    this.clock = clock ?? { now: () => Date.now() };
    this.pollMs = pollMs;
    this.log = log;

    const run = this.store.run();

    if (run.kind === 'manifest') {
      const problem = taskGraphProblem(this.store, run.manifest);

      if (problem) {
        this.store.close();

        throw new OrchestratorError(
          'storage',
          `${problem}; the run was not created completely and cannot be supervised`,
        );
      }
    }

    this.manifest = run.manifest;
    this.input = run.input;
    this.profiles = run.runtime?.profiles ?? {};
    this.limits = this.manifest.limits;

    this.checkSandbox = this.manifest.checkSandbox;

    configureSnapshotSandbox(this.checkSandbox);

    this.inflight = new Map();
    this.activeChecks = new Map();
    this.integrationBlocked = null;
    this.lost = false;
    this.reportSeq = -1;
    this.lastDeferral = null;

    this.runner = new AttemptRunner({
      store: this.store,
      runDir: this.runDir,
      ids,
      limits: this.limits,
      ownerDb: this.dbFile,
      env,
    });
  }

  close() {
    this.store.close();
  }

  async supervise({ dispatch = true, decisions = null } = {}) {
    // a malformed decision file is refused before this supervisor takes the run
    if (decisions) {
      validateDecisionDocument(decisions);
    }

    const token = this.ids.nonce();

    this.store.acquireLease({ token, leaseMs: LEASE.leaseMs });

    const heartbeat = setInterval(() => {
      try {
        this.store.renewLease(LEASE.leaseMs);
      } catch (error) {
        if (error instanceof LeaseLostError) {
          this.lost = true;
        }
      }
    }, LEASE.renewMs);

    let rejectedDecisions = [];

    try {
      await this.recoverUnfinished();
      await this.reconcileIntegrations();

      if (decisions) {
        rejectedDecisions = await this.applyDecisions(decisions);
      }

      while (true) {
        if (this.lost) {
          throw new LeaseLostError();
        }

        await this.applyControls();
        await this.pollActive();
        this.enforceRunDeadline();
        this.enforceSpendThreshold();
        this.promoteAndSkip();

        if (dispatch) {
          this.dispatchReady();
        }

        this.refreshReport();

        if (this.isQuiescent(dispatch)) {
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, this.pollMs));
      }

      if (dispatch) {
        await this.superviseIntegration();
      }

      const outcome = this.currentOutcome();

      this.store.ownerTx(() => {
        this.store.update('runs', 'id', this.store.runId, {
          outcome,
          status: 'finished',
          updated_at: this.store.isoNow(),
        });

        this.store.appendEvent('run.outcome', { data: { outcome } });
      });

      return { outcome, exitCode: EXIT_CODES[outcome] ?? 1, rejectedDecisions };
    } finally {
      clearInterval(heartbeat);
      await Promise.allSettled(this.inflight.values());

      if (!this.lost) {
        this.store.releaseLease();
      }

      try {
        writeReport(this.store);
      } catch (error) {
        this.log(`report write failed: ${error.message}`);
      }
    }
  }

  currentOutcome() {
    return deriveOutcome(this.store.tasks(), {
      integration: this.store.latestIntegration(),
      integrationRequired: Boolean(this.manifest.integration),
      stoppedBy: this.integrationStop()?.reason ?? null,
    });
  }

  isQuiescent(dispatch) {
    if (this.inflight.size > 0 || this.store.activeAttempts().length > 0) {
      return false;
    }

    if (!dispatch) {
      return true;
    }

    const run = this.store.run();

    if (run.cancel_requested || run.dispatch_stopped) {
      return true;
    }

    const tasks = this.store.tasks();
    const root = this.rootHold(tasks);

    // ready tasks waiting for a backoff or capacity keep the run alive, but a task that needs an operator does not
    return !tasks.some((task) => {
      if (task.state === 'pending') {
        return this.dependenciesReady(task);
      }

      return task.state === 'ready' && !this.waitsForOperator(task, root);
    });
  }

  sessionQuarantined(task) {
    const sessionName = this.sessionNameFor(task);

    return Boolean(sessionName && this.store.session(sessionName)?.quarantine);
  }

  // a ready task cannot start by itself behind a quarantined session or behind a root holder that needs a decision
  waitsForOperator(task, root) {
    if (this.sessionQuarantined(task)) {
      return true;
    }

    const holder = root.heldBack(task);

    if (!holder) {
      return false;
    }

    return holder.state === 'ready'
      ? this.sessionQuarantined(holder)
      : ['blocked', 'recovery_required'].includes(holder.state);
  }

  /**
   * An in-place task is audited as one change from its first attempt to its last, so from its
   * first launch until it reaches a terminal state no other in-place task may edit the root.
   * `heldBack(task)` returns the unfinished task that holds the root against `task`, or null.
   * A task that was launched itself is never held back, so two holders cannot wait for each other.
   */
  rootHold(tasks) {
    const launched = this.store.launchedTaskIds();

    const holder = tasks.find(
      (task) => task.spec.workspace === 'in-place' && launched.has(task.id) && !TERMINAL_TASK_STATES.has(task.state),
    );

    return {
      heldBack: (task) =>
        holder && task.spec.workspace === 'in-place' && task.id !== holder.id && !launched.has(task.id) ? holder : null,
    };
  }

  refreshReport() {
    const seq = this.store.lastEventSeq();

    if (seq !== this.reportSeq) {
      this.reportSeq = seq;

      try {
        writeReport(this.store);
      } catch (error) {
        // the report is a projection, so failing to write it must not affect execution
        this.log(`report write failed: ${error.message}`);
      }
    }
  }

  dependenciesReady(task) {
    return this.store.dependencies(task.id).every((dependency) => this.store.task(dependency).state === 'succeeded');
  }

  promoteAndSkip() {
    for (const task of this.store.tasks()) {
      if (task.state !== 'pending') {
        continue;
      }

      const dependencies = this.store.dependencies(task.id).map((id) => this.store.task(id));
      const dead = dependencies.find((dependency) => ['failed', 'cancelled', 'skipped'].includes(dependency.state));

      if (dead) {
        this.store.ownerTx(() =>
          this.store.transitionTask(
            task.id,
            'pending',
            'skipped',
            { failure_message: `dependency ${dead.id} is ${dead.state}` },
            { dependency: dead.id },
          ),
        );
      } else if (dependencies.every((dependency) => dependency.state === 'succeeded')) {
        this.store.ownerTx(() => this.store.transitionTask(task.id, 'pending', 'ready'));
      }
    }
  }

  deferralReason(task, { active, now, root }) {
    if (task.not_before && task.not_before > now) {
      return `retry backoff until ${new Date(task.not_before).toISOString()}`;
    }

    const spec = task.spec;
    const sessionName = this.sessionNameFor(task);
    const session = sessionName ? this.store.session(sessionName) : null;

    if (session?.quarantine) {
      return `session ${sessionName} is quarantined: ${session.quarantine}`;
    }

    if (sessionName && active.some((attempt) => attempt.session_name === sessionName)) {
      return `session ${sessionName} is in use`;
    }

    const usesRoot = (mode) => mode === 'in-place' || (mode === 'shared-readonly' && this.input.snapshot === 'none');
    const activeModes = active.map((attempt) => this.store.task(attempt.task_id).spec.workspace);

    if (spec.workspace === 'in-place' && activeModes.some((mode) => usesRoot(mode))) {
      return 'another task is using the input root';
    }

    if (usesRoot(spec.workspace) && activeModes.includes('in-place')) {
      return 'an in-place task is editing the input root';
    }

    const holder = root.heldBack(task);

    return holder ? `task ${holder.id} holds the input root until it finishes` : null;
  }

  sessionNameFor(task) {
    if (task.spec.session) {
      return task.spec.session;
    }

    if (task.next_attempt?.kind === 'continuation') {
      return this.store.attempt(task.next_attempt.previousAttemptId).session_name;
    }

    return null;
  }

  dispatchReady() {
    const run = this.store.run();

    if (run.cancel_requested || run.dispatch_stopped) {
      return;
    }

    const now = this.clock.now();
    const active = this.store.activeAttempts();
    const tasks = this.store.tasks();
    const root = this.rootHold(tasks);

    let capacity = this.limits.concurrency - active.length;

    const selected = [];
    const deferred = [];

    for (const task of tasks) {
      if (task.state !== 'ready') {
        continue;
      }

      if (capacity <= 0) {
        deferred.push({ task: task.id, reason: 'concurrency limit' });

        continue;
      }

      const reason = this.deferralReason(task, {
        active: [...active, ...selected.map((item) => item.attempt)],
        now,
        root,
      });

      if (reason) {
        deferred.push({ task: task.id, reason });

        continue;
      }

      const attempt = this.startAttempt(task);

      selected.push({ task: task.id, attempt });
      capacity--;
    }

    const signature = JSON.stringify(deferred);

    if (selected.length > 0 || signature !== this.lastDeferral) {
      this.lastDeferral = signature;

      if (selected.length > 0 || deferred.length > 0) {
        this.store.ownerTx(() =>
          this.store.appendEvent('dispatch.decision', {
            data: {
              selected: selected.map((item) => {
                return { task: item.task, attempt: item.attempt.id };
              }),
              deferred,
              capacity: this.limits.concurrency,
            },
          }),
        );
      }
    }
  }

  startAttempt(task) {
    const spec = task.spec;
    const next = task.next_attempt;
    const kind = next?.kind ?? (this.store.attempts(task.id).length === 0 ? 'initial' : 'retry');

    const previous = next?.previousAttemptId
      ? this.store.attempt(next.previousAttemptId)
      : (this.store.attempts(task.id).at(-1) ?? null);

    const number = this.store.attempts(task.id).length + 1;
    const profile = this.profiles[spec.profile];
    const sessionName = this.sessionNameFor(task) ?? `${task.id}.${number}`;
    const promptBody = kind === 'continuation' ? next.promptText : spec.prompt.text;

    const attempt = this.runner.reserve({
      taskId: task.id,
      fromState: 'ready',
      kind,
      previousAttemptId: previous?.id ?? null,
      session: { name: sessionName, adapter: profile.adapter, profile: spec.profile },
      profile,
      promptText: (attemptId) =>
        promptBody +
        protocolFooter({ taskId: task.id, attemptId, kind, generic: spec.resultSchema.kind === 'generic' }),
      schemaText: spec.resultSchema.text,
    });

    // the request in next_attempt stays on the task until finishAttempt() sees an attempt that had effects
    this.store.ownerTx(() => this.store.updateTask(task.id, { not_before: null }));
    faultPoint('after-reserve');

    const work = this.prepareAndLaunch(attempt.id, { kind, previous })
      .catch((error) => this.failPreparation(attempt.id, error))
      .finally(() => this.inflight.delete(attempt.id));

    this.inflight.set(attempt.id, work);

    return attempt;
  }

  async prepareAndLaunch(attemptId, { kind, previous }) {
    const attempt = this.store.attempt(attemptId);
    const task = this.store.task(attempt.task_id);
    const workspace = await this.prepareWorkspace(task, attempt, { kind, previous });

    if (workspace.conflict) {
      this.finishAttempt(attempt.id, {
        outcome: 'blocked',
        failureClass: 'conflict',
        message: `dependency artifacts conflict: ${workspace.conflict.message.split('\n')[0]}`,
        blocker: {
          reason: 'dependency artifacts do not apply cleanly',
          needs: 'resolve the conflict in a new task or change the integration order',
          conflict: workspace.conflict,
        },
        noEffects: true,
      });

      return;
    }

    this.store.ownerTx(() => {
      this.store.updateAttempt(attempt.id, { workspace_path: workspace.cwd, input_json: workspace.input });

      if (!task.prepared_input && workspace.input.taskBase) {
        this.store.updateTask(task.id, { prepared_input_json: workspace.input.taskBase });
      }
    });

    const session = this.store.session(attempt.session_name);
    const resumeSessionId = session?.provider_session_id ?? null;

    this.runner.launch(this.store.attempt(attempt.id), {
      cwd: workspace.cwd,
      resumeSessionId,
      sessionName: resumeSessionId ? null : `${this.store.runId}/${task.id}`,
      isGitRepo: workspace.gitRepo,
      deadlineMs: task.spec.deadlineMs,
    });
  }

  async prepareWorkspace(task, attempt, { kind, previous }) {
    const spec = task.spec;

    if (spec.workspace === 'in-place' || (spec.workspace === 'shared-readonly' && this.input.snapshot === 'none')) {
      const gitRepository = this.input.git;
      const revParse = gitRepository ? await git(this.input.root, ['rev-parse', 'HEAD']) : null;
      const head = revParse?.stdout.trim() || null;

      const options = { gitRepo: Boolean(gitRepository && head), startCommit: head };
      const readOnly = spec.workspace === 'shared-readonly';

      // a read-only continuation keeps its first baseline, so a change made while it was blocked is caught
      if (readOnly && kind === 'continuation' && previous?.input?.fingerprint) {
        const current = await fingerprintLike(this.input.root, previous.input.fingerprint, {
          startCommit: previous.input.startCommit,
        });

        if (current !== previous.input.fingerprint) {
          this.refuseContinuation(attempt, previous, this.input.root);
        }

        return {
          cwd: this.input.root,
          gitRepo: gitRepository,
          input: { ...previous.input, continuedFrom: previous.id },
        };
      }

      const fingerprint = readOnly
        ? await readOnlyFingerprint(this.input.root, options)
        : await workspaceFingerprint(this.input.root, options);

      const baseTree = fingerprint.startsWith('tree:') ? fingerprint.slice(5).split('|')[0] : null;
      const input = { mode: spec.workspace, fingerprint, startCommit: head, baseTree };

      if (spec.workspace === 'in-place') {
        // the root still holds the edits of the task's earlier attempts, so each attempt is audited from the first base
        const first = this.store.attempts(task.id).find((item) => item.input?.mode === 'in-place');

        if (first) {
          input.startCommit = first.input.startCommit;
          input.baseTree = first.input.baseTree;
          input.ignoredListing = first.input.ignoredListing;
        } else {
          input.ignoredListing = await this.listIgnoredBefore(attempt);
        }

        if (kind === 'continuation' && previous) {
          input.continuedFrom = previous.id;
        }
      }

      return { cwd: this.input.root, gitRepo: gitRepository, input };
    }

    if (kind === 'continuation' && previous?.workspace_path && fs.existsSync(previous.workspace_path)) {
      // claude sessions are bound to their working directory, so a continuation resumes in the same workspace
      const input = { ...previous.input, continuedFrom: previous.id };

      // the continuation keeps the first baseline, so a change made in between is caught rather than adopted
      if (spec.workspace === 'shared-readonly') {
        const current = await fingerprintLike(previous.workspace_path, input.fingerprint, {
          startCommit: input.startCommit,
        });

        if (current !== input.fingerprint) {
          this.refuseContinuation(attempt, previous, previous.workspace_path);
        }
      }

      return { cwd: previous.workspace_path, gitRepo: true, input };
    }

    const dependencies = new Set(
      transitiveDependencies(
        new Map(this.store.tasks().map((item) => [item.id, { dependsOn: item.spec.dependsOn }])),
        task.id,
      ),
    );

    const codeDependencies = this.manifest.composeOrder.filter(
      (id) => dependencies.has(id) && this.store.task(id).spec.workspace !== 'shared-readonly',
    );

    if (spec.workspace === 'shared-readonly' && codeDependencies.length === 0) {
      const { dir: shared, fingerprint } = await this.cleanSharedInput();

      return {
        cwd: shared,
        gitRepo: true,
        input: { mode: 'shared-readonly', startCommit: this.input.commit, baseTree: this.input.tree, fingerprint },
      };
    }

    const dir = path.join(this.runDir, 'workspaces', task.id, attempt.id);

    await addWorktree(this.input.root, dir, this.input.commit);

    const patches = codeDependencies.map((id) => {
      const accepted = this.store.attempt(this.store.task(id).result_attempt_id);
      const artifact = this.store.artifacts(accepted.id).find((item) => item.kind === 'patch');

      return { taskId: id, path: artifact.path, sha256: artifact.sha256 };
    });

    const applied = await applyPatches(dir, patches);

    if (!applied.ok) {
      return { conflict: applied.conflict };
    }

    let startCommit = this.input.commit;
    let baseTree = this.input.tree;

    if (patches.length > 0) {
      baseTree = await snapshotTree(dir, this.input.commit);
      startCommit = await commitTree(dir, baseTree, this.input.commit, `orchestrator input for ${task.id}`);

      // move the worktree onto the composed input so the worker sees a clean status
      const reset = await gitInWorktree(dir, ['reset', '-q', '--mixed', startCommit]);

      if (!reset.ok) {
        throw new OrchestratorError('launch', `cannot reset ${dir} to its prepared input: ${reset.stderr}`);
      }
    }

    const taskBase = {
      startCommit,
      baseTree,
      dependencies: patches.map(({ taskId, sha256 }) => {
        return { taskId, sha256 };
      }),
    };

    const input = { mode: spec.workspace, startCommit, baseTree, taskBase, dependencies: taskBase.dependencies };

    if (spec.workspace === 'shared-readonly') {
      input.fingerprint = await readOnlyFingerprint(dir, { gitRepo: true, startCommit });
    }

    return { cwd: dir, gitRepo: true, input };
  }

  // snapshots skip ignored files, so the live root's ignored files are listed separately for the audit
  async listIgnoredBefore(attempt) {
    const listing = path.join(attempt.attempt_dir, 'ignored-before.txt');
    const ignored = await ignoredPaths(this.input.root, { collapse: false });

    fs.writeFileSync(listing, ignored.join('\n'));

    return listing;
  }

  /**
   * Read-only tasks share a checkout of the input. Each checkout records its fingerprint when it
   * is created, and a checkout that no longer matches it (or has no record) is left in place for
   * inspection while the next numbered one is created, so later readers never adopt changed contents
   * as their baseline. Selection is serialized so concurrent preparations agree on one checkout.
   */
  cleanSharedInput() {
    const select = async () => {
      for (let number = 1; ; number++) {
        const dir = path.join(this.runDir, 'workspaces', number === 1 ? '_input' : `_input-${number}`);
        const record = `${dir}.fingerprint`;

        if (!fs.existsSync(dir)) {
          await addWorktree(this.input.root, dir, this.input.commit);

          const fingerprint = await readOnlyFingerprint(dir, { gitRepo: true, startCommit: this.input.commit });

          fs.writeFileSync(record, fingerprint);

          return { dir, fingerprint };
        }

        const expected = fs.existsSync(record) ? fs.readFileSync(record, 'utf8').trim() : null;

        const current = expected
          ? await fingerprintLike(dir, expected, { startCommit: this.input.commit }).catch(() => null)
          : null;

        if (expected && current === expected) {
          return { dir, fingerprint: expected };
        }

        this.log(`shared read-only checkout ${dir} no longer matches its recorded input; using a fresh one`);
      }
    };

    const selection = (this.sharedInputSelection ?? Promise.resolve()).catch(() => {}).then(select);

    this.sharedInputSelection = selection;

    return selection;
  }

  // new ignored files are invisible to the patch, so they are listed and scope-checked on their own
  async ignoredAdditions(attempt) {
    const listing = attempt.input?.ignoredListing;

    if (!listing || !fs.existsSync(listing)) {
      return [];
    }

    const before = new Set(fs.readFileSync(listing, 'utf8').split('\n').filter(Boolean));

    const after = await ignoredPaths(attempt.workspace_path, { collapse: false });

    return after.filter((file) => !before.has(file));
  }

  isSharedCheckout(attempt) {
    return (
      Boolean(this.input.commit && attempt.workspace_path) &&
      path.dirname(attempt.workspace_path) === path.join(this.runDir, 'workspaces') &&
      path.basename(attempt.workspace_path).startsWith('_input')
    );
  }

  // the copy holds nothing worth keeping, so a leftover from a crashed verification is replaced
  async disposableCheckout(attempt) {
    const dir = path.join(this.runDir, 'workspaces', attempt.task_id, `${attempt.id}${CHECKS_SUFFIX}`);

    if (fs.existsSync(dir)) {
      await removeWorktree(this.input.root, dir);
    }

    await addWorktree(this.input.root, dir, attempt.input.startCommit);

    return dir;
  }

  // a read-only attempt must leave its input as it found it, whatever its outcome
  async readOnlyChange(attempt) {
    if (!attempt.input?.fingerprint || !attempt.workspace_path) {
      return null;
    }

    const after = await fingerprintLike(attempt.workspace_path, attempt.input.fingerprint, {
      startCommit: attempt.input.startCommit,
    });

    return after === attempt.input.fingerprint ? null : 'a read-only task changed its input';
  }

  /**
   * The refused attempt inherits the previous attempt's workspace and baseline, so a later
   * continuation still compares against the input the task first read instead of adopting
   * the changed one.
   */
  refuseContinuation(attempt, previous, dir) {
    this.store.ownerTx(() =>
      this.store.updateAttempt(attempt.id, { workspace_path: previous.workspace_path, input_json: previous.input }),
    );

    throw Object.assign(
      new OrchestratorError(
        'verification',
        `the read-only input ${dir} changed since attempt ${previous.id} started, so the continuation would read altered input`,
      ),
      { continuationRefused: true },
    );
  }

  failPreparation(attemptId, error) {
    if (error instanceof LeaseLostError) {
      this.lost = true;
      return;
    }

    this.log(`preparation of ${attemptId} failed: ${error.message}`);

    const attempt = this.store.attempt(attemptId);

    if (!attempt?.active) {
      return;
    }

    // a fresh retry would drop the operator's answer, so the task waits for a decision instead
    if (error.continuationRefused) {
      this.finishAttempt(attemptId, {
        outcome: 'blocked',
        failureClass: 'verification',
        message: error.message,
        blocker: {
          reason: error.message,
          needs: 'restore the input and continue again, or start a new run on the current input',
        },
        noEffects: true,
      });

      return;
    }

    this.finishAttempt(attemptId, {
      outcome: 'failed',
      failureClass: error.category && error.category !== 'state' ? error.category : 'launch',
      message: `workspace preparation failed: ${error.message}`,
      noEffects: attempt.phase === 'prepared',
    });
  }

  async pollActive() {
    for (const attempt of this.store.activeAttempts()) {
      if (this.inflight.has(attempt.id)) {
        continue;
      }

      if (attempt.phase === 'exited' || attempt.phase === 'verifying') {
        this.track(attempt.id, this.verify(attempt.id));

        continue;
      }

      if (attempt.phase !== 'launching' && attempt.phase !== 'running') {
        continue;
      }

      const observed = this.runner.observe(attempt);

      if (observed.exit?.invalid) {
        this.finishAttempt(attempt.id, {
          outcome: 'uncertain',
          failureClass: 'uncertain',
          message: observed.exit.invalid,
        });
      } else if (observed.exit) {
        this.runner.ingestExit(attempt, observed.exit);
        faultPoint('after-exit-ingest');
        this.track(attempt.id, this.verify(attempt.id));
      } else if (observed.hostGone) {
        this.track(attempt.id, this.reconcileAttempt(attempt.id));
      }
    }
  }

  track(attemptId, promise) {
    const work = promise
      .catch((error) => {
        if (error instanceof LeaseLostError) {
          this.lost = true;
          return;
        }

        this.log(`attempt ${attemptId}: ${error.stack ?? error.message}`);

        const attempt = this.store.attempt(attemptId);

        if (attempt?.active) {
          // a storage or verification error leaves the result unproven, so never guess success
          this.finishAttempt(attemptId, {
            outcome: 'uncertain',
            failureClass: 'uncertain',
            message: `verification error: ${error.message}`,
          });
        }
      })
      .finally(() => this.inflight.delete(attemptId));

    this.inflight.set(attemptId, work);
  }

  async verify(attemptId) {
    let attempt = this.store.attempt(attemptId);
    let task = this.store.task(attempt.task_id);

    const spec = task.spec;

    this.store.ownerTx(() => {
      if (attempt.phase !== 'verifying') {
        this.store.updateAttempt(attempt.id, { phase: 'verifying' });
      }

      if (task.state === 'running') {
        this.store.transitionTask(task.id, 'running', 'verifying', {}, { attemptId: attempt.id });
      }
    });

    attempt = this.store.attempt(attemptId);
    task = this.store.task(attempt.task_id);

    // a previous owner may have died while a check ran, so nothing touches the workspace until that check is stopped
    const orphaned = await stopRecordedChecks(checkDir(this.runDir, task.id, attempt.id), this.limits.terminateGraceMs);

    if (orphaned) {
      this.finishAttempt(attempt.id, { outcome: 'uncertain', failureClass: 'uncertain', message: orphaned });
      return;
    }

    const readOnly = spec.workspace === 'shared-readonly';

    const evaluation = this.runner.evaluate(attempt, {
      generic: spec.resultSchema.kind === 'generic',
      taskId: task.id,
      readOnly,
    });

    this.store.ownerTx(() => {
      this.store.updateAttempt(attempt.id, {
        usage_json: evaluation.provider?.usage ?? null,
        cost_usd: evaluation.provider?.costUsd ?? null,
        result_json: evaluation.provider ?? null,
      });

      if (evaluation.provider?.sessionId) {
        this.store.updateAttempt(attempt.id, { provider_session_id: evaluation.provider.sessionId });
        this.store.recordProviderSession(attempt.session_name, evaluation.provider.sessionId);
      }
    });

    if (!evaluation.ok) {
      const change = await this.captureCandidate(attempt, spec).catch(() => null);
      const mutation = readOnly ? await this.readOnlyChange(attempt) : null;

      // a failed reader that changed its input is not retried on top of that change
      this.finishAttempt(attempt.id, {
        ...evaluation,
        change,
        ...(mutation ? { failureClass: 'verification', message: `${evaluation.message}; ${mutation}` } : {}),
      });

      return;
    }

    const payload = evaluation.payload;

    let change;

    try {
      change = await this.captureCandidate(attempt, spec);
    } catch (error) {
      this.finishAttempt(attempt.id, {
        outcome: 'failed',
        failureClass: error.category === 'budget' ? 'budget' : 'uncertain',
        message: `artifact capture failed: ${error.message}`,
      });

      return;
    }

    const mutation = readOnly ? await this.readOnlyChange(attempt) : null;

    if (mutation) {
      this.finishAttempt(attempt.id, {
        outcome: 'failed',
        failureClass: 'verification',
        message: mutation,
        payload,
        change,
      });

      return;
    }

    if (change && spec.workspace === 'in-place') {
      change.ignoredAdded = await this.ignoredAdditions(attempt);
    }

    const audited = change
      ? [
          ...change.changes,
          ...(change.ignoredAdded ?? []).map((file) => {
            return { path: file };
          }),
        ]
      : [];

    const outOfScope = scopeViolations(audited, spec.scope);

    if (outOfScope.length > 0) {
      this.finishAttempt(attempt.id, {
        outcome: 'failed',
        failureClass: 'verification',
        message: `changes outside the declared scope: ${outOfScope.join(', ')}`,
        payload,
        change,
      });

      return;
    }

    if (spec.resultSchema.kind === 'generic' && payload.status === 'blocked') {
      this.finishAttempt(attempt.id, {
        outcome: 'blocked',
        failureClass: null,
        message: payload.blocker?.reason ?? 'worker reported blocked',
        blocker: payload.blocker,
        payload,
        change,
      });

      return;
    }

    faultPoint('during-verification');

    const subject = change?.tree ?? attempt.input?.fingerprint ?? null;

    // other readers share this checkout, so checks that might write get a disposable copy of the same commit
    const checkCwd =
      spec.verify.length > 0 && this.isSharedCheckout(attempt)
        ? await this.disposableCheckout(attempt)
        : attempt.workspace_path;

    try {
      for (const check of spec.verify) {
        const stop = this.stopRequest(attempt);

        if (stop) {
          this.finishAttempt(attempt.id, { ...stop, payload, change });
          return;
        }

        const result = await this.runCheck({ check, cwd: checkCwd, taskId: task.id, attemptId: attempt.id, subject });

        if (!result.ok) {
          this.finishAttempt(attempt.id, {
            outcome: 'failed',
            failureClass: 'verification',
            message: `check ${check.name} failed (${result.describe})`,
            payload,
            change,
          });

          return;
        }
      }
    } finally {
      if (checkCwd !== attempt.workspace_path) {
        await removeWorktree(this.input.root, checkCwd).catch((error) => this.log(error.message));
      }
    }

    if (change && spec.verify.length > 0) {
      const after = await snapshotTree(attempt.workspace_path, attempt.input.startCommit);

      if (after !== change.tree) {
        this.finishAttempt(attempt.id, {
          outcome: 'failed',
          failureClass: 'verification',
          message: 'verification commands modified the workspace; the evidence no longer matches the artifact',
          payload,
          change,
        });

        return;
      }
    }

    if (readOnly && spec.verify.length > 0 && (await this.readOnlyChange(attempt))) {
      this.finishAttempt(attempt.id, {
        outcome: 'failed',
        failureClass: 'verification',
        message: 'the read-only input changed during verification',
        payload,
      });

      return;
    }

    faultPoint('before-finish');
    this.finishAttempt(attempt.id, { outcome: 'succeeded', payload, change });
  }

  // an attempt's patch is immutable once recorded, so a later capture of the same workspace names its own file
  async captureCandidate(attempt, spec, fileName = `${attempt.id}.patch`) {
    if (spec.workspace === 'shared-readonly' || !attempt.workspace_path || !attempt.input?.baseTree) {
      return null;
    }

    if (process.env.ORCHESTRATOR_FAULT === 'artifact-enospc') {
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    }

    return captureChange({
      dir: attempt.workspace_path,
      baseTree: attempt.input.taskBase?.baseTree ?? attempt.input.baseTree,
      startCommit: attempt.input.startCommit,
      patchFile: path.join(this.runDir, 'artifacts', attempt.task_id, fileName),
      maxBytes: this.limits.maxArtifactBytes,
    });
  }

  /**
   * The check's process is recorded durably before the command starts, so a later owner can find
   * and stop it after a crash instead of running a second copy beside it.
   */
  async runCheck({ check, cwd, taskId = null, attemptId = null, subject, scope = 'task' }) {
    const logDir =
      scope === 'task' ? checkDir(this.runDir, taskId, attemptId) : path.join(this.runDir, 'checks', 'integration');

    fs.mkdirSync(logDir, { recursive: true });

    const logFile = path.join(logDir, `${check.name}.log`);
    const processFile = path.join(logDir, `${check.name}${CHECK_PROCESS_SUFFIX}`);

    const record = {
      name: check.name,
      argv: check.argv,
      cwd,
      sandbox: this.checkSandbox.mode,
      at: new Date().toISOString(),
    };

    const controller = new AbortController();

    const key = scope === 'task' ? attemptId : INTEGRATION_CHECKS;

    let pid = null;
    let prefix;

    try {
      prefix = sandboxPrefix(this.checkSandbox, { cwd });
    } catch (error) {
      return { ok: false, describe: `${error.message}; ${sandboxUnavailableHint()}` };
    }

    this.activeChecks.set(key, controller);

    let result;

    try {
      // the gate execs the sandbox launcher, and the command runs in the same process group as the recorded pid
      result = await runBounded([...CHECK_GATE, ...prefix, ...check.argv], {
        input: 'start\n',
        cwd,
        env: this.env,
        timeoutMs: check.timeoutMs,
        maxOutputBytes: this.limits.maxCheckOutputBytes,
        logFile,
        graceMs: this.limits.terminateGraceMs,
        signal: controller.signal,
        onSpawn: (spawned) => {
          pid = spawned;

          writeJsonAtomic(processFile, { ...record, pid, pgid: pid, identity: processIdentity(pid) });
        },
      });
    } finally {
      this.activeChecks.delete(key);
    }

    const lingering = pid !== null && groupExists(pid);
    const ok = result.code === 0 && !result.timedOut && !result.aborted && !result.spawnError && !lingering;

    this.store.ownerTx(() => {
      this.store.insertCheck({
        task_id: taskId,
        attempt_id: attemptId,
        scope,
        name: check.name,
        argv_json: check.argv,
        subject_sha256: subject,
        ok,
        exit_code: result.code,
        signal: result.signal,
        timed_out: result.timedOut,
        duration_ms: result.durationMs,
        log_path: logFile,
      });

      this.store.appendEvent('check.finished', {
        taskId,
        attemptId,
        data: { name: check.name, ok, exitCode: result.code, timedOut: result.timedOut },
      });
    });

    // the record outlives the command only while processes remain in its group
    if (!lingering) {
      fs.rmSync(processFile, { force: true });
    }

    const describe = result.spawnError
      ? `spawn error: ${result.spawnError}`
      : result.aborted
        ? 'stopped on request'
        : result.timedOut
          ? `timed out after ${check.timeoutMs} ms`
          : lingering
            ? `processes remain in its group ${pid}`
            : `exit ${result.code ?? result.signal}`;

    return { ok, describe };
  }

  // the stop request lives in the attempt's cancel file so it survives a supervisor crash
  stopRequest(attempt) {
    switch (readJsonReceipt(attempt.profile.files.cancel)?.reason) {
      case 'cancelled': {
        return { outcome: 'cancelled', failureClass: 'cancellation', message: 'cancelled on request' };
      }
      case 'run-deadline': {
        return { outcome: 'failed', failureClass: 'budget', message: 'run deadline exceeded' };
      }
      default: {
        return null;
      }
    }
  }

  finishAttempt(attemptId, outcome) {
    this.store.ownerTx(() => {
      const attempt = this.store.attempt(attemptId);
      const task = this.store.task(attempt.task_id);
      const spec = task.spec;

      if (!attempt.active) {
        return;
      }

      let result = outcome;

      // a recorded cancellation or run-deadline stop outranks every later result except an unproven one
      const stop = result.failureClass === 'uncertain' ? null : this.stopRequest(attempt);

      if (stop && (result.outcome !== stop.outcome || result.failureClass !== stop.failureClass)) {
        result = {
          ...result,
          ...stop,
          noEffects: false,
          message:
            result.message && result.message !== stop.message ? `${stop.message}; ${result.message}` : stop.message,
        };
      }

      if (result.change) {
        this.store.insertArtifact({
          id: `${attempt.id}-patch`,
          task_id: task.id,
          attempt_id: attempt.id,
          kind: 'patch',
          path: result.change.patchFile,
          sha256: result.change.sha256,
          bytes: result.change.bytes,
          data_json: {
            tree: result.change.tree,
            changes: result.change.changes,
            baseTree: attempt.input?.taskBase?.baseTree ?? attempt.input?.baseTree,
            ...(result.change.ignoredAdded?.length > 0 ? { ignoredAdded: result.change.ignoredAdded } : {}),
          },
        });
      }

      let next;
      let attemptOutcome = result.outcome;

      // an attempt that is repeated because it had no effects must repeat the same request, so only that case keeps it
      const fields = { next_attempt_json: null };

      if (result.outcome === 'succeeded') {
        next = 'succeeded';
        fields.result_attempt_id = attempt.id;
        fields.failure_class = null;
        fields.failure_message = null;
        fields.blocker_json = null;
      } else if (result.outcome === 'blocked') {
        next = 'blocked';
        fields.blocker_json = result.blocker ?? { reason: result.message };
        fields.failure_class = result.failureClass ?? null;
        fields.failure_message = result.message;
      } else if (
        result.outcome === 'cancelled' ||
        (this.store.run().cancel_requested && result.failureClass === 'cancellation')
      ) {
        next = 'cancelled';
        attemptOutcome = 'cancelled';
        fields.failure_class = 'cancellation';
        fields.failure_message = result.message;
      } else if (result.failureClass === 'uncertain') {
        next = 'recovery_required';
        attemptOutcome = 'uncertain';
        fields.failure_class = 'uncertain';
        fields.failure_message = result.message;

        this.store.setSessionQuarantine(attempt.session_name, `attempt ${attempt.id}: ${result.message}`);
      } else {
        const attempts = this.store.attempts(task.id);
        const started = startedAttempts(attempts);

        /**
         * Attempts that never started a provider are free to repeat, but a failure that recurs every time
         * (unwritable workspace, full disk, broken host) must not loop, so these attempts are capped with
         * a backoff between them.
         */
        const unstarted = attempts.filter((item) => item.provider === null && !item.exit?.providerStarted).length;

        const retryable = result.noEffects
          ? unstarted < MAX_UNSTARTED_ATTEMPTS
          : spec.retry.safeToRepeat && spec.retry.on.includes(result.failureClass) && started < spec.retry.maxAttempts;

        fields.failure_class = result.failureClass;

        fields.failure_message =
          !retryable && result.noEffects
            ? `${result.message} (${unstarted} attempts failed before a provider started)`
            : result.message;

        if (retryable && !this.store.run().cancel_requested && !this.store.run().dispatch_stopped) {
          next = 'ready';

          fields.not_before =
            this.clock.now() + (result.noEffects ? 1000 * 2 ** (unstarted - 1) : spec.retry.backoffMs);

          if (result.noEffects) {
            delete fields.next_attempt_json;
          }
        } else {
          next = 'failed';
        }
      }

      this.store.updateAttempt(attempt.id, {
        phase: 'finished',
        active: 0,
        outcome: attemptOutcome,
        failure_class: result.failureClass ?? null,
        failure_message: result.message ?? null,
        payload_json: result.payload ?? null,
        ended_at: attempt.ended_at ?? this.store.isoNow(),
      });

      this.store.appendEvent('attempt.finished', {
        taskId: task.id,
        attemptId: attempt.id,
        data: { outcome: attemptOutcome, failureClass: result.failureClass ?? null, message: result.message ?? null },
      });

      this.store.transitionTask(task.id, task.state, next, fields, {
        attemptId: attempt.id,
        reason: result.message ?? null,
      });
    });
  }

  async recoverUnfinished() {
    for (const attempt of this.store.activeAttempts()) {
      await this.reconcileAttempt(attempt.id);
    }
  }

  async reconcileAttempt(attemptId) {
    const attempt = this.store.attempt(attemptId);
    const decision = await this.runner.reconcile(attempt);

    this.store.ownerTx(() =>
      this.store.appendEvent('recovery.action', {
        taskId: attempt.task_id,
        attemptId,
        data: { action: decision.action, reason: decision.reason ?? null, evidence: decision.evidence ?? null },
      }),
    );

    const spec = this.store.task(attempt.task_id).spec;

    switch (decision.action) {
      case 'ingest': {
        this.runner.ingestExit(attempt, decision.exit);
        this.track(attemptId, this.verify(attemptId));

        break;
      }
      case 'verify': {
        this.track(attemptId, this.verify(attemptId));

        break;
      }
      case 'interrupted': {
        const readOnly = spec.workspace === 'shared-readonly';

        if (!decision.providerStarted) {
          this.finishAttempt(attemptId, {
            outcome: 'interrupted',
            failureClass: 'cancellation',
            message: 'interrupted before the provider started',
            noEffects: true,
          });
        } else if (readOnly) {
          const mutation = await this.readOnlyChange(attempt).catch(
            (error) => `its input cannot be checked: ${error.message}`,
          );

          this.finishAttempt(attemptId, {
            outcome: 'interrupted',
            failureClass: mutation ? 'verification' : 'transient',
            message: `interrupted read-only attempt; its process has stopped${mutation ? `; ${mutation}` : ''}`,
          });
        } else {
          this.finishAttempt(attemptId, {
            outcome: 'uncertain',
            failureClass: 'uncertain',
            message: 'interrupted editing attempt; its process has stopped but its effects need reconciliation',
          });
        }

        break;
      }
      default: {
        this.finishAttempt(attemptId, { outcome: 'uncertain', failureClass: 'uncertain', message: decision.reason });
      }
    }
  }

  // a decision cannot declare success, and it is rejected while any recorded process of that attempt is still alive
  async applyDecisions(document) {
    const rejected = [];

    for (const decision of document.decisions) {
      const reason = this.checkDecision(decision);

      if (reason) {
        rejected.push({ ...decision, reason });

        this.store.ownerTx(() =>
          this.store.appendEvent('recovery.decision_rejected', {
            taskId: decision.taskId ?? null,
            data: { decision, reason },
          }),
        );

        continue;
      }

      const attempt = this.store.attempt(decision.attemptId);
      const spec = this.store.task(decision.taskId).spec;
      const change = await this.captureCandidate(attempt, spec, `${attempt.id}.partial.patch`).catch(() => null);

      this.store.ownerTx(() => {
        if (change) {
          this.store.insertArtifact({
            id: `${attempt.id}-partial`,
            task_id: decision.taskId,
            attempt_id: attempt.id,
            kind: 'partial-patch',
            path: change.patchFile,
            sha256: change.sha256,
            bytes: change.bytes,
            data_json: { tree: change.tree, changes: change.changes },
          });
        }

        const to = decision.action === 'retry-after-reconciliation' ? 'ready' : 'failed';

        this.store.transitionTask(
          decision.taskId,
          'recovery_required',
          to,
          { failure_message: `recovery decision: ${decision.evidence}` },
          { decision },
        );

        if (to === 'ready') {
          this.store.setSessionQuarantine(attempt.session_name, null);
        }
      });
    }

    return rejected;
  }

  checkDecision(decision) {
    if (decision.evidence.trim().length < 10) {
      return 'evidence must describe the reconciliation that was performed';
    }

    const task = this.store.task(decision.taskId);

    if (!task) {
      return `unknown task ${decision.taskId}`;
    }

    if (task.state !== 'recovery_required') {
      return `task ${task.id} is ${task.state}, not recovery_required`;
    }

    if (task.state_version !== decision.stateVersion) {
      return `stale decision: task ${task.id} is at state version ${task.state_version}, decision names ${decision.stateVersion}`;
    }

    const latest = this.store.attempts(task.id).at(-1);

    if (!latest || latest.id !== decision.attemptId) {
      return `attempt ${decision.attemptId} is not the latest attempt of ${task.id}`;
    }

    if (latest.active) {
      return `attempt ${latest.id} is still active`;
    }

    // a host that died before recording its provider stays unprovable, and the operator's evidence covers that case
    const live = liveProcessReason(latest);

    if (live && !live.startsWith('the attempt host stopped before')) {
      return live;
    }

    return liveCheckReason(checkDir(this.runDir, task.id, latest.id));
  }

  async applyControls() {
    for (const control of this.store.pendingControls()) {
      let status = 'applied';
      let result = 'ok';

      if (control.kind === 'cancel') {
        result = this.applyCancel(control.task_id);
      } else if (control.kind === 'continue') {
        const task = this.store.task(control.task_id);

        if (!task) {
          status = 'rejected';
          result = `unknown task ${control.task_id}`;
        } else if (task.state !== 'blocked') {
          status = 'rejected';
          result = `task ${task.id} is ${task.state}; only blocked tasks can continue`;
        } else {
          const previous = this.store.attempts(task.id).at(-1);

          this.store.ownerTx(() =>
            this.store.transitionTask(
              task.id,
              'blocked',
              'ready',
              {
                next_attempt_json: {
                  kind: 'continuation',
                  previousAttemptId: previous.id,
                  promptText: control.data.promptText,
                  promptSource: control.data.promptSource ?? null,
                },
                blocker_json: null,
              },
              { control: control.id },
            ),
          );
        }
      }

      this.store.ownerTx(() => {
        this.store.resolveControl(control.id, status, result);

        this.store.appendEvent('control.resolved', {
          taskId: control.task_id,
          data: { id: control.id, kind: control.kind, status, result },
        });
      });
    }
  }

  applyCancel(taskId) {
    if (taskId === null) {
      this.store.ownerTx(() => this.store.update('runs', 'id', this.store.runId, { cancel_requested: 1 }));
      this.activeChecks.get(INTEGRATION_CHECKS)?.abort();
    }

    const targets = taskId === null ? this.store.tasks() : [this.store.task(taskId)].filter(Boolean);

    if (targets.length === 0) {
      return `unknown task ${taskId}`;
    }

    for (const task of targets) {
      const active = this.store.attempts(task.id).find((attempt) => attempt.active);

      if (active) {
        this.cancelActive(active, 'cancelled');
      } else if (['pending', 'ready', 'blocked'].includes(task.state)) {
        this.store.ownerTx(() =>
          this.store.transitionTask(task.id, task.state, 'cancelled', {
            failure_class: 'cancellation',
            failure_message: 'cancelled on request',
          }),
        );
      }
    }

    return 'requested';
  }

  cancelActive(attempt, reason) {
    if (attempt.phase === 'prepared') {
      // a host that has not launched yet finds the request when it starts and exits without starting the provider
      writeJsonAtomic(attempt.profile.files.cancel, { reason, at: new Date().toISOString() });
      return;
    }

    if (attempt.phase === 'launching' || attempt.phase === 'running') {
      this.runner.requestCancel(attempt, reason);
      return;
    }

    // an exited or verifying attempt has no provider left, but verification must not turn the stop into success
    writeJsonAtomic(attempt.profile.files.cancel, { reason, at: new Date().toISOString() });
    this.activeChecks.get(attempt.id)?.abort();
  }

  enforceRunDeadline() {
    const run = this.store.run();

    if (!run.deadline_at || this.clock.now() < run.deadline_at) {
      return;
    }

    if (run.dispatch_stopped !== 'run-deadline') {
      this.store.ownerTx(() => {
        this.store.update('runs', 'id', run.id, { dispatch_stopped: 'run-deadline' });
        this.store.appendEvent('run.deadline', { data: { deadlineAt: run.deadline_at } });
      });
    }

    this.activeChecks.get(INTEGRATION_CHECKS)?.abort();

    // this repeats every pass, so attempts started or recovered after the deadline passed are stopped too
    for (const attempt of this.store.activeAttempts()) {
      if (!readJsonReceipt(attempt.profile.files.cancel)) {
        this.cancelActive(attempt, 'run-deadline');
      }
    }
  }

  enforceSpendThreshold() {
    const threshold = this.limits.spendThresholdUsd;
    const run = this.store.run();

    if (!threshold || run.dispatch_stopped) {
      return;
    }

    const spent = this.store.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM attempts').get().total;

    if (spent >= threshold) {
      this.store.ownerTx(() => {
        this.store.update('runs', 'id', run.id, { dispatch_stopped: 'spend-threshold' });

        this.store.appendEvent('run.spend_threshold', {
          data: {
            spent,
            threshold,
            note: 'reported spend only; running workers continue and unknown costs are not counted',
          },
        });
      });
    }
  }

  // control requests and the run deadline still apply here, so a stop during integration does not wait for its checks
  async superviseIntegration() {
    let settled = false;

    const work = this.integrateIfReady().finally(() => {
      settled = true;
    });

    try {
      while (!settled) {
        if (this.lost) {
          throw new LeaseLostError();
        }

        await this.applyControls();
        this.enforceRunDeadline();
        this.refreshReport();

        await Promise.race([work.catch(() => {}), new Promise((resolve) => setTimeout(resolve, this.pollMs))]);
      }
    } catch (error) {
      this.activeChecks.get(INTEGRATION_CHECKS)?.abort();
      await work.catch(() => {});
      throw error;
    }

    await work;
  }

  integrationStop() {
    const run = this.store.run();

    if (run.cancel_requested) {
      return { reason: 'cancelled', message: 'cancelled on request' };
    }

    if (run.deadline_at && this.clock.now() >= run.deadline_at) {
      return { reason: 'run-deadline', message: 'run deadline exceeded' };
    }

    return null;
  }

  /**
   * Cancellation and the run deadline are judged inside the same transaction, after
   * every asynchronous step has finished, so a stop applied while the last step ran
   * still outranks its result.
   */
  recordIntegration(status, detail, extra = {}) {
    this.store.ownerTx(() => {
      const stop = this.integrationStop();

      let final = status;
      let data = detail;

      if (stop) {
        data = { ...detail, stoppedBy: detail.stoppedBy ?? stop.reason };

        if (status === 'passed' || status === 'failed') {
          final = 'failed';

          if (!data.failures?.includes(stop.message)) {
            data.failures = [...(data.failures ?? []), stop.message];
          }
        }
      }

      this.store.insertIntegration({ status: final, base_commit: this.input.commit, detail_json: data, ...extra });
      this.store.appendEvent('integration.finished', { data: { status: final, ...data } });
    });
  }

  /**
   * Settles what a previous owner left of integration, whatever this supervisor goes on to do
   * (dispatch, cancel, or nothing past the deadline).
   */
  async reconcileIntegrations() {
    this.integrationBlocked = null;

    if (!this.manifest.integration) {
      return;
    }

    const orphaned = await stopRecordedChecks(
      path.join(this.runDir, 'checks', 'integration'),
      this.limits.terminateGraceMs,
    );

    if (orphaned) {
      this.integrationBlocked = orphaned;

      this.recordIntegration('error', { error: orphaned });
      return;
    }

    const finished = new Set(this.store.integrations().map((row) => row.detail?.number));

    for (const { data } of this.store.eventsOfType('integration.started')) {
      if (finished.has(data.number)) {
        continue;
      }

      let error = `integration ${data.number} was interrupted before it recorded a result`;

      // the workspace is composed from artifacts and holds nothing else, so it is removed rather than trusted
      try {
        if (fs.existsSync(data.workspace)) {
          await removeWorktree(this.input.root, data.workspace);
        }
      } catch (removalError) {
        error += `; its workspace could not be removed: ${removalError.message}`;
      }

      this.recordIntegration('error', { number: data.number, workspace: data.workspace, error });
    }
  }

  /**
   * Integration composes artifacts in a separate workspace so the user's branch and checkout
   * are never modified.
   *
   * Each integration commits an `integration.started` event, with its number and workspace,
   * before the workspace exists, so reconcileIntegrations() can always find an integration
   * that a crash interrupted.
   */
  async integrateIfReady() {
    const integration = this.manifest.integration;

    if (!integration || this.integrationBlocked || this.store.latestIntegration()?.status === 'passed') {
      return;
    }

    if (!this.store.tasks().every((task) => task.state === 'succeeded') || this.integrationStop()) {
      return;
    }

    const record = (status, detail, extra) => this.recordIntegration(status, detail, extra);

    let number = null;
    let dir = null;

    try {
      const started = this.store.eventsOfType('integration.started').map((event) => event.data.number);

      number = Math.max(this.store.integrations().length, ...started) + 1;
      dir = path.join(this.runDir, 'workspaces', `_integration-${number}`);

      this.store.ownerTx(() => this.store.appendEvent('integration.started', { data: { number, workspace: dir } }));

      await this.integrate(integration, number, dir, record);
    } catch (error) {
      if (error instanceof LeaseLostError) {
        throw error;
      }

      record('error', { number, workspace: dir, error: error.message });
    }
  }

  async integrate(integration, number, dir, record) {
    const patches = integration.order.map((id) => {
      const attempt = this.store.attempt(this.store.task(id).result_attempt_id);
      const artifact = this.store.artifacts(attempt.id).find((item) => item.kind === 'patch');

      return { taskId: id, path: artifact.path, sha256: artifact.sha256 };
    });

    await addWorktree(this.input.root, dir, this.input.commit);

    const applied = await applyPatches(dir, patches);

    if (!applied.ok) {
      record('conflict', { number, workspace: dir, conflict: applied.conflict, order: integration.order });
      return;
    }

    const change = await captureChange({
      dir,
      baseTree: this.input.tree,
      startCommit: this.input.commit,
      patchFile: path.join(this.runDir, 'artifacts', `integration-${number}.patch`),
      maxBytes: this.limits.maxArtifactBytes,
    });

    const resultCommit = await commitTree(dir, change.tree, this.input.commit, `orchestrator integration ${number}`);
    const failures = [];

    let stoppedBy = null;

    for (const check of integration.checks) {
      const stop = this.integrationStop();

      if (stop) {
        failures.push(stop.message);

        stoppedBy = stop.reason;

        break;
      }

      const result = await this.runCheck({ check, cwd: dir, subject: change.tree, scope: 'integration' });

      if (!result.ok) {
        failures.push(`${check.name}: ${result.describe}`);
      }
    }

    const after = await snapshotTree(dir, this.input.commit);

    if (after !== change.tree) {
      failures.push('integration checks modified the combined workspace');
    }

    record(
      failures.length === 0 ? 'passed' : 'failed',
      {
        number,
        workspace: dir,
        order: integration.order,
        tree: change.tree,
        failures,
        changes: change.changes.length,
        stoppedBy,
      },
      { result_commit: resultCommit, patch_path: change.patchFile, patch_sha256: change.sha256 },
    );
  }
}

/**
 * Removes worker worktrees after checking that the run has no live owner, every task that used the workspace is
 * terminal or blocked, its attempts are finished with no live process, and its current contents are preserved.
 * An editing workspace must match its latest patch artifact (present and unaltered), and a read-only workspace
 * must match the input it started from. Run records are kept.
 */
export async function cleanupRun(runDir, { taskId = null, discardIgnored = false } = {}) {
  const store = Store.open(path.join(runDir, 'state.sqlite'));
  const removed = [];
  const kept = [];

  let retained;

  try {
    const run = store.run();

    configureSnapshotSandbox(run.manifest.checkSandbox);

    const workspaces = path.join(path.resolve(runDir), 'workspaces') + path.sep;

    if (run.owner_token && run.lease_expires_at > Date.now()) {
      throw new OrchestratorError('lease', 'a supervisor owns this run; wait for it to finish or cancel it first');
    }

    // continuations reuse their workspace and read-only tasks share one, so each workspace is judged by every user
    const users = new Map();

    for (const task of store.tasks()) {
      for (const attempt of store.attempts(task.id)) {
        const dir = attempt.workspace_path;

        if (!dir || !dir.startsWith(workspaces) || !fs.existsSync(dir)) {
          continue;
        }

        users.set(dir, [...(users.get(dir) ?? []), { task, attempt }]);
      }
    }

    for (const [dir, entries] of users) {
      if (taskId && !entries.some((entry) => entry.task.id === taskId)) {
        continue;
      }

      entries.sort((a, b) => a.attempt.created_at.localeCompare(b.attempt.created_at));

      const reason =
        (await cleanupBlocker(store, runDir, dir, entries)) ?? (discardIgnored ? null : await ignoredBlocker(dir));

      if (reason) {
        kept.push({ workspace: dir, reason });

        continue;
      }

      await removeWorktree(run.input.root, dir);
      removed.push(dir);
    }

    if (!taskId) {
      for (const integration of store.integrations()) {
        const dir = integration.detail?.workspace;

        if (!dir || !dir.startsWith(workspaces) || !fs.existsSync(dir)) {
          continue;
        }

        const reason =
          (await integrationCleanupBlocker(run, runDir, integration)) ??
          (discardIgnored ? null : await ignoredBlocker(dir));

        if (reason) {
          kept.push({ workspace: dir, reason });

          continue;
        }

        await removeWorktree(run.input.root, dir);
        removed.push(dir);
      }
    }

    // a disposable check checkout outlives its verification only after a crash, and holds nothing to preserve
    const taskDirectories = fs.readdirSync(workspaces, { withFileTypes: true });

    for (const entry of taskDirectories) {
      if (!entry.isDirectory() || entry.name.startsWith('_') || (taskId && entry.name !== taskId)) {
        continue;
      }

      const names = fs.readdirSync(path.join(workspaces, entry.name));

      for (const name of names) {
        if (!name.endsWith(CHECKS_SUFFIX)) {
          continue;
        }

        const dir = path.join(workspaces, entry.name, name);
        const live = liveCheckReason(checkDir(runDir, entry.name, name.slice(0, -CHECKS_SUFFIX.length)));

        if (live) {
          kept.push({ workspace: dir, reason: live });

          continue;
        }

        await removeWorktree(run.input.root, dir);
        removed.push(dir);
      }
    }

    retained = await retainedResources(run, runDir);
  } finally {
    store.close();
  }

  return { removed, kept, retained };
}

// snapshots and patches skip ignored files, so a worktree holding any is kept unless the operator discards them
async function ignoredBlocker(dir) {
  const ignored = await ignoredPaths(dir).catch(() => null);

  if (ignored === null) {
    return 'its ignored files cannot be listed, so it cannot be proved preserved';
  }

  if (ignored.length === 0) {
    return null;
  }

  const shown = ignored.slice(0, 5).join(', ') + (ignored.length > 5 ? `, and ${ignored.length - 5} more` : '');

  return `it holds ignored files that no patch preserves (${shown}); inspect them, then pass --discard-ignored to remove them`;
}

async function integrationCleanupBlocker(run, runDir, integration) {
  const check = liveCheckReason(path.join(runDir, 'checks', 'integration'));

  if (check) {
    return check;
  }

  if (!integration.patch_path) {
    return `integration ${integration.detail?.number} recorded no combined patch (${integration.status}), so its workspace is kept`;
  }

  let hash = null;

  try {
    hash = sha256File(integration.patch_path);
  } catch {
    // a missing patch fails the hash check below
  }

  if (hash !== integration.patch_sha256) {
    return `combined patch ${integration.patch_path} is missing or does not match its recorded hash`;
  }

  const tree = await snapshotTree(integration.detail.workspace, run.input.commit).catch(() => null);

  return tree && tree === integration.detail.tree
    ? null
    : `the integration workspace has changes that ${integration.patch_path} does not contain`;
}

// single quotes stop every expansion in a POSIX shell, and an embedded quote is closed, escaped, and reopened
export function shellQuote(value) {
  return `'${String(value).replaceAll("'", String.raw`'\''`)}'`;
}

/**
 * Lists what stays in the user's repository after cleanup (worktrees of this run that remain and the pinned refs),
 * with the commands that remove the refs once the run is no longer needed.
 */
async function retainedResources(run, runDir) {
  if (!run.input.git || !run.input.commit) {
    return null;
  }

  const prefix = `refs/orchestrator/${run.id}/`;
  const refs = await git(run.input.root, ['for-each-ref', '--format=%(refname)', prefix]);
  const worktrees = await git(run.input.root, ['worktree', 'list', '--porcelain']);
  const workspaces = path.join(path.resolve(runDir), 'workspaces');
  const prefixes = [workspaces, fs.realpathSync(workspaces)].map((dir) => dir + path.sep);

  // git prints real paths, which differ from the run path when it passes through a symlink such as /var on macOS
  const ours = worktrees.ok
    ? worktrees.stdout
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => line.slice('worktree '.length))
        .filter((dir) => prefixes.some((prefix) => dir.startsWith(prefix)))
    : [];

  const refNames = refs.ok ? refs.stdout.split('\n').filter(Boolean) : [];

  return {
    worktrees: ours,
    refs: refNames,
    removeRefs:
      refNames.length > 0
        ? `git -C ${shellQuote(run.input.root)} for-each-ref --format='delete %(refname)' ${shellQuote(prefix)} | git -C ${shellQuote(run.input.root)} update-ref --stdin`
        : null,
  };
}

async function cleanupBlocker(store, runDir, dir, entries) {
  for (const { task, attempt } of entries) {
    if (!TERMINAL_TASK_STATES.has(task.state) && task.state !== 'blocked') {
      return `task ${task.id} is ${task.state}`;
    }

    if (attempt.active) {
      return `attempt ${attempt.id} is active`;
    }

    if (task.state === 'blocked' && store.attempts(task.id).at(-1)?.id === attempt.id) {
      return 'a continuation resumes in this workspace';
    }

    const { files } = attempt.profile;

    for (const receipt of [readJsonReceipt(files.launch)?.host, readJsonReceipt(files.provider)?.identity]) {
      if (receipt && checkIdentity(receipt) === 'alive') {
        return `a process of attempt ${attempt.id} is still running`;
      }
    }

    const check = liveCheckReason(checkDir(runDir, task.id, attempt.id));

    if (check) {
      return check;
    }
  }

  const { task, attempt } = entries.at(-1);

  if (task.spec.workspace === 'shared-readonly') {
    const recorded = attempt.input?.fingerprint;

    if (!recorded) {
      return `attempt ${attempt.id} recorded no input fingerprint, so the workspace cannot be proved unchanged`;
    }

    const current = await fingerprintLike(dir, recorded, { startCommit: attempt.input.startCommit }).catch(() => null);

    return current === recorded ? null : `the workspace differs from the input attempt ${attempt.id} started from`;
  }

  const artifact = store
    .artifacts(attempt.id)
    .findLast((item) => item.kind === 'patch' || item.kind === 'partial-patch');

  if (!artifact) {
    return `attempt ${attempt.id} has no preserved patch artifact`;
  }

  let hash = null;

  try {
    hash = sha256File(artifact.path);
  } catch {
    // a missing artifact fails the hash check below
  }

  if (hash !== artifact.sha256) {
    return `patch artifact ${artifact.path} is missing or does not match its recorded hash`;
  }

  const tree = await snapshotTree(dir, attempt.input?.startCommit).catch(() => null);

  if (!tree || tree !== artifact.data?.tree) {
    return `the workspace has changes that patch artifact ${artifact.path} does not contain`;
  }

  return null;
}

const CHECK_PROCESS_SUFFIX = '.process.json';

const CHECKS_SUFFIX = '-checks';

// this is the key of the running integration check in Supervisor.activeChecks, and attempt ids cannot collide with it
const INTEGRATION_CHECKS = 'integration';

/**
 * Check commands start behind this gate. The shell waits for one line on stdin, which is written
 * only after the process record is on disk, then becomes the command with the same pid and start
 * time. If the supervisor dies first, the shell reads end of input and exits, so a command never
 * runs without a record.
 */
const CHECK_GATE = ['/bin/sh', '-c', 'read -r _ || exit 125; exec "$@"', 'check'];

function checkDir(runDir, taskId, attemptId) {
  return path.join(runDir, 'checks', taskId, attemptId);
}

function checkProcessFiles(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(CHECK_PROCESS_SUFFIX))
      .map((name) => path.join(dir, name));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

function checkProcessState(receipt) {
  if (!receipt || receipt.invalid || !receipt.pgid) {
    return 'unlocated';
  }

  if (checkIdentity(receipt.identity) === 'alive') {
    return 'alive';
  }

  // the leader is gone or its PID was reused, so members of its group may remain but cannot be verified
  return groupExists(receipt.pgid) ? 'unverifiable' : 'gone';
}

// an unreadable record stays unprovable, and the evidence of an operator decision covers that case
function liveCheckReason(dir) {
  for (const file of checkProcessFiles(dir)) {
    const receipt = readJsonReceipt(file);
    const state = checkProcessState(receipt);

    if (state === 'alive') {
      return `check command ${receipt.pid} is still running`;
    }

    if (state === 'unverifiable') {
      return `processes remain in check group ${receipt.pgid}`;
    }
  }

  return null;
}

async function stopRecordedChecks(dir, graceMs) {
  for (const file of checkProcessFiles(dir)) {
    const receipt = readJsonReceipt(file);
    const state = checkProcessState(receipt);

    if (state === 'unlocated') {
      return `check record ${file} is unreadable, so its process cannot be located`;
    }

    if (state === 'unverifiable') {
      return `processes remain in check group ${receipt.pgid} and cannot be verified`;
    }

    if (state === 'alive') {
      const { stopped } = await terminateGroup(receipt.pgid, { graceMs });

      if (!stopped) {
        return `check command ${receipt.pid} did not stop`;
      }
    }

    fs.rmSync(file, { force: true });
  }

  return null;
}

export { isGitWorkTree } from './artifacts.mjs';
