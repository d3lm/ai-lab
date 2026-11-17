import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAdapter } from './adapters/index.mjs';
import { OrchestratorError, compileResultSchema, formatSchemaErrors, sha256 } from './contracts.mjs';
import {
  checkIdentity,
  faultPoint,
  groupExists,
  readJsonLines,
  readJsonReceipt,
  signalProcess,
  terminateGroup,
  waitFor,
  writeFileAtomic,
  writeJsonAtomic,
} from './process.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const HOST_SCRIPT = path.resolve(HERE, '..', 'attempt-host.mjs');

const envMs = (name, fallback) => {
  const value = Number(process.env[name]);

  return Number.isInteger(value) && value > 0 ? value : fallback;
};

// supervisors and attempt hosts must agree on this timing, and ORCHESTRATOR_LEASE_MS lets tests shorten all of it
export const LEASE = (() => {
  const leaseMs = envMs('ORCHESTRATOR_LEASE_MS', 30_000);

  return Object.freeze({
    leaseMs,
    renewMs: Math.max(100, Math.floor(leaseMs / 6)),
    hostGraceMs: leaseMs,
    hostCheckMs: Math.max(100, Math.min(2000, Math.floor(leaseMs / 4))),
  });
})();

// overrides let a workflow put the prompt and the provider output where its own run layout expects them
export function attemptFiles(attemptDir, overrides = {}) {
  return {
    prompt: path.join(attemptDir, 'prompt.md'),
    schema: path.join(attemptDir, 'result.schema.json'),
    profile: path.join(attemptDir, 'profile.json'),
    hostConfig: path.join(attemptDir, 'host-config.json'),
    launch: path.join(attemptDir, 'launch.json'),
    provider: path.join(attemptDir, 'provider.json'),
    heartbeat: path.join(attemptDir, 'heartbeat.json'),
    events: path.join(attemptDir, 'events.jsonl'),
    stdout: path.join(attemptDir, 'stdout.jsonl'),
    stderr: path.join(attemptDir, 'stderr.log'),
    lastMessage: path.join(attemptDir, 'final-message.json'),
    providerResult: path.join(attemptDir, 'provider-result.json'),
    exit: path.join(attemptDir, 'exit.json'),
    cancel: path.join(attemptDir, 'cancel.json'),
    ...overrides,
  };
}

// callers must get null here before anything reuses an uncertain attempt's task or session
export function liveProcessReason(attempt) {
  const { files } = attempt.profile;
  const launch = readJsonReceipt(files.launch);
  const provider = readJsonReceipt(files.provider);

  if (launch?.host && checkIdentity(launch.host) === 'alive') {
    return `attempt host ${launch.host.pid} is still running`;
  }

  if (provider?.identity && checkIdentity(provider.identity) === 'alive') {
    return `provider ${provider.pid} is still running`;
  }

  if (provider?.pgid && groupExists(provider.pgid)) {
    return `processes remain in provider group ${provider.pgid}`;
  }

  if (launch && !provider && !readJsonReceipt(files.exit)) {
    return 'the attempt host stopped before recording its provider, so the provider cannot be located';
  }

  return null;
}

export function startedAttempts(attempts) {
  return attempts.filter((attempt) => attempt.provider !== null || attempt.exit?.providerStarted).length;
}

export class AttemptRunner {
  constructor({ store, runDir, ids, limits, ownerDb, hostScript = HOST_SCRIPT, env = process.env }) {
    this.store = store;
    this.runDir = runDir;
    this.ids = ids;
    this.limits = limits;
    this.ownerDb = ownerDb;
    this.hostScript = hostScript;
    this.env = env;
    this.hosts = new Map();
  }

