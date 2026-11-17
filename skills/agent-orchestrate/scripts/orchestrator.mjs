#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { ADAPTERS } from './lib/adapters/index.mjs';
import { OrchestratorError, loadManifest } from './lib/contracts.mjs';
import { reportPath, statusSnapshot, writeReport } from './lib/report.mjs';
import { Store } from './lib/store.mjs';
import { EXIT_CODES, Supervisor, cleanupRun, createRun, defaultRunsRoot, preflightRun } from './lib/supervisor.mjs';

const USAGE = `
Usage: orchestrator <command> [options]

Commands:
  validate MANIFEST                      check structure and dependency graph; starts nothing
  doctor MANIFEST                        check runtime, executables, and that each profile's arguments are accepted
                                         (no models are invoked by the runner itself, only by scripts that drive their own turn loop)
  run MANIFEST [--runs-root DIR]         create a run and supervise it in the foreground
  status RUN_DIR [--json]                show run state
  watch RUN_DIR [--after SEQ] [--timeout-ms N]
                                         wait up to N ms (default 30000) for events after SEQ; prints JSON
  cancel RUN_DIR [--task ID]             cancel one task, or the whole run when --task is omitted
  continue RUN_DIR --task ID --prompt-file FILE
                                         give a blocked task more input; resumes its saved session
  recover RUN_DIR [--decision FILE]      reconcile unfinished work under a new lease, then continue the run
  report RUN_DIR                         regenerate the Markdown report from state
  cleanup RUN_DIR [--task ID] [--discard-ignored]
                                         remove worktrees whose work is finished and preserved; a worktree holding
                                         ignored files is kept unless --discard-ignored is given; prints the refs
                                         that remain and the command that deletes them

Exit codes: 0 succeeded, 1 failed, 2 blocked, 3 recovery required, 4 cancelled, 5 stopped (deadline or spend
threshold), 6 still running, 64 usage or configuration error, 70 internal error.
`.trim();

const log = (line) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${line}`);

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(EXIT_CODES.usage);
}

function requireRunDir(value) {
  if (!value) {
    fail(`a run directory is required\n\n${USAGE}`);
  }

  const dir = path.resolve(value);

  if (!fs.existsSync(path.join(dir, 'state.sqlite'))) {
    fail(`${dir} has no state.sqlite, so it is not a run directory`);
  }

  return dir;
}

function withStore(runDir, read) {
  const store = Store.open(path.join(runDir, 'state.sqlite'), { readOnly: true });

  try {
    return read(store);
  } finally {
    store.close();
  }
}

// supervising a run needs the manifest it was created from, and a run driven by a workflow script has none
function requireManifestRun(value) {
  const runDir = requireRunDir(value);
  const { kind } = withStore(runDir, (store) => store.run());

  if (kind !== 'manifest') {
    fail(`${runDir} is a ${kind} workflow run; resume, stop, or clean it up with the script that created it`);
  }

  return runDir;
}

function requireTask(runDir, id) {
  const task = withStore(runDir, (store) => store.task(id));

  if (!task) {
    fail(`unknown task ${id}`);
  }

  return task;
}

function nonNegativeInteger(value, option) {
  if (!/^\d+$/.test(value)) {
    fail(`${option} must be a non-negative integer, got ${value}`);
  }

  return Number(value);
}

function readInputFile(file, what) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    return fail(`cannot read the ${what} ${file}: ${error.message}`);
  }
}

function leaseIsLive(runDir) {
  const run = withStore(runDir, (store) => store.run());

  return Boolean(run.owner_token) && run.lease_expires_at > Date.now();
}

function enqueueControl(runDir, request) {
  const store = Store.open(path.join(runDir, 'state.sqlite'));

  try {
    return store.enqueueControl(request);
  } finally {
    store.close();
  }
}

/**
 * Waits while a supervisor holds the run, and returns the request once that supervisor has resolved
 * it. Returns null when no supervisor is left and the request is still pending. That happens when
 * the owner crashed, or when it finished between the request and its last pass, and the caller then
 * applies the request itself.
 */
async function resolvedByOwner(runDir, controlId) {
  const started = performance.now();

  let announced = false;

  while (leaseIsLive(runDir)) {
    const control = withStore(runDir, (store) => store.control(controlId));

    if (control.status !== 'pending') {
      return control;
    }

    if (!announced && performance.now() - started > 2000) {
      announced = true;

      log('the supervisor that holds this run has not applied the request; waiting until it does or its lease ends');
    }

    await delay(100);
  }

  const control = withStore(runDir, (store) => store.control(controlId));

  return control.status === 'pending' ? null : control;
}

function printStatus(runDir, json) {
  return withStore(runDir, (store) => {
    const status = statusSnapshot(store);

    if (json) {
      console.log(JSON.stringify(status, null, 2));
      return status;
    }

    console.log(
      `${status.runId}  ${status.outcome}  (supervisor ${status.lease.live ? 'live' : 'not running'}, event #${status.lastEventSeq})`,
    );

    for (const task of status.tasks) {
      const latest = task.latestAttempt;
      const detail = task.blocker?.reason ?? task.failure?.message ?? latest?.outcome ?? latest?.phase ?? '';

      console.log(`  ${task.id.padEnd(24)} ${task.state.padEnd(18)} attempts ${task.attempts}  ${detail}`);
    }

    if (status.integration) {
      console.log(`  integration: ${status.integration.status}`);
    }

    console.log(`report: ${reportPath(store.run())}`);

    return status;
  });
}

