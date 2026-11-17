import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveExecutable } from './adapters/common.mjs';
import { getAdapter } from './adapters/index.mjs';
import { AttemptRunner, LEASE, liveProcessReason } from './attempt.mjs';
import { DEFAULT_LIMITS, OrchestratorError, compileResultSchema, randomIds } from './contracts.mjs';
import { faultPoint, writeJsonAtomic } from './process.mjs';
import { Store } from './store.mjs';
import { checkRuntime } from './supervisor.mjs';

export const WORKFLOW_CHECKPOINT_VERSION = 1;

export const WORKFLOW_LIMITS = Object.freeze({
  ...DEFAULT_LIMITS,

  // turns at high reasoning effort can be long, and the bound exists to stop hung workers, not slow ones
  attemptDeadlineMs: Number(process.env.ORCHESTRATOR_TURN_DEADLINE_MS) || 90 * 60 * 1000,
  maxStdoutBytes: 256 * 1024 * 1024,
});

export async function openWorkflow({
  runDir,
  kind,
  label,
  resume = false,
  env = process.env,
  limits = {},
  ids = randomIds(),
}) {
  const runtime = checkRuntime();

  if (runtime.problems.length > 0) {
    throw new OrchestratorError('launch', runtime.problems.join('\n'));
  }

  const file = path.join(runDir, 'state.sqlite');

  let store;

  if (resume) {
    if (!fs.existsSync(file)) {
      throw new OrchestratorError('usage', `${runDir} has no state.sqlite, so there is no run to resume`);
    }

    store = Store.open(file);

    const recorded = store.run().kind;

    if (recorded !== kind) {
      store.close();
      throw new OrchestratorError('usage', `${runDir} is a ${recorded} run, not ${kind}`);
    }
  } else {
    archivePreviousState(file);

    store = Store.create(file, { id: path.basename(runDir), kind, label, runDir, runtime });
  }

  try {
    store.acquireLease({ token: ids.nonce(), leaseMs: LEASE.leaseMs });
  } catch (error) {
    store.close();
    throw error;
  }

  const workflow = new Workflow({ store, runDir, kind, env, limits: { ...WORKFLOW_LIMITS, ...limits }, ids });

  if (resume) {
    await workflow.reconcile();
  }

  return workflow;
}

export class Workflow {
  constructor({ store, runDir, kind, env, limits, ids }) {
    this.store = store;
    this.runDir = runDir;
    this.kind = kind;
    this.env = env;
    this.limits = limits;
    this.ids = ids;
    this.lost = false;
    this.runner = new AttemptRunner({ store, runDir, ids, limits, ownerDb: store.file, env });

    this.heartbeat = setInterval(() => {
      try {
        store.renewLease(LEASE.leaseMs);
      } catch {
        this.lost = true;
      }
    }, LEASE.renewMs);

    this.heartbeat.unref();

    // the first interrupt cancels running workers (their turn then fails and the script reports it), and a second exits
    this.interrupts = 0;

    this.onSignal = (signal) => {
      this.interrupts++;

      // a second interrupt restores the default handler and re-raises the signal, which ends the process
      if (this.interrupts > 1) {
        process.off('SIGINT', this.onSignal);
        process.off('SIGTERM', this.onSignal);
        process.kill(process.pid, signal);
        return;
      }

      process.stderr.write('interrupt: stopping running workers; press again to exit immediately\n');

      for (const attempt of this.store.activeAttempts()) {
        if (attempt.phase === 'prepared') {
          writeJsonAtomic(attempt.profile.files.cancel, { reason: 'cancelled', at: new Date().toISOString() });
        } else {
          this.runner.requestCancel(attempt, 'cancelled');
        }
      }
    };

    process.on('SIGINT', this.onSignal);
    process.on('SIGTERM', this.onSignal);
  }

  async preflight(profiles) {
    return preflightWorkflowProfiles(profiles, { env: this.env });
  }

  tasksForStep(step) {
    return this.store.db
      .prepare('SELECT id FROM tasks WHERE step_key = ? ORDER BY ord')
      .all(step)
      .map((row) => this.store.task(row.id));
  }

  recordedTurn(step) {
    const task = this.tasksForStep(step).at(-1);

    if (!task) {
      return null;
    }

    const attempt = this.store.attempts(task.id).at(-1);

    return attempt ? turnResult(task, attempt, { replayed: true }) : null;
  }