  reserve(request) {
    const attemptId = this.ids.next('a');
    const attemptDir = request.attemptDir ?? path.join(this.runDir, 'tasks', request.taskId, 'attempts', attemptId);
    const files = attemptFiles(attemptDir, request.files);
    const body = typeof request.promptText === 'function' ? request.promptText(attemptId) : request.promptText;

    // an adapter whose CLI cannot take the result schema carries it in the prompt, and prompt.md records what was sent
    const promptText = body + (getAdapter(request.profile.adapter).resultInstructions?.(request.schemaText) ?? '');

    this.store.ownerTx(() => {
      const number = this.store.attempts(request.taskId).length + 1;

      this.store.upsertSession(request.session);

      this.store.transitionTask(
        request.taskId,
        request.fromState,
        'running',
        {},
        {
          attemptId,
          kind: request.kind,
          ...request.transitionData,
        },
      );

      this.store.insertAttempt({
        id: attemptId,
        task_id: request.taskId,
        number,
        kind: request.kind,
        previous_attempt_id: request.previousAttemptId ?? null,
        session_name: request.session.name,
        phase: 'prepared',
        active: 1,
        nonce: this.ids.nonce(),
        owner_generation: this.store.generation,
        attempt_dir: attemptDir,
        profile_json: { profile: request.profile, files },
        prompt_sha256: sha256(promptText),
      });

      this.store.appendEvent('attempt.prepared', {
        taskId: request.taskId,
        attemptId,
        data: { number, kind: request.kind },
      });
    });

    fs.mkdirSync(path.dirname(attemptDir), { recursive: true });
    fs.mkdirSync(attemptDir);

    for (const file of [files.prompt, files.stdout, files.stderr, files.lastMessage]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    }

    writeFileAtomic(files.prompt, promptText);
    writeFileAtomic(files.schema, request.schemaText);
    writeJsonAtomic(files.profile, request.profile);

    return this.store.attempt(attemptId);
  }

  launch(attempt, context) {
    const { profile, files } = attempt.profile;
    const adapter = getAdapter(profile.adapter);

    const invocation = adapter.buildInvocation({
      profile,
      schemaText: fs.readFileSync(files.schema, 'utf8'),
      schemaFile: files.schema,
      lastMessageFile: files.lastMessage,
      promptFile: files.prompt,
      cwd: context.cwd,
      resumeSessionId: context.resumeSessionId ?? null,
      sessionName: context.sessionName ?? null,
      isGitRepo: context.isGitRepo ?? true,
      addDirs: context.addDirs ?? [],
    });

    const hostConfig = {
      protocol: 1,
      runId: this.store.runId,
      taskId: attempt.task_id,
      attemptId: attempt.id,
      nonce: attempt.nonce,
      adapter: profile.adapter,
      invocation: { ...invocation, env: invocation.env },
      files,
      heartbeatMs: 2000,
      limits: {
        deadlineMs: context.deadlineMs,
        terminateGraceMs: this.limits.terminateGraceMs,
        maxStdoutBytes: this.limits.maxStdoutBytes,
        maxStderrBytes: this.limits.maxStderrBytes,
        maxRecordBytes: this.limits.maxRecordBytes,
      },
      owner: this.ownerDb
        ? {
            db: this.ownerDb,
            generation: attempt.owner_generation,
            leaseGraceMs: LEASE.hostGraceMs,
            checkIntervalMs: LEASE.hostCheckMs,
            confirmMs: LEASE.renewMs * 3,
          }
        : null,
    };

    writeJsonAtomic(files.hostConfig, hostConfig);

    // a final message left by an earlier attempt at the same path must never be read as this attempt's result
    if (files.lastMessage) {
      fs.rmSync(files.lastMessage, { force: true });
    }

    this.store.ownerTx(() => {
      this.store.updateAttempt(attempt.id, {
        phase: 'launching',
        launched_at: this.store.isoNow(),
        profile_json: { profile, files, invocation: { argv: invocation.argv, cwd: invocation.cwd } },
      });

      this.store.appendEvent('attempt.launching', { taskId: attempt.task_id, attemptId: attempt.id });
    });

    faultPoint('after-launch-record');

    // a supervisor that lost ownership while preparing must not start new work
    this.store.ownerTx(() => {});

    const host = spawn(process.execPath, [this.hostScript, files.hostConfig], {
      detached: true,
      stdio: 'ignore',
      env: this.env,
    });

    host.unref();
    faultPoint('after-host-spawn');

    const entry = { exited: false };

    host.on('exit', () => {
      entry.exited = true;
    });

    host.on('error', () => {
      entry.exited = true;
    });

    this.hosts.set(attempt.id, entry);
  }