async function supervise(runDir, options) {
  const supervisor = new Supervisor(runDir, { log });

  let interrupts = 0;

  const onSignal = () => {
    interrupts++;

    if (interrupts > 1) {
      log('second interrupt: exiting; attempt hosts stop their workers when the lease lapses');
      process.exit(EXIT_CODES.cancelled);
    }

    log('interrupt: cancelling the run; press again to exit immediately');
    supervisor.store.enqueueControl({ kind: 'cancel' });
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    const result = await supervisor.supervise(options);

    for (const rejected of result.rejectedDecisions) {
      log(`decision for ${rejected.taskId} rejected: ${rejected.reason}`);
    }

    printStatus(runDir, true);
    log(`outcome: ${result.outcome}`);

    return result.rejectedDecisions.length > 0 && result.exitCode === 0 ? EXIT_CODES.usage : result.exitCode;
  } finally {
    supervisor.close();
  }
}

function parseOptions(args) {
  try {
    return parseArgs({
      args,
      allowPositionals: true,
      options: {
        json: { type: 'boolean', default: false },
        task: { type: 'string' },
        'prompt-file': { type: 'string' },
        decision: { type: 'string' },
        after: { type: 'string', default: '0' },
        'timeout-ms': { type: 'string', default: '30000' },
        'runs-root': { type: 'string' },
        'discard-ignored': { type: 'boolean', default: false },
      },
    });
  } catch (error) {
    if (!String(error.code).startsWith('ERR_PARSE_ARGS')) {
      throw error;
    }

    // the first sentence names the problem, and the rest is advice about positional arguments that begin with a dash
    return fail(error.message.split('. ')[0]);
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === '-h' || command === '--help' || command === 'help') {
    console.log(USAGE);
    return 0;
  }

  const { values, positionals } = parseOptions(rest);
  const target = positionals[0];

  switch (command) {
    case 'validate': {
      const { manifest, sha256 } = loadManifest(target ?? fail('a manifest path is required'), { adapters: ADAPTERS });

      const summary = {
        ok: true,
        sha256,
        label: manifest.label,
        tasks: manifest.order,
        integration: manifest.integration?.order ?? null,
      };

      console.log(JSON.stringify(summary, null, 2));
      return 0;
    }
    case 'doctor': {
      const { manifest } = loadManifest(target ?? fail('a manifest path is required'), { adapters: ADAPTERS });
      const { runtime, resolved, problems, warnings } = await preflightRun(manifest);

      const report = {
        ok: problems.length === 0,
        runtime,
        checkSandbox: manifest.checkSandbox,
        profiles: Object.fromEntries(
          Object.entries(resolved).map(([name, profile]) => [
            name,
            {
              adapter: profile.adapter,
              executable: profile.executable,
              ...profile.resolution,
              capabilities: [...ADAPTERS[profile.adapter].capabilities],
            },
          ]),
        ),
        problems,
        warnings,
      };

      console.log(JSON.stringify(report, null, 2));
      return report.ok ? 0 : EXIT_CODES.usage;
    }
    case 'run': {
      const { runDir } = await createRun(target ?? fail('a manifest path is required'), {
        runsRoot: values['runs-root'] ? path.resolve(values['runs-root']) : defaultRunsRoot(),
      });

      log(`run dir: ${runDir}`);

      return supervise(runDir, { dispatch: true });
    }
    case 'status': {
      const runDir = requireRunDir(target);
      const status = printStatus(runDir, values.json);

      return status.outcome === 'in progress' ? EXIT_CODES.running : (EXIT_CODES[status.outcome] ?? 0);
    }
    case 'watch': {
      const runDir = requireRunDir(target);
      const after = nonNegativeInteger(values.after, '--after');
      const deadline = Date.now() + nonNegativeInteger(values['timeout-ms'], '--timeout-ms');
      const store = Store.open(path.join(runDir, 'state.sqlite'), { readOnly: true });

      try {
        let events = store.events({ after });

        while (events.length === 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          events = store.events({ after });
        }

        const status = statusSnapshot(store);

        console.log(
          JSON.stringify(
            { cursor: events.at(-1)?.seq ?? after, outcome: status.outcome, supervisorLive: status.lease.live, events },
            null,
            2,
          ),
        );
      } finally {
        store.close();
      }

      return 0;
    }
    case 'cancel': {
      const runDir = requireManifestRun(target);

      if (values.task) {
        requireTask(runDir, values.task);
      }

      const request = enqueueControl(runDir, { kind: 'cancel', taskId: values.task ?? null });

      if (await resolvedByOwner(runDir, request)) {
        log('the running supervisor applied the cancellation');
        return 0;
      }

      log('no supervisor is running; reconciling and applying the cancellation now');

      return supervise(runDir, { dispatch: false });
    }
    case 'continue': {
      const runDir = requireManifestRun(target);

      if (!values.task || !values['prompt-file']) {
        fail('continue needs --task ID and --prompt-file FILE');
      }

      const promptFile = path.resolve(values['prompt-file']);
      const promptText = readInputFile(promptFile, 'prompt file');
      const task = requireTask(runDir, values.task);

      if (task.state !== 'blocked') {
        fail(
          `task ${task.id} is ${task.state}; only blocked tasks can continue. A succeeded task's follow-up belongs in a new task.`,
        );
      }

      const request = enqueueControl(runDir, {
        kind: 'continue',
        taskId: task.id,
        data: { promptText, promptSource: promptFile },
      });

      const resolved = await resolvedByOwner(runDir, request);

      if (resolved?.status === 'rejected') {
        fail(`the running supervisor rejected the continuation: ${resolved.result}`);
      }

      if (resolved) {
        log('the running supervisor applied the continuation');
        return 0;
      }

      return supervise(runDir, { dispatch: true });
    }
    case 'recover': {
      const runDir = requireManifestRun(target);

      if (leaseIsLive(runDir)) {
        fail('a supervisor holds a valid lease on this run; recovery starts only after it stops or its lease expires');
      }

      let decisions = null;

      if (values.decision) {
        const file = path.resolve(values.decision);
        const text = readInputFile(file, 'decision file');

        try {
          decisions = JSON.parse(text);
        } catch (error) {
          fail(`decision file ${file} is not valid JSON: ${error.message}`);
        }
      }

      return supervise(runDir, { dispatch: true, decisions });
    }
    case 'report': {
      const runDir = requireRunDir(target);

      console.log(withStore(runDir, (store) => writeReport(store)));

      return 0;
    }
    case 'cleanup': {
      const runDir = requireManifestRun(target);

      if (values.task) {
        requireTask(runDir, values.task);
      }

      const result = await cleanupRun(runDir, {
        taskId: values.task ?? null,
        discardIgnored: values['discard-ignored'],
      });

      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    default: {
      fail(`unknown command ${command}\n\n${USAGE}`);

      return EXIT_CODES.usage;
    }
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof OrchestratorError) {
    console.error(`error (${error.category}): ${error.message}`);

    process.exitCode = EXIT_CODES.usage;
  } else {
    // exit code 1 means that a run failed, so a failure of the runner itself gets its own code
    console.error(`internal error: ${error.stack ?? error}`);

    process.exitCode = EXIT_CODES.internal;
  }
}
