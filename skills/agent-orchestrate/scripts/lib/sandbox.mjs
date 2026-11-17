import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runBounded } from './process.mjs';

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

function realOrSelf(dir) {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

// macOS keeps per-user temporary and cache directories side by side under /var/folders/<x>/<y>/{T,C}
function temporaryRoots() {
  const temporary = realOrSelf(os.tmpdir());
  const roots = [temporary];

  if (process.platform === 'darwin') {
    roots.push('/private/tmp');

    if (path.basename(temporary) === 'T' && temporary.startsWith('/private/var/folders/')) {
      roots.push(path.dirname(temporary));
    }
  } else {
    roots.push('/tmp', '/var/tmp');
  }

  return [...new Set(roots)];
}

function sbplString(value) {
  return `"${value.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`;
}

/**
 * Besides file writes, the profile closes the ordinary ways to ask a service outside the
 * sandbox to start a process (LaunchServices, Apple Events, launchctl, open, osascript).
 * It limits what ordinary code can do and is not a boundary against code that sets out to
 * escape through other system services.
 */
export function macosProfile(writable) {
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* (subpath "/dev") ${writable.map((dir) => `(subpath ${sbplString(dir)})`).join(' ')})`,
    '(deny appleevent-send)',
    '(deny lsopen)',
    String.raw`(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd") (global-name-regex #"^com\.apple\.lsd\."))`,
    '(deny process-exec (literal "/bin/launchctl") (literal "/usr/bin/open") (literal "/usr/bin/osascript"))',
  ].join('\n');
}

// the user bus and the systemd user manager can start host processes on request, so their sockets are hidden
function linuxServiceMasks() {
  const masks = [];
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;

  for (const dir of [uid === null ? null : `/run/user/${uid}`, '/run/dbus', '/var/run/dbus']) {
    if (dir && fs.existsSync(dir)) {
      masks.push('--tmpfs', dir);
    }
  }

  return [...masks, '--unsetenv', 'DBUS_SESSION_BUS_ADDRESS', '--unsetenv', 'DBUS_SYSTEM_BUS_ADDRESS'];
}

function createConfiguredRoots(config) {
  const configured = config.writableRoots ?? [];

  for (const dir of configured) {
    fs.mkdirSync(dir, { recursive: true });
  }

  return configured;
}

/**
 * Returns the argument prefix that confines a command to `cwd` (when `cwdWritable`), the temporary
 * directories (when `temporary`), the configured writable roots, and `writable`, or an empty prefix
 * when the manifest set `checkSandbox.mode` to "none". Configured roots that do not exist yet are
 * created, so a first run can fill a new cache. Throws when the platform has no supported sandbox,
 * so a command never silently runs unconfined.
 */
export function sandboxPrefix(config, { cwd, cwdWritable = true, temporary = true, writable: extra = [] }) {
  if (!config || config.mode === 'none') {
    return [];
  }

  const configured = createConfiguredRoots(config);

  const writable = [
    ...new Set([
      ...(cwdWritable ? [realOrSelf(cwd)] : []),
      ...(temporary ? temporaryRoots() : []),
      ...configured.map((dir) => realOrSelf(dir)),
      ...extra.map((dir) => realOrSelf(dir)),
    ]),
  ];

  if (process.platform === 'darwin') {
    return [SANDBOX_EXEC, '-p', macosProfile(writable)];
  }

  if (process.platform === 'linux') {
    return linuxPrefix(writable);
  }

  throw new Error(`no check sandbox is available on ${process.platform}`);
}

// writable binds come after the service masks, so a writable root inside a masked directory stays reachable
export function linuxPrefix(writable) {
  const binds = writable.flatMap((dir) => (fs.existsSync(dir) ? ['--bind', dir, dir] : []));

  return [
    'bwrap',
    '--die-with-parent',
    '--ro-bind',
    '/',
    '/',
    '--dev-bind',
    '/dev',
    '/dev',
    ...linuxServiceMasks(),
    ...binds,
    '--',
  ];
}

/**
 * Confirms that the sandbox starts and that it actually refuses a write outside the allowed roots.
 * A sandbox that cannot start (for example because the runner already runs inside another sandbox)
 * is reported, never bypassed.
 *
 * The probe allows writes to its own directory only, without the temporary directories or the
 * configured roots, so the write it expects to be refused is refused wherever those directories
 * lie. The configured roots are still created here, so a root that cannot exist is reported
 * before any check needs it.
 */
export async function probeSandbox(config) {
  if (!config || config.mode === 'none') {
    return { ok: true, problems: [] };
  }

  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-sandbox-probe-'));
  const inside = path.join(probeRoot, 'inside');
  const outside = path.join(probeRoot, 'outside.txt');

  fs.mkdirSync(inside);

  try {
    let prefix;

    try {
      createConfiguredRoots(config);

      prefix = sandboxPrefix({ mode: config.mode, writableRoots: [] }, { cwd: inside, temporary: false });
    } catch (error) {
      return { ok: false, problems: [error.message] };
    }

    const script = `echo ok > ${JSON.stringify(path.join(inside, 'ok.txt'))} && { echo escaped > ${JSON.stringify(outside)}; } 2>/dev/null; exit 0`;

    const result = await runBounded([...prefix, '/bin/sh', '-c', script], {
      cwd: inside,
      timeoutMs: 15_000,
      maxOutputBytes: 64 * 1024,
      capture: true,
    });

    if (result.code !== 0 || !fs.existsSync(path.join(inside, 'ok.txt'))) {
      const detail = (result.spawnError ?? result.stderr ?? '').trim().split('\n')[0];

      return {
        ok: false,
        problems: [`the check sandbox (${prefix[0]}) did not start: ${detail || `exit ${result.code}`}`],
      };
    }

    if (fs.existsSync(outside)) {
      return { ok: false, problems: [`the check sandbox (${prefix[0]}) allowed a write outside the workspace`] };
    }

    return { ok: true, problems: [] };
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
}

export function sandboxUnavailableHint() {
  return 'set "checkSandbox": {"mode": "none"} only when the whole run already executes inside an external sandbox or container, because checks then run worker-written code with your privileges';
}
