#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs as parseCliArgs } from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_LIB = path.resolve(HERE, '..', '..', 'agent-orchestrate', 'scripts', 'lib');
const RUNNER = path.join(RUNNER_LIB, 'index.mjs');
const SANDBOX = path.join(RUNNER_LIB, 'sandbox.mjs');

const DEFAULTS = {
  cwd: process.cwd(),
  maxTurns: 6,
  disputeAfter: 3,
  codexModel: 'gpt-6-astra',
  codexEffort: 'xhigh',
  claudeModel: 'claude-opus-5-5[1m]',
  claudeEffort: 'high',
  claudeBudget: 15,
  checkSandbox: 'os',
  runDir: null,
};

const EXIT_USAGE = 64;
const EXIT_INTERNAL = 70;

// user or repository git configuration must not run programs or change the patch format
const GIT_CONFIG = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

const DIFF_FLAGS = [
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--no-relative',
  '--src-prefix=a/',
  '--dst-prefix=b/',
];

// lockfiles are excluded from the reviewed diff because they are generated, not authored
const LOCKFILES = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  'uv.lock',
  'Gemfile.lock',
  'composer.lock',
  'go.sum',
];

const LOCKFILE_PATHSPECS = LOCKFILES.map((name) => `:(exclude,glob)**/${name}`);

// diffs larger than this are not embedded in prompts, the workers read the snapshot file instead
const MAX_EMBEDDED_DIFF_CHARS = 200_000;
const MAX_CHECK_OUTPUT_CHARS = 6000;
const MAX_BUFFER = 256 * 1024 * 1024;

const USAGE = `
Usage: node review-code.mjs [options]
       node review-code.mjs --resume <run-dir> [--accept-partial-turn]

Reviews the code change in a git repo: every file that differs between the merge-base of --base and the
working tree, including untracked files. Codex reviews, claude fixes, repeated until codex approves.

Options:
  --cwd DIR             Repository (default: current directory)
  --base REF            Base ref the change is compared against (default: origin/HEAD, then main, then master)
  --goal TEXT|FILE      What the change is meant to do, read from the file when TEXT is a path (default: inferred from diff and commits)
  --check CMD           Verification command run after every claude turn, e.g. "pnpm test" (default: none)
  --check-writable DIR  Extra directory the sandboxed check may write to, e.g. a test cache (repeatable)
  --check-sandbox MODE  Where the check runs. os (default) confines it to the repo and temp dirs, and none belongs only inside an external sandbox
  --max-turns N         Codex review rounds before stopping (default: ${DEFAULTS.maxTurns})
  --dispute-after N     Claude rejections of one finding before it is escalated (default: ${DEFAULTS.disputeAfter})
  --codex-model M       (default: ${DEFAULTS.codexModel})
  --codex-effort E      (default: ${DEFAULTS.codexEffort})
  --claude-model M      (default: ${DEFAULTS.claudeModel})
  --claude-effort E     (default: ${DEFAULTS.claudeEffort})
  --claude-budget USD   Max spend per claude turn (default: ${DEFAULTS.claudeBudget})
  --run-dir DIR         (default: $ORCHESTRATOR_HOME or ~/.orchestrator, then <timestamp>-code-review-<branch>)
  --resume DIR          Continue a failed or interrupted run from its last completed turn, reusing the run's options
  --accept-partial-turn With --resume, rerun a turn that ended uncertain, or a claude turn interrupted mid-edit

Env:
  CLAUDE_CMD, CODEX_CMD   Override the CLI commands (default: a working claude/codex on PATH, else a pinned pnpm dlx)

Exit codes: 0 approved, 2 max turns reached, 3 stalemate (all remaining findings disputed), 1 failure,
            ${EXIT_USAGE} usage or configuration error (nothing ran), ${EXIT_INTERNAL} internal error.
`.trim();