  observe(attempt) {
    const { files } = attempt.profile;
    const provider = attempt.provider ? null : readJsonReceipt(files.provider);
    const { records } = readJsonLines(files.events);
    const fresh = records.filter((event) => event.seq > attempt.events_offset);
    const sessionEvent = fresh.findLast((event) => event.type === 'session' && event.sessionId);
    const exit = readJsonReceipt(files.exit);
    const updates = {};

    if (provider && !provider.invalid && provider.nonce === attempt.nonce) {
      updates.provider_json = provider;

      if (attempt.phase === 'launching') {
        updates.phase = 'running';
      }
    }

    if (fresh.length > 0) {
      updates.events_offset = fresh.at(-1).seq;
      updates.last_activity_at = fresh.at(-1).at;
    }

    if (sessionEvent || Object.keys(updates).length > 0) {
      this.store.ownerTx(() => {
        this.store.updateAttempt(attempt.id, updates);

        if (updates.provider_json) {
          this.store.appendEvent('attempt.provider_started', {
            taskId: attempt.task_id,
            attemptId: attempt.id,
            data: { pid: provider.pid, identity: provider.identity },
          });
        }

        if (sessionEvent && sessionEvent.sessionId !== attempt.provider_session_id) {
          this.store.updateAttempt(attempt.id, { provider_session_id: sessionEvent.sessionId });
          this.store.recordProviderSession(attempt.session_name, sessionEvent.sessionId);
        }
      });
    }

    if (exit && !exit.invalid && exit.nonce === attempt.nonce) {
      return { exit };
    }

    if (exit?.invalid || (exit && exit.nonce !== attempt.nonce)) {
      return { exit: { invalid: exit.invalid ?? `exit receipt nonce does not match attempt ${attempt.id}` } };
    }

    if (this.hosts.get(attempt.id)?.exited) {
      return { exit: null, hostGone: true };
    }

    return { exit: null };
  }

  ingestExit(attempt, exit) {
    this.store.ownerTx(() => {
      const current = this.store.attempt(attempt.id);

      if (current.exit !== null) {
        return;
      }

      this.store.updateAttempt(attempt.id, {
        exit_json: exit,
        phase: 'exited',
        ended_at: exit.endedAt ?? this.store.isoNow(),
      });

      this.store.appendEvent('attempt.exited', {
        taskId: attempt.task_id,
        attemptId: attempt.id,
        data: { code: exit.code ?? null, signal: exit.signal ?? null, terminalReason: exit.terminalReason ?? null },
      });
    });

    this.hosts.delete(attempt.id);

    return this.store.attempt(attempt.id);
  }

