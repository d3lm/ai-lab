#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { getAdapter } from './lib/adapters/index.mjs';
import {
  cappedSink,
  createLineDecoder,
  faultPoint,
  groupExists,
  processIdentity,
  readJsonReceipt,
  terminateGroup,
  writeJsonAtomic,
} from './lib/process.mjs';

const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { files, limits } = config;
const adapter = getAdapter(config.adapter);
const startedAt = new Date().toISOString();
const started = performance.now();

let cancelReason = null;
let provider = null;
let providerStarted = false;
let providerExited = false;
let spawnError = null;
let protocolErrors = 0;
let lastActivityAt = null;
let eventSeq = 0;
let ownerDb = null;
let streamsAbandoned = false;
let exitWritten = false;

// a supervisor can signal this host as soon as the launch receipt names it, so the handlers come first
process.on('SIGTERM', cancelFromRequest);
process.on('SIGINT', cancelFromRequest);
process.on('SIGHUP', cancelFromRequest);

writeJsonAtomic(files.launch, {
  protocol: 1,
  nonce: config.nonce,
  runId: config.runId,
  taskId: config.taskId,
  attemptId: config.attemptId,
  ownerGeneration: config.owner?.generation ?? null,
  host: processIdentity(process.pid),
  startedAt,
});

const eventsFd = fs.openSync(files.events, 'a');

// the descriptor is closed once the exit receipt is written, and a closed number may already belong to another file
function appendEvent(event) {
  if (exitWritten) {
    return;
  }

  fs.writeSync(eventsFd, JSON.stringify({ seq: ++eventSeq, at: new Date().toISOString(), ...event }) + '\n');
}

async function openOwnerDb() {
  if (ownerDb || !config.owner) {
    return ownerDb;
  }

  const { DatabaseSync } = await import('node:sqlite');

  ownerDb = new DatabaseSync(config.owner.db, { readOnly: true });

  ownerDb.exec('PRAGMA busy_timeout = 2000');

  return ownerDb;
}

/**
 * `superseded` means another owner took the run, so the watcher acts at once. `expired` means the
 * lease lapsed, which can also happen when a machine wakes from sleep before the supervisor renews,
 * so the watcher confirms it over time first. `unknown` means the database is briefly unreadable.
 */
async function ownerStatus() {
  if (!config.owner) {
    return 'valid';
  }

  try {
    const db = await openOwnerDb();
    const row = db.prepare('SELECT owner_generation, lease_expires_at FROM runs WHERE id = ?').get(config.runId);

    if (!row || row.owner_generation !== config.owner.generation) {
      return 'superseded';
    }

    return row.lease_expires_at + config.owner.leaseGraceMs < Date.now() ? 'expired' : 'valid';
  } catch {
    return 'unknown';
  }
}

async function cancel(reason) {
  if (cancelReason || exitWritten) {
    return;
  }

  cancelReason = reason;

  appendEvent({ type: 'cancel', reason });

  if (provider?.pid) {
    await terminateGroup(provider.pid, { graceMs: limits.terminateGraceMs });
  }
}

// a request to stop that arrives after the provider exited on its own did not end it, so the exit stays what it was
function requestStop(reason) {
  if (!providerExited) {
    void cancel(reason);
  }
}

function cancelFromRequest() {
  const request = readJsonReceipt(files.cancel);

  requestStop(request && !request.invalid && request.reason ? String(request.reason) : 'cancelled');
}

function writeExit(fields) {
  if (exitWritten) {
    return;
  }

  exitWritten = true;

  fs.closeSync(eventsFd);
  faultPoint('before-exit-receipt');

  writeJsonAtomic(files.exit, {
    protocol: 1,
    nonce: config.nonce,
    attemptId: config.attemptId,
    providerStarted,
    code: null,
    signal: null,
    terminalReason: cancelReason ?? 'exited',
    spawnError,
    startedAt,
    endedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
    lastActivityAt,
    protocolErrors,
    ...fields,
  });

  /**
   * Removing the last listener restores the default action, which ends the process. That is wanted
   * only once the receipt is on disk, because a supervisor that cancels or recovers this attempt
   * signals the host while it may be finishing, and a host that dies before its receipt leaves
   * the attempt unproven.
   */
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.off(signal, cancelFromRequest);
  }
}