function parseArgs(argv) {
  let values;

  try {
    ({ values } = parseCliArgs({
      args: argv,
      allowPositionals: false,
      options: {
        help: { type: 'boolean', short: 'h' },
        cwd: { type: 'string', default: DEFAULTS.cwd },
        base: { type: 'string' },
        goal: { type: 'string' },
        check: { type: 'string' },
        'check-writable': { type: 'string', multiple: true, default: [] },
        'check-sandbox': { type: 'string', default: DEFAULTS.checkSandbox },
        'max-turns': { type: 'string', default: String(DEFAULTS.maxTurns) },
        'dispute-after': {
          type: 'string',
          default: String(DEFAULTS.disputeAfter),
        },
        'codex-model': { type: 'string', default: DEFAULTS.codexModel },
        'codex-effort': { type: 'string', default: DEFAULTS.codexEffort },
        'claude-model': { type: 'string', default: DEFAULTS.claudeModel },
        'claude-effort': { type: 'string', default: DEFAULTS.claudeEffort },
        'claude-budget': {
          type: 'string',
          default: String(DEFAULTS.claudeBudget),
        },
        'run-dir': { type: 'string' },
        resume: { type: 'string' },
        'accept-partial-turn': { type: 'boolean', default: false },
      },
    }));
  } catch (error) {
    fail(error.message);
  }

  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }

  if (values.resume) {
    return { resume: path.resolve(values.resume), acceptPartialTurn: values['accept-partial-turn'] };
  }

  const positiveInt = (name) => {
    const value = Number(values[name]);

    if (!Number.isInteger(value) || value < 1) {
      fail(`--${name} must be a positive integer`);
    }

    return value;
  };

  const budget = Number(values['claude-budget']);

  if (!(budget > 0)) {
    fail('--claude-budget must be a positive number');
  }

  if (!['os', 'none'].includes(values['check-sandbox'])) {
    fail('--check-sandbox must be os or none');
  }

  const options = {
    cwd: path.resolve(values.cwd),
    base: values.base ?? null,
    goal: values.goal ?? null,
    check: values.check?.trim() || null,
    checkWritable: values['check-writable'].map((dir) => path.resolve(dir)),
    checkSandbox: values['check-sandbox'],
    maxTurns: positiveInt('max-turns'),
    disputeAfter: positiveInt('dispute-after'),
    codexModel: values['codex-model'],
    codexEffort: values['codex-effort'],
    claudeModel: values['claude-model'],
    claudeEffort: values['claude-effort'],
    claudeBudget: budget,
    runDir: values['run-dir'] ?? null,
  };

  if (!fs.existsSync(options.cwd) || !fs.statSync(options.cwd).isDirectory()) {
    fail(`--cwd is not a directory: ${options.cwd}`);
  }

  if (options.goal) {
    const goalPath = path.resolve(options.goal);

    if (fs.existsSync(goalPath) && fs.statSync(goalPath).isFile()) {
      options.goal = fs.readFileSync(goalPath, 'utf8').trim();
    }
  }

  return options;
}

function fail(message) {
  console.error(`error: ${message}\n\n${USAGE}`);
  process.exit(EXIT_USAGE);
}

const log = (message) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${message}`);

/**
 * The shared runner lives in the agent-orchestrate skill next to this one.
 */
async function loadRunner() {
  let runner;
  let sandbox;

  try {
    [runner, sandbox] = await Promise.all([import(pathToFileURL(RUNNER).href), import(pathToFileURL(SANDBOX).href)]);
  } catch (error) {
    console.error(
      `error: review-code.mjs needs the agent-orchestrate skill at ${path.dirname(path.dirname(RUNNER_LIB))}.\n${error.message}`,
    );

    process.exit(EXIT_USAGE);
  }

  return { ...runner, sandbox };
}

function template(name, variables) {
  let text = fs.readFileSync(path.join(HERE, 'prompts', name), 'utf8');

  for (const [key, value] of Object.entries(variables)) {
    text = text.replaceAll(`{{${key}}}`, value);
  }

  return text;
}

function git(cwd, args) {
  const result = spawnSync('git', [...GIT_CONFIG, ...args], { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER });

  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function gitLines(cwd, args) {
  return git(cwd, args).stdout.split('\n').filter(Boolean);
}

function resolveBase(cwd, requested) {
  const verify = (ref) => git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).ok;

  if (requested) {
    if (!verify(requested)) {
      fail(`--base is not a commit: ${requested}`);
    }

    return requested;
  }

  const originHead = git(cwd, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']).stdout.trim();

  if (originHead) {
    return originHead.replace(/^refs\/remotes\//, '');
  }

  const fallback = ['main', 'master'].find((ref) => verify(ref));

  if (!fallback) {
    fail('cannot determine the base branch; pass --base');
  }

  return fallback;
}

/**
 * The reviewed change is everything that differs between the merge-base and the working
 * tree. Untracked files count as added, and their patch is produced with --no-index
 * (exit 1 means "differs", not failure).
 */
function snapshot(cwd, mergeBase) {
  const tracked = gitLines(cwd, ['diff', '--name-only', mergeBase, '--', '.', ...LOCKFILE_PATHSPECS]);
  const untracked = gitLines(cwd, ['ls-files', '--others', '--exclude-standard', '--', '.', ...LOCKFILE_PATHSPECS]);

  let patch = git(cwd, ['diff', ...DIFF_FLAGS, mergeBase, '--', '.', ...LOCKFILE_PATHSPECS]).stdout;

  for (const file of untracked) {
    patch += git(cwd, ['diff', ...DIFF_FLAGS, '--no-index', '--', '/dev/null', file]).stdout;
  }

  return {
    files: [...new Set([...tracked, ...untracked])].toSorted((a, b) => a.localeCompare(b)),
    untracked,
    patch,
  };
}

/**
 * Returns the argument prefix that confines the check command, after confirming that the
 * sandbox starts and refuses a write outside its roots. Throws instead of falling back to
 * an unconfined check.
 */
async function checkSandboxPrefix(options, runner) {
  if (!options.check) {
    return [];
  }

  const config = {
    mode: options.checkSandbox ?? DEFAULTS.checkSandbox,
    writableRoots: options.checkWritable ?? [],
  };

  const probe = await runner.sandbox.probeSandbox(config);

  if (!probe.ok) {
    throw new runner.OrchestratorError(
      'launch',
      `${probe.problems.join('\n')}\nPass --check-sandbox none only when this script already runs inside an external sandbox or container.`,
    );
  }

  return runner.sandbox.sandboxPrefix(config, { cwd: options.cwd });
}

/**
 * Runs the check asynchronously, so the run's lease keeps renewing while a long test suite runs.
 * Output keeps the original order: stdout, then stderr.
 */
function runCheck(cwd, command, sandboxPrefix, logFile) {
  const started = Date.now();
  const [executable, ...args] = [...sandboxPrefix, 'sh', '-c', command];

  return new Promise((resolve) => {
    const child = spawn(executable, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];

    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));

    const settle = (status) => {
      const output = `${Buffer.concat(out).toString('utf8')}${Buffer.concat(err).toString('utf8')}`.trim();

      fs.writeFileSync(logFile, output + '\n');

      resolve({
        ok: status === 0,
        status,
        tail: output.slice(-MAX_CHECK_OUTPUT_CHARS),
        durationMs: Date.now() - started,
      });
    };

    child.on('error', () => settle(null));
    child.on('close', (status) => settle(status));
  });
}

function describeCheck(command, check) {
  if (!command) {
    return 'No check command is configured, so verify correctness by reading the code.';
  }

  if (check.ok) {
    return `Check command \`${command}\` passes.`;
  }

  return `Check command \`${command}\` FAILS (exit ${check.status}). Output tail:\n\n\`\`\`\n${check.tail}\n\`\`\``;
}