  async waitForExit(attemptId, { pollMs = 100 } = {}) {
    while (true) {
      const attempt = this.store.attempt(attemptId);
      const observed = this.observe(attempt);

      if (observed.exit) {
        return observed;
      }

      if (observed.hostGone) {
        // the receipt may land just after the process exit is reported
        await new Promise((resolve) => setTimeout(resolve, 200));

        const retry = this.observe(this.store.attempt(attemptId));

        return retry.exit ? retry : { exit: null, hostGone: true };
      }

      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  /**
   * The process outcome is checked before the provider outcome, and both before the payload,
   * so a valid-looking payload never overrides a failed process or provider.
   */
  evaluate(attempt, { generic, taskId, readOnly }) {
    const { profile, files } = attempt.profile;
    const exit = attempt.exit;

    if (!exit || exit.invalid) {
      return {
        ok: false,
        outcome: 'uncertain',
        failureClass: 'uncertain',
        message: exit?.invalid ?? 'no exit receipt',
      };
    }

    const interrupted = (reason) =>
      exit.providerStarted
        ? readOnly
          ? { ok: false, outcome: 'interrupted', failureClass: 'transient', message: reason }
          : {
              ok: false,
              outcome: 'uncertain',
              failureClass: 'uncertain',
              message: `${reason}; an editing worker may have left partial effects`,
            }
        : {
            ok: false,
            outcome: 'interrupted',
            failureClass: 'cancellation',
            message: `${reason} before the provider started`,
            noEffects: true,
          };

    // whatever ended the attempt, a group that could not be confirmed stopped leaves the outcome unproven
    if (exit.descendants && (!exit.descendants.stopped || exit.descendants.streamsAbandoned)) {
      return {
        ok: false,
        outcome: 'uncertain',
        failureClass: 'uncertain',
        message: `attempt ended (${exit.terminalReason}) but provider descendants could not be confirmed stopped`,
      };
    }

    switch (exit.terminalReason) {
      case 'spawn-error': {
        return {
          ok: false,
          outcome: 'failed',
          failureClass: 'launch',
          message: `provider failed to start: ${exit.spawnError}`,
        };
      }
      case 'deadline': {
        return {
          ok: false,
          outcome: 'failed',
          failureClass: 'budget',
          message: `attempt deadline exceeded after ${exit.durationMs} ms`,
        };
      }
      case 'output-limit': {
        return {
          ok: false,
          outcome: 'failed',
          failureClass: 'budget',
          message: 'provider output exceeded the configured limit',
        };
      }
      case 'cancelled': {
        return { ok: false, outcome: 'cancelled', failureClass: 'cancellation', message: 'cancelled on request' };
      }
      case 'run-deadline': {
        return { ok: false, outcome: 'failed', failureClass: 'budget', message: 'run deadline exceeded' };
      }
      case 'owner-lost':
      case 'recovery': {
        return interrupted(
          exit.terminalReason === 'owner-lost' ? 'supervisor ownership was lost' : 'stopped during recovery',
        );
      }
      case 'exited': {
        break;
      }
      default: {
        return {
          ok: false,
          outcome: 'uncertain',
          failureClass: 'uncertain',
          message: `unknown terminal reason ${exit.terminalReason}`,
        };
      }
    }

    const adapter = getAdapter(profile.adapter);

    const provider = adapter.parseResult({
      stdoutFile: files.stdout,
      stderrFile: files.stderr,
      lastMessageFile: files.lastMessage,
    });

    writeJsonAtomic(files.providerResult, provider);

    if (exit.code !== 0 || exit.signal) {
      const failureClass = provider.providerOutcome === 'failure' ? provider.failureClass : 'transient';

      return {
        ok: false,
        outcome: 'failed',
        failureClass,
        provider,
        message: `provider exited with ${exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`}${provider.message ? `; ${provider.message}` : ''}`,
      };
    }

    if (provider.providerOutcome !== 'success') {
      return { ok: false, outcome: 'failed', failureClass: provider.failureClass, provider, message: provider.message };
    }

    if (provider.failureClass) {
      return { ok: false, outcome: 'failed', failureClass: provider.failureClass, provider, message: provider.message };
    }

    const schemaErrors = compileResultSchema(fs.readFileSync(files.schema, 'utf8'))(provider.payload);

    if (schemaErrors.length > 0) {
      return {
        ok: false,
        outcome: 'failed',
        failureClass: 'protocol',
        provider,
        message: `result does not satisfy its schema: ${formatSchemaErrors(schemaErrors)}`,
      };
    }

    if (generic && (provider.payload.taskId !== taskId || provider.payload.attemptId !== attempt.id)) {
      return {
        ok: false,
        outcome: 'failed',
        failureClass: 'protocol',
        provider,
        message: `result names task ${provider.payload.taskId} attempt ${provider.payload.attemptId}, expected ${taskId} ${attempt.id}`,
      };
    }

    return { ok: true, provider, payload: provider.payload };
  }

  requestCancel(attempt, reason) {
    const { files } = attempt.profile;

    writeJsonAtomic(files.cancel, { reason, at: new Date().toISOString() });

    const launch = readJsonReceipt(files.launch);

    if (launch?.host && !launch.invalid && checkIdentity(launch.host) === 'alive') {
      signalProcess(launch.host.pid, 'SIGTERM');
      return 'requested';
    }

    const provider = readJsonReceipt(files.provider);

    if (provider?.identity && !provider.invalid && checkIdentity(provider.identity) === 'alive') {
      void terminateGroup(provider.pgid, { graceMs: this.limits.terminateGraceMs });
      return 'requested';
    }

    return launch ? 'not-running' : 'unverified';
  }

  // nothing is inferred from a final-message file alone, because an earlier or interrupted write can leave one behind
  async reconcile(attempt) {
    const { files } = attempt.profile;

    if (attempt.phase === 'exited' || attempt.phase === 'verifying') {
      return { action: 'verify' };
    }

    const exit = readJsonReceipt(files.exit);
    const isOwnReceipt = (receipt) => Boolean(receipt) && !receipt.invalid && receipt.nonce === attempt.nonce;

    if (isOwnReceipt(exit)) {
      return { action: 'ingest', exit };
    }

    const launch = readJsonReceipt(files.launch);

    const evidence = {
      phase: attempt.phase,
      exitReceipt: exit ? (exit.invalid ?? 'nonce mismatch') : 'absent',
      launchReceipt: launch ? (launch.invalid ?? 'present') : 'absent',
    };

    if (attempt.phase === 'prepared') {
      return { action: 'interrupted', providerStarted: false, evidence };
    }

    const hostState = launch?.host && !launch.invalid ? checkIdentity(launch.host) : launch ? 'unknown' : 'none';

    evidence.host = hostState;

    if (hostState === 'alive') {
      writeJsonAtomic(files.cancel, { reason: 'recovery', at: new Date().toISOString() });
      signalProcess(launch.host.pid, 'SIGTERM');

      const waitMs = this.limits.terminateGraceMs + 15_000;
      const finished = () => isOwnReceipt(readJsonReceipt(files.exit)) || checkIdentity(launch.host) !== 'alive';

      if (!(await waitFor(finished, waitMs, 100))) {
        return {
          action: 'uncertain',
          reason: `attempt host ${launch.host.pid} did not stop within ${waitMs} ms`,
          evidence,
        };
      }
    }

    // a host writes its receipt before it exits, so a receipt that landed after the first look is final by now
    const landed = readJsonReceipt(files.exit);

    if (isOwnReceipt(landed)) {
      return { action: 'ingest', exit: landed };
    }

    // the host is gone and can no longer record a provider, so this look at the provider receipt is final as well
    const provider = readJsonReceipt(files.provider);

    const providerState =
      provider?.identity && !provider.invalid ? checkIdentity(provider.identity) : provider ? 'unknown' : 'none';

    evidence.providerReceipt = provider ? (provider.invalid ?? 'present') : 'absent';
    evidence.provider = providerState;

    if (hostState === 'unknown' || providerState === 'unknown') {
      return {
        action: 'uncertain',
        reason: 'a receipt is unreadable, so process ownership cannot be verified',
        evidence,
      };
    }

    if (providerState === 'alive') {
      const result = await terminateGroup(provider.pgid, { graceMs: this.limits.terminateGraceMs });

      evidence.providerTerminated = result;

      return result.stopped
        ? { action: 'interrupted', providerStarted: true, evidence }
        : { action: 'uncertain', reason: `provider group ${provider.pgid} did not stop`, evidence };
    }

    if (provider) {
      // the leader is gone or its PID was reused, so members of its group may remain but cannot be verified
      if (providerState === 'gone' && groupExists(provider.pgid)) {
        return {
          action: 'uncertain',
          reason: `processes remain in provider group ${provider.pgid} and cannot be verified`,
          evidence,
        };
      }

      return { action: 'interrupted', providerStarted: true, evidence };
    }

    if (launch) {
      return {
        action: 'uncertain',
        reason: 'the attempt host stopped before recording its provider process',
        evidence,
      };
    }

    // without a receipt, the host never ran or it starts late, finds the new ownership generation, and exits
    return { action: 'interrupted', providerStarted: false, evidence };
  }
}

export function assertActive(attempt) {
  if (!attempt.active) {
    throw new OrchestratorError('state', `attempt ${attempt.id} is not active`);
  }
}