  // `spec.files` names where the calling script wants the prompt and the provider output of this turn
  async runTurn(spec) {
    this.assertOwned();

    const previous = this.tasksForStep(spec.step).at(-1);

    if (previous?.state === 'succeeded' && !previous.consumed) {
      return turnResult(previous, this.store.attempts(previous.id).at(-1), { replayed: true });
    }

    const schemaText = fs.readFileSync(spec.schemaFile, 'utf8');

    // a schema that does not compile would otherwise fail only after the provider turn has run
    compileResultSchema(schemaText);

    if (previous?.state === 'recovery_required') {
      this.acceptUncertain(previous, spec);
    }

    if (previous) {
      this.preserveSuperseded(previous, spec.files);
    }

    const taskId = previous ? `${spec.step}~${this.tasksForStep(spec.step).length + 1}` : spec.step;
    const ord = this.store.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;
    const files = { prompt: spec.files.prompt, stdout: spec.files.stdout, stderr: spec.files.stderr };

    if (spec.files.lastMessage) {
      files.lastMessage = spec.files.lastMessage;
    }

    this.store.ownerTx(() =>
      this.store.insertTask({
        id: taskId,
        ord,
        stepKey: spec.step,
        state: 'ready',
        spec: { kind: 'turn', step: spec.step, adapter: spec.profile.adapter, readOnly: Boolean(spec.readOnly) },
        sessionName: spec.session,
      }),
    );

    let attempt = this.runner.reserve({
      taskId,
      fromState: 'ready',
      kind: 'initial',
      session: { name: spec.session, adapter: spec.profile.adapter, profile: null },
      profile: spec.profile,
      promptText: spec.promptText,
      schemaText,
      files,
    });

    const session = this.store.session(spec.session);
    const resumeSessionId = session?.provider_session_id ?? null;

    this.store.ownerTx(() => this.store.updateAttempt(attempt.id, { workspace_path: spec.cwd }));

    this.runner.launch(this.store.attempt(attempt.id), {
      cwd: spec.cwd,
      resumeSessionId,
      sessionName: resumeSessionId ? null : (spec.sessionDisplayName ?? null),
      isGitRepo: spec.isGitRepo ?? true,
      addDirs: spec.addDirs ?? [],
      deadlineMs: spec.deadlineMs ?? this.limits.attemptDeadlineMs,
    });

    const observed = await this.runner.waitForExit(attempt.id);

    attempt = this.store.attempt(attempt.id);

    if (observed.exit && !observed.exit.invalid) {
      attempt = this.runner.ingestExit(attempt, observed.exit);
      return this.finishTurn(attempt.id);
    }

    return this.settleWithoutReceipt(attempt.id, observed.exit?.invalid);
  }

  /**
   * An uncertain turn may have left a provider running or partial effects behind. It is rerun only
   * when the caller passes `acceptUncertain` (the operator's decision) and every recorded process
   * of it is verifiably gone.
   */
  acceptUncertain(task, spec) {
    const attempt = this.store.attempts(task.id).at(-1);

    if (!spec.acceptUncertain) {
      throw new OrchestratorError(
        'uncertain',
        `${spec.step} ended uncertain (${task.failure_message}); inspect its effects, then accept the rerun explicitly`,
      );
    }

    const live = liveProcessReason(attempt);

    if (live) {
      throw new OrchestratorError('uncertain', `${spec.step} cannot be rerun yet: ${live}`);
    }

    this.store.ownerTx(() => {
      this.store.setSessionQuarantine(attempt.session_name, null);

      this.store.appendEvent('recovery.accepted', {
        taskId: task.id,
        attemptId: attempt.id,
        data: { step: spec.step },
      });
    });
  }

  preserveSuperseded(task, files) {
    const attempt = this.store.attempts(task.id).at(-1);

    if (!attempt) {
      return;
    }

    const target = path.join(attempt.attempt_dir, 'superseded');

    for (const file of Object.values(files)) {
      if (file && fs.existsSync(file) && !file.startsWith(attempt.attempt_dir)) {
        fs.mkdirSync(target, { recursive: true });
        fs.copyFileSync(file, path.join(target, path.basename(file)));
      }
    }
  }

  finishTurn(attemptId) {
    const attempt = this.store.attempt(attemptId);
    const task = this.store.task(attempt.task_id);
    const evaluation = this.runner.evaluate(attempt, { generic: false, taskId: task.id, readOnly: task.spec.readOnly });

    this.commit(attempt, evaluation);
    faultPoint('after-turn-commit');

    return turnResult(this.store.task(task.id), this.store.attempt(attemptId), { replayed: false });
  }