function describeDiff(patch, patchFile) {
  if (patch.length <= MAX_EMBEDDED_DIFF_CHARS) {
    return patch;
  }

  return `(diff is ${patch.length} characters, too large to embed, so read it from ${patchFile})`;
}

function formatList(items, empty = 'none') {
  return items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : empty;
}

function profiles(options, runDir) {
  const tools = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'WebFetch'];

  // acceptEdits approves edits inside the working directories, so Edit and Write need no allow rule
  const allowedTools = ['Read', 'Glob', 'Grep', 'WebFetch'];

  // claude may run exactly the configured check command and nothing else in the shell
  if (options.check) {
    tools.push('Bash');
    allowedTools.push(`Bash(${options.check})`);
  }

  return {
    codex: {
      adapter: 'codex-cli',
      model: options.codexModel,
      effort: options.codexEffort,
      sandbox: 'read-only',
    },
    claude: {
      adapter: 'claude-cli',
      model: options.claudeModel,
      effort: options.claudeEffort,
      permissionMode: 'acceptEdits',
      permissionPrompts: 'none',
      bashSandbox: true,
      tools,
      allowedTools,
      maxBudgetUsd: options.claudeBudget,
      addDirs: [runDir],
    },
  };
}

function codexFailure(turn, result) {
  const { files } = result;
  const detail = result.providerMessage ?? result.failure.message;

  if (
    result.providerOutcome === 'success' &&
    /^(malformed final message|final message file missing)/.test(detail ?? '')
  ) {
    return `codex turn ${turn}: malformed envelope in ${files.lastMessage}: ${detail.replace(/^[^:]+: /, '')}`;
  }

  if (result.providerOutcome === 'success' && result.failure.class === 'protocol') {
    const envelope = result.providerPayload;

    if (!Array.isArray(envelope?.findings) || !['approve', 'revise'].includes(envelope?.verdict)) {
      return `codex turn ${turn}: envelope missing verdict/findings; see ${files.lastMessage}`;
    }

    return `codex turn ${turn}: envelope does not match codex-review.schema.json (${result.failure.message}); see ${files.lastMessage}`;
  }

  const failed = result.diagnostics?.failedEvent;

  const reason =
    result.exit?.terminalReason && result.exit.terminalReason !== 'exited' ? `, ${result.failure.message}` : '';

  return `codex turn ${turn} failed (exit ${result.exit?.code ?? 'none'}${failed ? `, ${JSON.stringify(failed)}` : ''}${reason}); see ${files.stderr}`;
}

