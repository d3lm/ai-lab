import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function writeJsonAtomic(file, value) {
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

export function writeFileAtomic(file, content) {
  const dir = path.dirname(file);
  const temporary = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(temporary, 'w', 0o644);

  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  fs.renameSync(temporary, file);
  fsyncDir(dir);
}

function fsyncDir(dir) {
  let fd;

  try {
    fd = fs.openSync(dir, 'r');

    fs.fsyncSync(fd);
  } catch {
    // some filesystems do not support directory fsync, but the rename is still atomic
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

// an unreadable or truncated file returns { invalid: reason } so callers never mistake a partial receipt for a good one
export function readJsonReceipt(file) {
  let text;

  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }

    return { invalid: `cannot read ${file}: ${error.message}` };
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    return { invalid: `malformed receipt ${file}: ${error.message}` };
  }
}

let cachedBootId = null;

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

// a boot id that either side does not know cannot rule a process out, so the process start time alone decides then
export function sameBoot(recorded, current) {
  return !recorded || recorded === 'unknown' || current === 'unknown' || recorded === current;
}

export function bootId() {
  if (cachedBootId) {
    return cachedBootId;
  }

  if (process.platform === 'linux') {
    try {
      cachedBootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    } catch {
      cachedBootId = 'unknown';
    }
  } else if (process.platform === 'darwin') {
    // kern.boottime moves when the calendar clock is adjusted, but the boot session uuid is fixed for the boot
    const result = spawnSync('sysctl', ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8' });
    const value = result.status === 0 ? result.stdout.trim() : '';

    cachedBootId = UUID.test(value) ? value.toLowerCase() : 'unknown';
  } else {
    cachedBootId = 'unknown';
  }

  return cachedBootId;
}

export function processStartTime(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');

      return fields[19] ?? null;
    } catch {
      return null;
    }
  }

  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
  });

  const value = result.status === 0 ? result.stdout.trim() : '';

  return value || null;
}

// a PID alone never authorizes a signal, so an identity adds the start time and boot id to recognize a reused PID
export function processIdentity(pid) {
  const startTime = processStartTime(pid);

  return startTime ? { pid, startTime, bootId: bootId() } : null;
}

export function checkIdentity(recorded) {
  if (!recorded?.pid || !recorded.startTime) {
    return 'unknown';
  }

  if (!sameBoot(recorded.bootId, bootId())) {
    return 'gone';
  }

  const current = processStartTime(recorded.pid);

  if (!current) {
    return 'gone';
  }

  return current === recorded.startTime ? 'alive' : 'reused';
}