  async settleWithoutReceipt(attemptId, invalid) {
    const attempt = this.store.attempt(attemptId);
    const decision = invalid ? { action: 'uncertain', reason: invalid } : await this.runner.reconcile(attempt);

    if (decision.action === 'ingest') {
      this.runner.ingestExit(attempt, decision.exit);
      return this.finishTurn(attemptId);
    }

    const readOnly = this.store.task(attempt.task_id).spec.readOnly;

    const evaluation =
      decision.action === 'interrupted' && (readOnly || !decision.providerStarted)
        ? {
            ok: false,
            outcome: 'interrupted',
            failureClass: decision.providerStarted ? 'transient' : 'cancellation',
            message: 'the attempt host stopped without an exit receipt; its process has stopped',
          }
        : {
            ok: false,
            outcome: 'uncertain',
            failureClass: 'uncertain',
            message: decision.reason ?? 'the attempt host stopped without an exit receipt',
          };

    this.commit(attempt, evaluation);

    return turnResult(this.store.task(attempt.task_id), this.store.attempt(attemptId), { replayed: false });
  }

  commit(attempt, evaluation) {
    const provider = evaluation.provider ?? null;

    this.store.ownerTx(() => {
      const task = this.store.task(attempt.task_id);

      if (provider?.sessionId) {
        this.store.recordProviderSession(attempt.session_name, provider.sessionId);
      }

      // nobody resumes a session whose last turn may still be running or may have left partial effects
      if (!evaluation.ok && evaluation.failureClass === 'uncertain') {
        this.store.setSessionQuarantine(attempt.session_name, `${task.id}: ${evaluation.message}`);
      }

      this.store.updateAttempt(attempt.id, {
        phase: 'finished',
        active: 0,
        outcome: evaluation.ok ? 'succeeded' : (evaluation.outcome ?? 'failed'),
        failure_class: evaluation.ok ? null : evaluation.failureClass,
        failure_message: evaluation.ok ? null : evaluation.message,
        provider_session_id: provider?.sessionId ?? attempt.provider_session_id ?? null,
        usage_json: provider?.usage ?? null,
        cost_usd: provider?.costUsd ?? null,
        result_json: provider,
        payload_json: evaluation.ok ? evaluation.payload : (provider?.payload ?? null),
        ended_at: attempt.ended_at ?? this.store.isoNow(),
      });

      this.store.appendEvent('attempt.finished', {
        taskId: task.id,
        attemptId: attempt.id,
        data: {
          outcome: evaluation.ok ? 'succeeded' : evaluation.outcome,
          failureClass: evaluation.failureClass ?? null,
        },
      });

      if (task.state === 'running') {
        this.store.transitionTask(task.id, 'running', 'verifying');
      }

      const next = evaluation.ok
        ? 'succeeded'
        : evaluation.failureClass === 'uncertain'
          ? 'recovery_required'
          : 'failed';

      this.store.transitionTask(task.id, 'verifying', next, {
        result_attempt_id: evaluation.ok ? attempt.id : null,
        failure_class: evaluation.ok ? null : evaluation.failureClass,
        failure_message: evaluation.ok ? null : evaluation.message,
      });
    });
  }

  async reconcile() {
    for (const attempt of this.store.activeAttempts()) {
      const decision = await this.runner.reconcile(attempt);

      this.store.ownerTx(() =>
        this.store.appendEvent('recovery.action', {
          taskId: attempt.task_id,
          attemptId: attempt.id,
          data: { action: decision.action, reason: decision.reason ?? null, evidence: decision.evidence ?? null },
        }),
      );

      if (decision.action === 'ingest') {
        this.runner.ingestExit(attempt, decision.exit);
        this.finishTurn(attempt.id);
      } else if (decision.action === 'verify') {
        this.finishTurn(attempt.id);
      } else {
        const readOnly = this.store.task(attempt.task_id).spec.readOnly;
        const harmless = decision.action === 'interrupted' && (readOnly || !decision.providerStarted);

        this.commit(attempt, {
          ok: false,
          outcome: harmless ? 'interrupted' : 'uncertain',
          failureClass: harmless ? 'transient' : 'uncertain',
          message: decision.reason ?? 'interrupted when the previous process stopped',
        });
      }
    }
  }