function claudeFailure(turn, result) {
  const { files } = result;

  if (!result.providerOutcome) {
    return `claude turn ${turn} failed (${result.failure.message}); see ${files.stderr}`;
  }

  if (result.providerOutcome === 'missing') {
    return `claude turn ${turn} failed (exit ${result.exit?.code ?? 'none'}); no JSON result in ${files.stdout}, see ${files.stderr}`;
  }

  if (result.providerOutcome === 'failure' || (result.exit && (result.exit.code !== 0 || result.exit.signal))) {
    return `claude turn ${turn} failed (exit ${result.exit?.code ?? 'none'}, subtype ${result.diagnostics?.subtype}); see ${files.stdout}`;
  }

  if (result.providerOutcome === 'success') {
    const envelope = result.providerPayload;

    if (!Array.isArray(envelope?.addressed) || !Array.isArray(envelope?.rejected)) {
      return `claude turn ${turn}: envelope missing addressed/rejected; see ${files.stdout}`;
    }

    return `claude turn ${turn}: envelope does not match claude-address.schema.json (${result.failure.message}); see ${files.stdout}`;
  }

  return `claude turn ${turn} failed (${result.failure.message}); see ${files.stderr}`;
}

async function codexTurn(state, turn, prompt) {
  const dir = path.join(state.runDir, 'codex', 'review');

  const result = await state.wf.runTurn({
    step: `codex-review-${turn}`,
    session: 'codex',
    profile: state.profiles.codex,
    promptText: prompt,
    schemaFile: path.join(HERE, 'codex-review.schema.json'),
    files: {
      prompt: path.join(dir, `prompt-${turn}.md`),
      stdout: path.join(dir, `out-${turn}.jsonl`),
      lastMessage: path.join(dir, `last-${turn}.json`),
      stderr: path.join(dir, `err-${turn}.log`),
    },
    cwd: state.opts.cwd,
    isGitRepo: true,
    readOnly: true,
    acceptUncertain: state.acceptUncertain === true,
  });

  if (result.sessionId) {
    state.codexThreadId = result.sessionId;
  }

  if (!result.ok) {
    throw new Error(codexFailure(turn, result));
  }

  return {
    taskId: result.taskId,
    replayed: result.replayed,
    record: { envelope: result.payload, usage: result.usage, durationMs: result.durationMs },
  };
}

async function claudeTurn(state, turn, prompt) {
  const dir = path.join(state.runDir, 'claude', 'address');

  const result = await state.wf.runTurn({
    step: `claude-address-${turn}`,
    session: 'claude',
    sessionDisplayName: `code-review/${state.runId}`,
    profile: state.profiles.claude,
    promptText: prompt,
    schemaFile: path.join(HERE, 'claude-address.schema.json'),
    files: {
      prompt: path.join(dir, `prompt-${turn}.md`),
      stdout: path.join(dir, `out-${turn}.json`),
      stderr: path.join(dir, `err-${turn}.log`),
    },
    cwd: state.opts.cwd,
    readOnly: false,
    acceptUncertain: state.acceptUncertain === true,
  });

  if (result.sessionId) {
    state.claudeSessionId = result.sessionId;
  }

  if (!result.ok) {
    throw new Error(claudeFailure(turn, result));
  }

  return {
    taskId: result.taskId,
    replayed: result.replayed,
    record: {
      envelope: result.payload,
      costUsd: result.costUsd,
      numTurns: result.numTurns,
      permissionDenials: result.permissionDenials,
      durationMs: result.durationMs,
    },
  };
}

function fmtUsage(usage) {
  if (!usage) {
    return '';
  }

  return `${usage.input_tokens ?? 0} in (${usage.cached_input_tokens ?? 0} cached), ${usage.output_tokens ?? 0} out`;
}

function renderEvidence(evidence, indent) {
  return evidence.map((item) => `${indent}- (${item.basis}) \`${item.ref}\` ${item.shows}`).join('\n');
}

function renderFinding(finding) {
  return [
    `- **${finding.id}** (${finding.severity}, ${finding.category}) ${finding.location}: ${finding.issue}`,
    '  Evidence:',
    renderEvidence(finding.evidence, '  '),
    `  Fix: ${finding.fix}`,
  ].join('\n');
}

function renderDispute(dispute) {
  const rejections = dispute.rejected.map((rejection, index) =>
    [`  ${index + 1}. ${rejection.reason}`, renderEvidence(rejection.evidence, '     ')].join('\n'),
  );

  return [renderFinding(dispute.finding), '  Claude rejections:', ...rejections].join('\n');
}

function fmtCheck(check) {
  if (!check) {
    return '';
  }

  return check.ok ? 'pass' : `FAIL (${check.status})`;
}

// fields of the in-memory state that are runtime handles, not part of the report or checkpoint
const RUNTIME_FIELDS = new Set(['wf', 'profiles', 'acceptUncertain', 'checkPrefix']);

const persistable = (state) => Object.fromEntries(Object.entries(state).filter(([key]) => !RUNTIME_FIELDS.has(key)));