// a group id cannot be reused while a member is alive, so this check is safe without a recorded identity
export function groupExists(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 1) {
    return false;
  }

  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export function signalGroup(pgid, signal) {
  if (!Number.isInteger(pgid) || pgid <= 1) {
    return false;
  }

  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

export function signalProcess(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

export async function terminateGroup(pgid, { graceMs, killWaitMs = 5000, pollMs = 50 }) {
  if (!groupExists(pgid)) {
    return { stopped: true, forced: false };
  }

  signalGroup(pgid, 'SIGTERM');

  if (await waitFor(() => !groupExists(pgid), graceMs, pollMs)) {
    return { stopped: true, forced: false };
  }

  signalGroup(pgid, 'SIGKILL');

  return { stopped: await waitFor(() => !groupExists(pgid), killWaitMs, pollMs), forced: true };
}

export async function waitFor(predicate, timeoutMs, pollMs = 50) {
  const deadline = performance.now() + timeoutMs;

  while (true) {
    if (await predicate()) {
      return true;
    }

    if (performance.now() >= deadline) {
      return false;
    }

    await delay(pollMs);
  }
}

// writes past the cap are dropped, not refused, so the caller keeps draining and the writer never blocks on a full pipe
export function cappedSink(file, maxBytes, onOverflow = () => {}) {
  const fd = fs.openSync(file, 'w', 0o644);

  let bytes = 0;
  let truncated = false;

  return {
    write(chunk) {
      if (truncated) {
        return;
      }

      const room = maxBytes - bytes;

      if (chunk.length > room) {
        fs.writeSync(fd, chunk.subarray(0, Math.max(room, 0)));

        bytes = maxBytes;
        truncated = true;

        onOverflow();
        return;
      }

      fs.writeSync(fd, chunk);

      bytes += chunk.length;
    },
    close() {
      fs.fsyncSync(fd);
      fs.closeSync(fd);
    },
    get bytes() {
      return bytes;
    },
    get truncated() {
      return truncated;
    },
  };
}

// lines are split on raw bytes and decoded whole, so a multibyte UTF-8 sequence split across chunks is never garbled
export function createLineDecoder({ maxRecordBytes, onRecord, onOversize = () => {} }) {
  let pending = [];
  let pendingBytes = 0;
  let discarding = false;

  const emit = (buffer) => {
    const line = buffer.toString('utf8').replace(/\r$/, '');

    if (line.length > 0) {
      onRecord(line);
    }
  };

  return {
    push(chunk) {
      let start = 0;

      while (start < chunk.length) {
        const newline = chunk.indexOf(0x0a, start);
        const end = newline === -1 ? chunk.length : newline;
        const piece = chunk.subarray(start, end);

        if (!discarding) {
          if (pendingBytes + piece.length > maxRecordBytes) {
            discarding = true;

            onOversize(pendingBytes + piece.length);

            pending = [];
            pendingBytes = 0;
          } else if (piece.length > 0) {
            pending.push(piece);

            pendingBytes += piece.length;
          }
        }

        if (newline === -1) {
          break;
        }

        if (!discarding) {
          emit(Buffer.concat(pending));
        }

        pending = [];
        pendingBytes = 0;
        discarding = false;
        start = newline + 1;
      }
    },

    end() {
      const rest = discarding || pendingBytes === 0 ? null : Buffer.concat(pending).toString('utf8');

      pending = [];
      pendingBytes = 0;

      return rest;
    },
  };
}

export function readJsonLines(file, { maxBytes = 256 * 1024 * 1024 } = {}) {
  let text;

  try {
    const stat = fs.statSync(file);

    if (stat.size > maxBytes) {
      return { records: [], invalid: 0, error: `${file} exceeds ${maxBytes} bytes` };
    }

    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return { records: [], invalid: 0, error: error.code === 'ENOENT' ? null : error.message };
  }

  const records = [];

  let invalid = 0;

  for (const line of text.split('\n')) {
    if (!line.trim()) {
      continue;
    }

    try {
      records.push(JSON.parse(line));
    } catch {
      invalid++;
    }
  }

  return { records, invalid, error: null };
}

/**
 * The child gets its own process group so that the whole group can be terminated on timeout or
 * abort and descendants do not outlive the command. `onSpawn(pid)` runs synchronously once the
 * child exists, so callers can record it durably before it does any work.
 */
export function runBounded(
  argv,
  {
    cwd,
    env,
    input = null,
    timeoutMs,
    maxOutputBytes,
    logFile = null,
    graceMs = 5000,
    capture = false,
    signal: abortSignal = null,
    onSpawn = null,
  },
) {
  return new Promise((resolve) => {
    const started = performance.now();
    const streams = { stdout: [], stderr: [] };

    let capturedBytes = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let recent = '';
    let sink = null;
    let child;
    let timer;

    const finish = (result) => {
      if (settled) {
        return;
      }

      settled = true;
      sink?.close();
      abortSignal?.removeEventListener('abort', onAbort);

      resolve({
        ...result,
        timedOut,
        aborted,
        truncated: truncated || Boolean(sink?.truncated),
        durationMs: Math.round(performance.now() - started),
        tail: recent.slice(-6000),
        ...(capture
          ? {
              stdout: Buffer.concat(streams.stdout).toString('utf8'),
              stderr: Buffer.concat(streams.stderr).toString('utf8'),
            }
          : {}),
      });
    };

    function onAbort() {
      if (aborted || settled || !child?.pid) {
        return;
      }

      aborted = true;

      clearTimeout(timer);
      void terminateGroup(child.pid, { graceMs }).then(abandonStreams);
    }

    if (abortSignal?.aborted) {
      aborted = true;

      finish({ code: null, signal: null, spawnError: null });
      return;
    }

    sink = logFile ? cappedSink(logFile, maxOutputBytes) : null;

    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env: env ?? process.env,
        detached: true,
        stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({ code: null, signal: null, spawnError: error.message });
      return;
    }

    if (onSpawn && child.pid) {
      try {
        onSpawn(child.pid);
      } catch (error) {
        // a child that cannot be recorded must not keep running unrecorded
        signalGroup(child.pid, 'SIGKILL');
        finish({ code: null, signal: null, spawnError: `cannot record process ${child.pid}: ${error.message}` });
        return;
      }
    }

    const collect = (name) => (chunk) => {
      sink?.write(chunk);
      recent = (recent + chunk.toString('utf8')).slice(-12_000);

      if (!capture) {
        return;
      }

      if (capturedBytes < maxOutputBytes) {
        const slice = chunk.subarray(0, maxOutputBytes - capturedBytes);

        streams[name].push(slice);

        capturedBytes += slice.length;
      }

      if (capturedBytes >= maxOutputBytes) {
        truncated = true;
      }
    };

    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    child.on('error', (error) => finish({ code: null, signal: null, spawnError: error.message }));

    if (input !== null) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }

    let exitInfo = null;

    // a process that escaped the group can hold the pipes open, so stop waiting for them once the leader is gone
    const abandonStreams = () =>
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish({ ...(exitInfo ?? { code: null, signal: null }), spawnError: null, streamsAbandoned: true });
      }, 2000).unref();

    timer = setTimeout(async () => {
      timedOut = true;

      await terminateGroup(child.pid, { graceMs });
      abandonStreams();
    }, timeoutMs);

    abortSignal?.addEventListener('abort', onAbort, { once: true });

    let cleanup = Promise.resolve();

    child.on('exit', (code, signal) => {
      exitInfo = { code, signal };

      clearTimeout(timer);

      // the leader exited, so stop any descendants it left in its group and then stop waiting for held pipes
      cleanup = (async () => {
        if (groupExists(child.pid)) {
          await terminateGroup(child.pid, { graceMs: Math.min(graceMs, 2000) });
        }
      })();

      void cleanup.then(abandonStreams);
    });

    child.on('close', async (code, signal) => {
      clearTimeout(timer);
      await cleanup;
      finish({ code: exitInfo?.code ?? code, signal: exitInfo?.signal ?? signal, spawnError: null });
    });
  });
}

export function runSync(argv, { cwd, env, input, maxBuffer = 256 * 1024 * 1024, timeoutMs = 120_000 } = {}) {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd,
    env: env ?? process.env,
    input,
    encoding: 'utf8',
    maxBuffer,
    timeout: timeoutMs,
  });

  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.error ? result.error.message : (result.stderr ?? ''),
  };
}

/**
 * Injects a fault for tests. When ORCHESTRATOR_FAULT names this point, the process kills itself
 * with SIGKILL so recovery can be tested at every gap between a receipt and a database write.
 * A value of the form `point:SIGNAL` sends that signal instead, which shows what a signal from
 * another process does when it arrives at this point.
 */
export function faultPoint(name) {
  const [point, signal = 'SIGKILL'] = (process.env.ORCHESTRATOR_FAULT ?? '').split(':');

  if (point === name) {
    process.kill(process.pid, signal);
  }
}

export function hostInfo() {
  return { hostname: os.hostname(), platform: process.platform, bootId: bootId() };
}
