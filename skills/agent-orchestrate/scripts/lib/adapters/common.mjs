import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OrchestratorError } from '../contracts.mjs';
import { runBounded } from '../process.mjs';

const PROBE_TIMEOUT_MS = 30_000;
const DLX_TIMEOUT_MS = 180_000;

export function splitCommand(text) {
  return text.split(/\s+/).filter(Boolean);
}

function pathCandidates(binary, envPath) {
  const seen = new Set();
  const candidates = [];

  const directories = (envPath ?? '').split(path.delimiter);

  for (const dir of directories) {
    if (!dir) {
      continue;
    }

    const file = path.join(dir, binary);

    try {
      fs.accessSync(file, fs.constants.X_OK);
    } catch {
      continue;
    }

    let real;

    try {
      real = fs.realpathSync(file);
    } catch {
      continue;
    }

    if (!seen.has(real)) {
      seen.add(real);
      candidates.push(file);
    }
  }

  return candidates;
}

export async function probeVersion(argv, versionArgs, { env = process.env, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const result = await runBounded([...argv, ...versionArgs], {
    cwd: os.tmpdir(),
    env,
    timeoutMs,
    maxOutputBytes: 64 * 1024,
    capture: true,
  });

  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  const match = output.match(/\b(\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.-]+)?)\b/);

  return { ok: result.code === 0 && Boolean(match), version: match?.[1] ?? null, output: output.slice(-2000) };
}

/**
 * The `pnpm dlx` fallback is installed during preflight so dispatch never resolves
 * an unpinned package.
 *
 * `accept(argv)` lets the caller skip a candidate that runs but cannot apply the
 * profile (for example an older binary earlier on PATH that lacks a required flag).
 * Explicit choices (profile executable, env override) are never replaced.
 */
export async function resolveExecutable(adapter, { profileExecutable = null, env = process.env, accept = null } = {}) {
  const rejected = [];

  const attempt = async (argv, source) => {
    const probe = await probeVersion(argv, adapter.versionArgs, {
      env,
      timeoutMs: source === 'pnpm-dlx' ? DLX_TIMEOUT_MS : PROBE_TIMEOUT_MS,
    });

    if (!probe.ok) {
      rejected.push({ candidate: argv.join(' '), reason: probe.output.split('\n').at(-1) || 'no version output' });
      return null;
    }

    if (accept) {
      const verdict = await accept(argv);

      if (!verdict.ok) {
        rejected.push({ candidate: `${argv.join(' ')} (${probe.version})`, reason: verdict.problems.join('; ') });
        return null;
      }
    }

    return { argv, version: probe.version, source, rejected };
  };

  if (profileExecutable) {
    const found = await attempt(profileExecutable, 'profile');

    if (found) {
      return found;
    }

    throw resolutionError(adapter, rejected);
  }

  if (env[adapter.envVar]) {
    const found = await attempt(splitCommand(env[adapter.envVar]), `env:${adapter.envVar}`);

    if (found) {
      return found;
    }

    throw resolutionError(adapter, rejected);
  }

  for (const candidate of pathCandidates(adapter.binary, env.PATH)) {
    const found = await attempt([candidate], 'path');

    if (found) {
      return found;
    }
  }

  const pnpm = pathCandidates('pnpm', env.PATH)[0];

  if (pnpm && adapter.package) {
    const unpinned = await probeVersion([pnpm, 'dlx', adapter.package], adapter.versionArgs, {
      env,
      timeoutMs: DLX_TIMEOUT_MS,
    });

    if (unpinned.ok) {
      const found = await attempt([pnpm, 'dlx', `${adapter.package}@${unpinned.version}`], 'pnpm-dlx');

      if (found) {
        return found;
      }
    } else {
      rejected.push({
        candidate: `${pnpm} dlx ${adapter.package}`,
        reason: unpinned.output.split('\n').at(-1) || 'failed',
      });
    }
  }

  throw resolutionError(adapter, rejected);
}

function resolutionError(adapter, rejected) {
  const detail =
    rejected.length > 0
      ? rejected.map((item) => `  ${item.candidate}: ${item.reason}`).join('\n')
      : '  (no candidates found)';

  return new OrchestratorError(
    'launch',
    `cannot resolve a working ${adapter.binary} executable. Tried:\n${detail}\nSet ${adapter.envVar} to a working command or install ${adapter.installHint ?? adapter.package}.`,
    { rejected },
  );
}

// the CLI parses every flag and then stops for lack of a prompt, so a parse error means it cannot apply the profile
export async function dryRunArguments(argv, { cwd, env = process.env, expect }) {
  const result = await runBounded(argv, {
    cwd,
    env,
    input: '',
    timeoutMs: PROBE_TIMEOUT_MS,
    maxOutputBytes: 64 * 1024,
    capture: true,
  });

  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();

  // the error usually leads and launcher noise (such as pnpm dlx progress) trails, so long output keeps both ends
  const kept = output.length > 2000 ? `${output.slice(0, 1000)}\n…\n${output.slice(-1000)}` : output;

  return { ok: expect.test(output), output: kept };
}

const AUTH =
  /unauthori[sz]ed|\b401\b|\b403\b|invalid api key|not logged in|please run \/login|log ?in again|authenticat|forbidden|credential/i;

const BUDGET = /budget|max[_ -]?turns|quota|usage limit|spending limit|credit balance/i;

const TRANSIENT =
  /rate.?limit|\b429\b|overloaded|\b5\d\d\b|timed? ?out|econnreset|enotfound|eai_again|network|disconnected|stream error|temporar|unavailable/i;

export function classifyMessage(text, fallback = 'transient') {
  if (AUTH.test(text)) {
    return 'auth';
  }

  if (BUDGET.test(text)) {
    return 'budget';
  }

  if (TRANSIENT.test(text)) {
    return 'transient';
  }

  return fallback;
}

export function truncate(text, max = 300) {
  if (typeof text !== 'string') {
    return '';
  }

  return text.length > max ? `${text.slice(0, max)}…` : text;
}