function writeReport(state) {
  const { opts } = state;

  const lines = [
    `# Code review ${state.runId}`,
    '',
    `- Repository: \`${opts.cwd}\` (branch \`${state.branch}\`, base \`${state.base}\` @ \`${state.mergeBase.slice(0, 10)}\`)`,
    `- Goal: ${opts.goal ? opts.goal.split('\n')[0] : '(inferred from diff and commits)'}`,
    `- Check: ${opts.check ? `\`${opts.check}\` (baseline ${fmtCheck(state.baselineCheck)})` : 'none'}`,
    `- Reviewer: codex \`${opts.codexModel}\` (${opts.codexEffort}), thread \`${state.codexThreadId ?? '-'}\``,
    `- Author: claude \`${opts.claudeModel}\` (${opts.claudeEffort}), session \`${state.claudeSessionId ?? '-'}\``,
    `- Outcome: **${state.outcome ?? 'running'}**${state.error ? ` — ${state.error}` : ''}`,
    `- Claude cost: $${state.turns.reduce((total, record) => total + (record.claude?.costUsd ?? 0), 0).toFixed(2)}`,
    '',
    `## Scope (${state.scope.length} files in the change when the loop started)`,
    '',
    ...state.scope.map((file) => `- \`${file}\``),
    '',
    '## Turns',
    '',
    '| Turn | Codex verdict | Findings | Claude addressed | Claude rejected | Diff changed | Out of scope | Check | Claude cost | Codex tokens |',
    '| ---- | ------------- | -------- | ---------------- | --------------- | ------------ | ------------ | ----- | ----------- | ------------ |',
  ];

  for (const record of state.turns) {
    const findingIds =
      record.codex.envelope.findings.map((finding) => `${finding.id}:${finding.severity[0]}`).join(' ') || '-';

    const claude = record.claude;

    const cells = [
      record.turn,
      record.codex.envelope.verdict,
      findingIds,
      claude ? claude.envelope.addressed.map((item) => item.id).join(' ') || '-' : '',
      claude ? claude.envelope.rejected.map((item) => item.id).join(' ') || '-' : '',
      claude ? (claude.diffChanged ? 'yes' : 'no') : '',
      claude ? (claude.outOfScope.length > 0 ? claude.outOfScope.length : '-') : '',
      claude ? fmtCheck(claude.check) || '-' : '',
      claude?.costUsd != null ? `$${claude.costUsd.toFixed(2)}` : '',
      fmtUsage(record.codex.usage),
    ];

    lines.push(`| ${cells.join(' | ')} |`);
  }

  const section = (title, items, render) => {
    if (items.length === 0) {
      return;
    }

    lines.push('', `## ${title}`, '');

    for (const item of items) {
      lines.push(render(item));
    }
  };

  section('Open findings (not resolved when the loop stopped)', state.open, renderFinding);

  section('Disputed findings (escalated to you)', Object.values(state.disputed), renderDispute);

  section('Notes left by codex on approval', state.notes, renderFinding);

  section(
    'Pre-existing issues codex noticed (out of scope, not addressed)',
    Object.values(state.preExisting),
    (item) => `- ${item.location}: ${item.issue}`,
  );

  section('Warnings', state.warnings, (warning) => `- ${warning}`);

  lines.push('', '## Per-turn summaries', '');

  for (const record of state.turns) {
    lines.push(`- Turn ${record.turn} codex: ${record.codex.envelope.summary}`);

    if (record.claude) {
      lines.push(`- Turn ${record.turn} claude: ${record.claude.envelope.summary}`);
    }
  }

  lines.push(
    '',
    `Diff snapshots: \`${path.join(state.runDir, 'diff')}\` (diff-0.patch is the input, diff-N.patch after claude turn N).`,
  );

  if (state.resumed > 0) {
    lines.push(
      '',
      `Resumed ${state.resumed} time(s) from the last completed turn. Execution records are in \`state.sqlite\`.`,
    );
  }

  fs.writeFileSync(path.join(state.runDir, 'run.md'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(state.runDir, 'state.json'), JSON.stringify(persistable(state), null, 2) + '\n');
}

const patchFile = (state, turn) => path.join(state.runDir, 'diff', `diff-${turn}.patch`);
const checkFile = (state, turn) => path.join(state.runDir, 'checks', `check-${turn}.log`);

const goalOf = (options) =>
  options.goal ?? 'Not stated. Infer it from the diff and the commit messages, and do not widen it.';

// the check result the next prompt describes: the latest claude turn's, else the baseline
const lastCheck = (state) => (state.turns.at(-1)?.claude ? state.turns.at(-1).claude.check : state.baselineCheck);

/**
 * Runs the Codex step of a turn, which reviews, records, and decides whether the loop stops.
 * Returns the next position.
 */