async function main() {
  if (['superseded', 'expired'].includes(await ownerStatus())) {
    cancelReason = 'owner-lost';

    writeExit({});
    return;
  }

  if (cancelReason || fs.existsSync(files.cancel)) {
    cancelReason ??= 'cancelled';

    writeExit({});
    return;
  }

  const { argv, cwd, env } = config.invocation;

  let stdoutOverflow = false;
  let stderrOverflow = false;

  const stdout = cappedSink(files.stdout, limits.maxStdoutBytes, () => {
    stdoutOverflow = true;
    void cancel('output-limit');
  });

  const stderr = cappedSink(files.stderr, limits.maxStderrBytes, () => {
    stderrOverflow = true;
    void cancel('output-limit');
  });

  const decoder = createLineDecoder({
    maxRecordBytes: limits.maxRecordBytes,
    onRecord: (line) => {
      let record;

      try {
        record = JSON.parse(line);
      } catch {
        protocolErrors++;
        return;
      }

      for (const event of adapter.parseEvent(record)) {
        appendEvent(event);
      }
    },
    onOversize: (bytes) => {
      protocolErrors++;
      appendEvent({ type: 'protocol-error', message: `record exceeded ${limits.maxRecordBytes} bytes (${bytes})` });
    },
  });

  try {
    provider = spawn(argv[0], argv.slice(1), {
      cwd,
      env: { ...process.env, ...env },
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    spawnError = error.message;
  }

  if (!provider) {
    stdout.close();
    stderr.close();

    cancelReason ??= 'spawn-error';

    writeExit({});
    return;
  }

  const outcome = await new Promise((resolve) => {
    let exitInfo = null;
    let openStreams = 2;

    const settle = () => {
      if (exitInfo && openStreams === 0) {
        resolve(exitInfo);
      }
    };

    provider.on('error', (error) => {
      spawnError = error.message;

      if (!providerStarted) {
        cancelReason ??= 'spawn-error';

        resolve({ code: null, signal: null });
      }
    });

    provider.on('spawn', () => {
      providerStarted = true;

      writeJsonAtomic(files.provider, {
        nonce: config.nonce,
        attemptId: config.attemptId,
        pid: provider.pid,
        pgid: provider.pid,
        identity: processIdentity(provider.pid),
        argv0: argv[0],
        startedAt: new Date().toISOString(),
      });

      appendEvent({ type: 'provider-started', pid: provider.pid });

      // a cancellation that arrived while spawning applies now
      if (cancelReason) {
        void terminateGroup(provider.pid, { graceMs: limits.terminateGraceMs });
      }
    });

    provider.stdout.on('data', (chunk) => {
      lastActivityAt = new Date().toISOString();

      stdout.write(chunk);

      if (!stdoutOverflow) {
        decoder.push(chunk);
      }
    });

    provider.stderr.on('data', (chunk) => {
      lastActivityAt = new Date().toISOString();

      stderr.write(chunk);
    });

    for (const stream of [provider.stdout, provider.stderr]) {
      stream.on('close', () => {
        openStreams--;
        settle();
      });
    }

    provider.on('exit', (code, signal) => {
      providerExited = true;
      exitInfo = { code, signal };

      settle();

      // a descendant that inherited the pipes keeps them open, so stop the group and then stop waiting for the streams
      setTimeout(async () => {
        if (openStreams === 0) {
          return;
        }

        await terminateGroup(provider.pid, { graceMs: limits.terminateGraceMs });

        setTimeout(() => {
          if (openStreams > 0) {
            streamsAbandoned = true;

            provider.stdout.destroy();
            provider.stderr.destroy();
          }
        }, 2000).unref();
      }, 2000).unref();
    });

    // queue the whole prompt at once because a provider that starts reading early must not see an empty pipe
    provider.stdin.on('error', () => {});
    provider.stdin.end(fs.readFileSync(config.invocation.stdinFile));
  });

  faultPoint('after-provider-exit');

  const trailing = decoder.end();

  if (trailing !== null) {
    try {
      const events = adapter.parseEvent(JSON.parse(trailing));

      for (const event of events) {
        appendEvent(event);
      }
    } catch {
      protocolErrors++;
      appendEvent({ type: 'protocol-error', message: 'truncated final record' });
    }
  }

  stdout.close();
  stderr.close();

  // the leader is gone, so anything still in its group is an owned descendant
  let descendants = { present: false, stopped: true };

  if (providerStarted && groupExists(provider.pid)) {
    const result = await terminateGroup(provider.pid, { graceMs: limits.terminateGraceMs });

    descendants = { present: true, stopped: result.stopped };
  }

  writeExit({
    code: outcome.code,
    signal: outcome.signal,
    stdout: { bytes: stdout.bytes, truncated: stdout.truncated },
    stderr: { bytes: stderr.bytes, truncated: stderr.truncated },
    outputLimit: stdoutOverflow || stderrOverflow,
    descendants: { ...descendants, streamsAbandoned },
  });
}

const deadline = setTimeout(() => requestStop('deadline'), limits.deadlineMs);

const heartbeat = setInterval(() => {
  writeJsonAtomic(files.heartbeat, {
    nonce: config.nonce,
    at: new Date().toISOString(),
    providerRunning: providerStarted && !exitWritten,
    lastActivityAt,
  });
}, config.heartbeatMs ?? 2000);

let expiredSince = null;

const ownerWatch = config.owner
  ? setInterval(async () => {
      const status = await ownerStatus();

      switch (status) {
        case 'superseded': {
          requestStop('owner-lost');

          break;
        }
        case 'expired': {
          // use monotonic time, since a lease that stays expired while this host keeps running means a lost owner
          expiredSince ??= performance.now();

          if (performance.now() - expiredSince >= config.owner.confirmMs) {
            requestStop('owner-lost');
          }

          break;
        }
        case 'valid': {
          expiredSince = null;

          break;
        }
        default: {
          // an `unknown` state means the database was briefly unreadable, so nothing changes until the next check
          break;
        }
      }
    }, config.owner.checkIntervalMs)
  : null;

try {
  await main();
} catch (error) {
  spawnError ??= error.message;

  writeExit({ hostError: error.stack ?? error.message });
} finally {
  clearTimeout(deadline);
  clearInterval(heartbeat);

  if (ownerWatch) {
    clearInterval(ownerWatch);
  }

  ownerDb?.close();
}