  // state and consumed turns are written in one transaction so a crash can neither lose a result nor count it twice
  checkpoint(state, consumedTaskIds = []) {
    this.store.ownerTx(() => {
      this.store.insertCheckpoint({
        workflow: this.kind,
        version: WORKFLOW_CHECKPOINT_VERSION,
        state,
        consumed: consumedTaskIds,
      });

      for (const id of consumedTaskIds) {
        this.store.updateTask(id, { consumed: 1 });
      }
    });
  }

  latestCheckpoint() {
    const row = this.store.latestCheckpoint(this.kind);

    if (row && row.version !== WORKFLOW_CHECKPOINT_VERSION) {
      throw new OrchestratorError('storage', `checkpoint version ${row.version} is not supported`);
    }

    return row ? { state: row.state, consumed: row.consumed, at: row.created_at } : null;
  }

  finish(outcome) {
    this.store.ownerTx(() => {
      this.store.update('runs', 'id', this.store.runId, {
        outcome,
        status: 'finished',
        updated_at: this.store.isoNow(),
      });

      this.store.appendEvent('run.outcome', { data: { outcome } });
    });
  }

  assertOwned() {
    if (this.lost) {
      throw new OrchestratorError('lease', 'workflow ownership was lost; another process took over this run');
    }
  }

  close() {
    clearInterval(this.heartbeat);
    process.off('SIGINT', this.onSignal);
    process.off('SIGTERM', this.onSignal);

    try {
      this.store.releaseLease();
    } finally {
      this.store.close();
    }
  }
}

function archivePreviousState(file) {
  if (!fs.existsSync(file)) {
    return;
  }

  const previous = Store.open(file);

  try {
    const run = previous.run();

    if (run?.owner_token && run.lease_expires_at > Date.now()) {
      throw new OrchestratorError(
        'lease',
        `${path.dirname(file)} is in use by a live run until ${new Date(run.lease_expires_at).toISOString()}`,
      );
    }

    previous.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    previous.close();
  }

  const stamp = new Date().toISOString().replaceAll(/[-:.]/g, '');

  fs.renameSync(file, file.replace(/\.sqlite$/, `.${stamp}.sqlite`));

  for (const suffix of ['-wal', '-shm']) {
    fs.rmSync(`${file}${suffix}`, { force: true });
  }
}

// results are built from durable rows so replay and live runs produce the same shape
function turnResult(task, attempt, { replayed }) {
  const provider = attempt.result ?? null;
  const ok = task.state === 'succeeded';

  return {
    ok,
    replayed,
    step: task.step_key,
    taskId: task.id,
    attemptId: attempt.id,
    payload: ok ? attempt.payload : null,
    providerPayload: provider?.payload ?? null,
    sessionId: provider?.sessionId ?? attempt.provider_session_id ?? null,
    usage: provider?.usage ?? null,
    costUsd: provider?.costUsd ?? null,
    numTurns: provider?.numTurns ?? null,
    permissionDenials: provider?.permissionDenials ?? [],
    durationMs: attempt.exit?.durationMs ?? null,
    exit: attempt.exit
      ? {
          code: attempt.exit.code ?? null,
          signal: attempt.exit.signal ?? null,
          terminalReason: attempt.exit.terminalReason ?? null,
        }
      : null,
    providerOutcome: provider?.providerOutcome ?? null,
    providerMessage: provider?.message ?? null,
    diagnostics: provider?.diagnostics ?? null,
    failure: ok
      ? null
      : {
          class: attempt.failure_class ?? task.failure_class,
          message: attempt.failure_message ?? task.failure_message,
        },
    files: attempt.profile.files,
  };
}

export async function preflightWorkflowProfiles(profiles, { env = process.env } = {}) {
  const resolved = {};
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-probe-'));

  try {
    const schemaFile = path.join(probeDir, 'schema.json');

    fs.writeFileSync(schemaFile, '{"type":"object"}');

    for (const [name, profile] of Object.entries(profiles)) {
      const adapter = getAdapter(profile.adapter);
      const context = { cwd: probeDir, env, schemaFile, lastMessageFile: path.join(probeDir, 'last.json') };

      let executable;

      try {
        executable = await resolveExecutable(adapter, {
          profileExecutable: profile.executable ?? null,
          env,
          accept: (argv) => adapter.probe({ ...profile, executable: argv }, context),
        });
      } catch (error) {
        throw new OrchestratorError('launch', `profile ${name}: ${error.message}`);
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

  return resolved;
}