async function codexStep(state, turn, context) {
  const { opts } = state;
  const lastClaude = state.turns.at(-1)?.claude ?? null;

  log(`turn ${turn}/${opts.maxTurns}: codex ${turn === 1 ? 'review' : 're-review'}`);

  const disputedIds = Object.keys(state.disputed);

  const codexPrompt =
    turn === 1
      ? template('codex-review.md', {
          CWD: opts.cwd,
          BASE: `${state.base} (merge-base ${state.mergeBase.slice(0, 10)})`,
          GOAL: goalOf(opts),
          COMMITS: formatList(context.commits, 'none (the change is uncommitted)'),
          SCOPE_FILES: formatList(state.scope),
          CHECK: describeCheck(opts.check, lastCheck(state)),
          DIFF_PATH: patchFile(state, 0),
          DIFF: describeDiff(fs.readFileSync(patchFile(state, 0), 'utf8'), patchFile(state, 0)),
        })
      : template('codex-rereview.md', {
          TURN: String(turn),
          MAX_TURNS: String(opts.maxTurns),
          CLAUDE_RESPONSE_JSON: JSON.stringify(lastClaude.envelope, null, 2),
          DISPUTED_IDS: disputedIds.length > 0 ? disputedIds.join(', ') : 'none',
          OUT_OF_SCOPE_FILES: formatList(lastClaude.outOfScope),
          NEW_FILES: formatList(lastClaude.newFiles),
          CHECK: describeCheck(opts.check, lastCheck(state)),
          DIFF_PATH: patchFile(state, turn - 1),
          DIFF: describeDiff(fs.readFileSync(patchFile(state, turn - 1), 'utf8'), patchFile(state, turn - 1)),
        });

  const { taskId, replayed, record: codex } = await codexTurn(state, turn, codexPrompt);

  if (replayed) {
    log(`  replayed the recorded codex turn ${turn}`);
  }

  codex.envelope.preExisting = Array.isArray(codex.envelope.preExisting) ? codex.envelope.preExisting : [];

  state.turns.push({ turn, codex, claude: null });

  for (const item of codex.envelope.preExisting) {
    state.preExisting[`${item.location}|${item.issue}`] = item;
  }

  const findings = codex.envelope.findings;
  const active = findings.filter((finding) => !state.disputed[finding.id]);

  log(`  verdict ${codex.envelope.verdict}, ${findings.length} findings (${active.length} active)`);

  if (codex.envelope.verdict === 'approve' || findings.length === 0) {
    state.notes = active;
    state.outcome = 'approved';
    return { taskId, next: { done: true, exitCode: 0 } };
  }

  if (active.length === 0) {
    state.outcome = 'stalemate';
    return { taskId, next: { done: true, exitCode: 3 } };
  }

  if (turn === opts.maxTurns) {
    state.open = active;
    state.outcome = 'max-turns';
    return { taskId, next: { done: true, exitCode: 2 } };
  }

  return { taskId, next: { turn, step: 'claude' } };
}

/**
 * Runs the Claude step of a turn, which fixes or rejects findings, re-snapshots, runs the check,
 * and records warnings. Returns the next position.
 */
async function claudeStep(state, turn) {
  const { opts } = state;
  const record = state.turns.at(-1);
  const active = record.codex.envelope.findings.filter((finding) => !state.disputed[finding.id]);
  const scope = new Set(state.scope);
  const previousPatch = fs.readFileSync(patchFile(state, turn - 1), 'utf8');

  log(`turn ${turn}/${opts.maxTurns}: claude addresses ${active.length} findings`);

  const reraised = active.filter((finding) => state.rejections[finding.id]).map((finding) => finding.id);

  const claudePrompt =
    turn === 1
      ? template('claude-address.md', {
          CWD: opts.cwd,
          GOAL: goalOf(opts),
          SCOPE_FILES: formatList(state.scope),
          CHECK_CMD: opts.check ?? 'none',
          CHECK: describeCheck(opts.check, lastCheck(state)),
          DIFF_PATH: patchFile(state, 0),
          DIFF: describeDiff(previousPatch, patchFile(state, 0)),
          FINDINGS_JSON: JSON.stringify(active, null, 2),
        })
      : template('claude-readdress.md', {
          TURN: String(turn),
          MAX_TURNS: String(opts.maxTurns),
          RERAISED_IDS: reraised.length > 0 ? reraised.join(', ') : 'none',
          CHECK: describeCheck(opts.check, lastCheck(state)),
          FINDINGS_JSON: JSON.stringify(active, null, 2),
        });

  const { taskId, replayed, record: claude } = await claudeTurn(state, turn, claudePrompt);

  if (replayed) {
    log(`  replayed the recorded claude turn ${turn}`);
  }

  const after = snapshot(opts.cwd, state.mergeBase);

  fs.writeFileSync(patchFile(state, turn), after.patch);

  const untracked = new Set(after.untracked);

  claude.diffChanged = after.patch !== previousPatch;
  claude.newFiles = after.files.filter((file) => !scope.has(file) && untracked.has(file));
  claude.outOfScope = after.files.filter((file) => !scope.has(file) && !untracked.has(file));
  claude.check = opts.check ? await runCheck(opts.cwd, opts.check, state.checkPrefix, checkFile(state, turn)) : null;
  record.claude = claude;

  if (claude.outOfScope.length > 0) {
    state.warnings.push(
      `turn ${turn}: claude modified pre-existing files outside the change's scope: ${claude.outOfScope.join(', ')}; inspect \`git diff\` and revert what the findings did not require`,
    );
  }

  if (claude.envelope.addressed.length > 0 && !claude.diffChanged) {
    state.warnings.push(
      `turn ${turn}: claude reported ${claude.envelope.addressed.length} addressed findings but the diff did not change`,
    );
  }

  if (claude.check && !claude.check.ok && state.baselineCheck?.ok) {
    state.warnings.push(`turn ${turn}: check command passed before the loop and fails after claude's edits`);
  }

  if (claude.permissionDenials.length > 0) {
    state.warnings.push(`turn ${turn}: claude was denied tools: ${claude.permissionDenials.join(', ')}`);
  }

  const answered = new Set([...claude.envelope.addressed, ...claude.envelope.rejected].map((item) => item.id));
  const unanswered = active.filter((finding) => !answered.has(finding.id)).map((finding) => finding.id);

  if (unanswered.length > 0) {
    state.warnings.push(`turn ${turn}: claude did not respond to ${unanswered.join(', ')}`);
  }

  // rejections[id] accumulates claude's rejections, and once it reaches disputeAfter the finding is escalated
  for (const rejection of claude.envelope.rejected) {
    const finding = active.find((candidate) => candidate.id === rejection.id);

    if (!finding) {
      continue;
    }

    const history = (state.rejections[rejection.id] ??= { finding, rejected: [] });

    history.finding = finding;

    history.rejected.push({ reason: rejection.reason, evidence: rejection.evidence });

    if (history.rejected.length >= opts.disputeAfter) {
      state.disputed[rejection.id] = history;
    }
  }

  log(
    `  addressed ${claude.envelope.addressed.length}, rejected ${claude.envelope.rejected.length}, out of scope ${claude.outOfScope.length}, check ${fmtCheck(claude.check) || 'n/a'}, disputed so far ${Object.keys(state.disputed).length}`,
  );

  return { taskId, next: { turn: turn + 1, step: 'codex' } };
}

function summary(state) {
  return {
    outcome: state.outcome,
    runDir: state.runDir,
    report: path.join(state.runDir, 'run.md'),
    cwd: state.opts.cwd,
    base: state.base,
    scope: state.scope,
    turns: state.turns.length,
    open: state.open.map((finding) => finding.id),
    disputed: Object.keys(state.disputed),
    warnings: state.warnings.length,
    error: state.error,
  };
}

async function start(options, runner) {
  if (!git(options.cwd, ['rev-parse', '--is-inside-work-tree']).ok) {
    fail(`--cwd is not a git repository: ${options.cwd}`);
  }

  const base = resolveBase(options.cwd, options.base);
  const mergeBase = git(options.cwd, ['merge-base', base, 'HEAD']).stdout.trim();

  if (!mergeBase) {
    fail(`no merge-base between ${base} and HEAD`);
  }

  const branch = git(options.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim() || 'detached';
  const initial = snapshot(options.cwd, mergeBase);

  if (initial.files.length === 0) {
    fail(`nothing to review: no changes between ${base} (${mergeBase.slice(0, 10)}) and the working tree`);
  }

  const slug =
    branch
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, '-')
      .replaceAll(/^-|-$/g, '')
      .slice(0, 40) || 'detached';

  const stamp = new Date().toISOString().replaceAll(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  const runId = `${stamp}-code-review-${slug}`;
  const runDir = options.runDir ? path.resolve(options.runDir) : path.join(runner.defaultRunsRoot(), runId);

  // executables, their arguments, and the check sandbox are checked before any run state exists
  const resolved = await runner.preflightWorkflowProfiles(profiles(options, runDir));
  const checkPrefix = await checkSandboxPrefix(options, runner);

  for (const subdir of ['codex/review', 'claude/address', 'diff', 'checks']) {
    fs.mkdirSync(path.join(runDir, subdir), { recursive: true });
  }

  // opening the workflow checks the Node runtime, so an unsupported one fails before the baseline check runs
  const wf = await runner.openWorkflow({ runDir, kind: 'code-review', label: runId });

  fs.writeFileSync(path.join(runDir, 'diff', 'diff-0.patch'), initial.patch);
  fs.writeFileSync(path.join(runDir, 'diff', 'scope.txt'), initial.files.join('\n') + '\n');
  log(`run dir: ${runDir}`);
  log(`reviewing ${initial.files.length} files on ${branch} against ${base} (${mergeBase.slice(0, 10)})`);

  const commits = gitLines(options.cwd, ['log', '--no-decorate', '--format=%h %s', `${mergeBase}..HEAD`]);

  const state = {
    runId,
    runDir,
    opts: options,
    branch,
    base,
    mergeBase,
    scope: initial.files,
    baselineCheck: null,
    codexThreadId: null,
    claudeSessionId: null,
    turns: [],
    rejections: {},
    disputed: {},
    preExisting: {},
    open: [],
    notes: [],
    warnings: [],
    outcome: null,
    error: null,
    resumed: 0,
    checkPrefix,
  };

  if (options.check) {
    log(`baseline check: ${options.check}`);

    state.baselineCheck = await runCheck(options.cwd, options.check, checkPrefix, checkFile(state, 0));

    log(`  ${fmtCheck(state.baselineCheck)}`);

    if (!state.baselineCheck.ok) {
      state.warnings.push(
        `check command fails before any edits (exit ${state.baselineCheck.status}); see checks/check-0.log`,
      );
    }
  }

  const position = { turn: 1, step: 'codex' };
  const context = { commits };

  state.wf = wf;
  state.profiles = resolved;

  state.wf.checkpoint({ state: persistable(state), position, context });

  return { state, position, context };
}

async function resume({ resume: runDir, acceptPartialTurn }, runner) {
  const wf = await runner.openWorkflow({ runDir, kind: 'code-review', label: path.basename(runDir), resume: true });
  const checkpoint = wf.latestCheckpoint();

  if (!checkpoint) {
    wf.close();
    fail(`${runDir} has no checkpoint to resume from`);
  }

  const { state: saved, position, context } = checkpoint.state;

  if (position.done) {
    // finished, possibly crashed before reporting: regenerate the report and summary from the final checkpoint
    const finished = { ...saved, wf };

    writeReport(finished);
    wf.close();
    log(`${runDir} already finished with outcome ${saved.outcome}; report regenerated`);
    console.log(JSON.stringify(summary(finished), null, 2));
    process.exit(position.exitCode);
  }

  const state = { ...saved, outcome: null, error: null, resumed: (saved.resumed ?? 0) + 1, wf };

  log(`run dir: ${runDir}`);
  log(`resuming at turn ${position.turn}, ${position.step} step`);

  // a turn that ended uncertain may have left a provider running or partial effects, so rerunning it needs consent
  for (const step of [
    position.step === 'codex' ? `codex-review-${position.turn}` : `claude-address-${position.turn}`,
  ]) {
    const latest = wf.tasksForStep(step).at(-1);

    if (latest?.state === 'recovery_required') {
      if (!acceptPartialTurn) {
        wf.close();

        fail(
          `${step} ended uncertain (${latest.failure_message}). Inspect its effects, then rerun with --accept-partial-turn.`,
        );
      }

      state.warnings.push(`resume: ${step} had ended uncertain; it was rerun at the operator's request`);

      state.acceptUncertain = true;
    }
  }

  // an interrupted claude turn may have edited the working tree, so rerunning it on top of a partial edit needs consent
  if (position.step === 'claude') {
    const latest = wf.tasksForStep(`claude-address-${position.turn}`).at(-1);
    const completed = latest?.state === 'succeeded' && !latest.consumed;
    const current = snapshot(state.opts.cwd, state.mergeBase).patch;

    if (!completed && current !== fs.readFileSync(patchFile(state, position.turn - 1), 'utf8')) {
      if (!acceptPartialTurn) {
        wf.close();

        fail(
          `claude turn ${position.turn} did not complete but the working tree changed since it started. Compare \`git diff ${state.mergeBase}\` with diff/diff-${position.turn - 1}.patch, then rerun with --accept-partial-turn to continue from the current working tree.`,
        );
      }

      state.warnings.push(
        `resume: claude turn ${position.turn} was interrupted after editing files; it was rerun on the partially edited tree at the operator's request`,
      );
    }
  }

  try {
    state.profiles = await runner.preflightWorkflowProfiles(profiles(state.opts, runDir));
    state.checkPrefix = await checkSandboxPrefix(state.opts, runner);
  } catch (error) {
    wf.close();
    throw error;
  }

  return { state, position, context };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const runner = await loadRunner();

  let state;
  let position;
  let context;

  try {
    ({ state, position, context } = options.resume ? await resume(options, runner) : await start(options, runner));
  } catch (error) {
    if (error instanceof runner.OrchestratorError) {
      fail(error.message);
    }

    throw error;
  }

  writeReport(state);

  let exitCode;

  try {
    while (!position.done) {
      const step =
        position.step === 'codex'
          ? await codexStep(state, position.turn, context)
          : await claudeStep(state, position.turn);

      position = step.next;

      state.wf.checkpoint({ state: persistable(state), position, context }, [step.taskId]);
      writeReport(state);
    }

    exitCode = position.exitCode;
  } catch (error) {
    state.outcome = 'failed';
    state.error = error.message;
    exitCode = 1;

    log(`failed: ${error.message}`);
  }

  writeReport(state);

  try {
    state.wf.finish(state.outcome);
    state.wf.close();
  } catch (error) {
    log(`could not record the outcome in state.sqlite: ${error.message}`);
  }

  log(`outcome: ${state.outcome}`);

  console.log(JSON.stringify(summary(state), null, 2));

  process.exit(exitCode);
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exit(EXIT_INTERNAL);
}
