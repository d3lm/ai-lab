import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { LeaseLostError, OrchestratorError, TASK_STATES, assertTransition } from './contracts.mjs';

export const STORE_SCHEMA_VERSION = 1;

const STATE_LIST = TASK_STATES.map((state) => `'${state}'`).join(', ');

const MIGRATIONS = [
  `
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      run_dir TEXT NOT NULL,
      created_at TEXT NOT NULL,
      manifest_sha256 TEXT,
      manifest_json TEXT,
      input_json TEXT,
      runtime_json TEXT,
      deadline_at INTEGER,
      owner_token TEXT,
      owner_generation INTEGER NOT NULL DEFAULT 0,
      lease_expires_at INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'finished')),
      outcome TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      dispatch_stopped TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      ord INTEGER NOT NULL,
      step_key TEXT,
      state TEXT NOT NULL CHECK (state IN (${STATE_LIST})),
      state_version INTEGER NOT NULL DEFAULT 0,
      spec_json TEXT NOT NULL,
      session_name TEXT,
      attempts_used INTEGER NOT NULL DEFAULT 0,
      not_before INTEGER,
      prepared_input_json TEXT,
      result_attempt_id TEXT,
      blocker_json TEXT,
      failure_class TEXT,
      failure_message TEXT,
      next_attempt_json TEXT,
      consumed INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE task_deps (
      task_id TEXT NOT NULL REFERENCES tasks(id),
      dep_id TEXT NOT NULL REFERENCES tasks(id),
      PRIMARY KEY (task_id, dep_id)
    );

    CREATE TABLE sessions (
      name TEXT PRIMARY KEY,
      adapter TEXT NOT NULL,
      profile TEXT,
      provider_session_id TEXT,
      cwd TEXT,
      quarantine TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE attempts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      number INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('initial', 'retry', 'continuation')),
      previous_attempt_id TEXT REFERENCES attempts(id),
      session_name TEXT REFERENCES sessions(name),
      phase TEXT NOT NULL CHECK (phase IN ('prepared', 'launching', 'running', 'exited', 'verifying', 'finished')),
      active INTEGER NOT NULL CHECK (active IN (0, 1)),
      nonce TEXT NOT NULL,
      owner_generation INTEGER NOT NULL,
      attempt_dir TEXT NOT NULL,
      profile_json TEXT NOT NULL,
      prompt_sha256 TEXT NOT NULL,
      workspace_path TEXT,
      input_json TEXT,
      host_json TEXT,
      provider_json TEXT,
      exit_json TEXT,
      outcome TEXT CHECK (outcome IS NULL OR outcome IN ('succeeded', 'failed', 'blocked', 'cancelled', 'interrupted', 'uncertain')),
      failure_class TEXT,
      failure_message TEXT,
      provider_session_id TEXT,
      usage_json TEXT,
      cost_usd REAL,
      result_json TEXT,
      payload_json TEXT,
      events_offset INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      launched_at TEXT,
      ended_at TEXT,
      last_activity_at TEXT,
      UNIQUE (task_id, number)
    );

    CREATE UNIQUE INDEX attempts_one_active_per_task ON attempts(task_id) WHERE active = 1;
    CREATE UNIQUE INDEX attempts_one_active_per_session ON attempts(session_name) WHERE active = 1 AND session_name IS NOT NULL;

    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY,
      task_id TEXT REFERENCES tasks(id),
      attempt_id TEXT REFERENCES attempts(id),
      kind TEXT NOT NULL,
      path TEXT,
      sha256 TEXT,
      bytes INTEGER,
      data_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT,
      attempt_id TEXT,
      scope TEXT NOT NULL CHECK (scope IN ('task', 'integration')),
      name TEXT NOT NULL,
      argv_json TEXT NOT NULL,
      subject_sha256 TEXT,
      ok INTEGER NOT NULL,
      exit_code INTEGER,
      signal TEXT,
      timed_out INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER,
      log_path TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      type TEXT NOT NULL,
      task_id TEXT,
      attempt_id TEXT,
      data_json TEXT
    );

    CREATE TABLE control_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('cancel', 'continue')),
      task_id TEXT,
      data_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'rejected')),
      applied_at TEXT,
      result TEXT
    );

    CREATE TABLE integrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL CHECK (status IN ('conflict', 'failed', 'passed', 'error')),
      base_commit TEXT,
      result_commit TEXT,
      patch_path TEXT,
      patch_sha256 TEXT,
      detail_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE checkpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow TEXT NOT NULL,
      version INTEGER NOT NULL,
      state_json TEXT NOT NULL,
      consumed_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `,
];

const JSON_SUFFIX = '_json';

function hydrate(row) {
  if (!row) {
    return null;
  }

  const out = {};

  for (const [key, value] of Object.entries(row)) {
    if (key.endsWith(JSON_SUFFIX)) {
      out[key.slice(0, -JSON_SUFFIX.length)] = value === null ? null : JSON.parse(value);
    } else {
      out[key] = value;
    }
  }

  return out;
}

function dehydrate(fields) {
  const out = {};

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) {
      continue;
    }

    if (key.endsWith(JSON_SUFFIX)) {
      out[key] = value === null ? null : JSON.stringify(value);
    } else if (typeof value === 'boolean') {
      out[key] = value ? 1 : 0;
    } else {
      out[key] = value;
    }
  }

  return out;
}

export class Store {
  constructor(db, { clock, readOnly, file }) {
    this.db = db;
    this.file = file;
    this.clock = clock ?? { now: () => Date.now() };
    this.readOnly = readOnly;
    this.runId = null;
    this.ownerToken = null;
    this.generation = null;
    this.inTransaction = false;
  }

  static create(file, run, { clock, tasks = [] } = {}) {
    if (fs.existsSync(file)) {
      throw new OrchestratorError('storage', `state database already exists: ${file}`);
    }

    /**
     * Build the database (schema, run row, and tasks) under a temporary name and rename it
     * into place, so a reader never sees a partial schema, a database without its run, or
     * a run without all of its tasks.
     */
    const building = `${file}.init-${process.pid}`;
    const initial = new Store(new DatabaseSync(building), { clock, readOnly: false, file: building });

    try {
      initial.db.exec('PRAGMA journal_mode = DELETE');
      initial.db.exec('PRAGMA foreign_keys = ON');
      initial.migrate();

      const now = initial.isoNow();

      initial.tx(() => {
        initial.insert('runs', {
          id: run.id,
          kind: run.kind,
          label: run.label,
          run_dir: run.runDir,
          created_at: now,
          manifest_sha256: run.manifestSha256 ?? null,
          manifest_json: run.manifest ?? null,
          input_json: run.input ?? null,
          runtime_json: run.runtime ?? null,
          deadline_at: run.deadlineAt ?? null,
          updated_at: now,
        });

        initial.appendEvent('run.created', { data: { kind: run.kind, label: run.label } });

        // every task row exists before any dependency edge refers to it, whatever order the tasks are listed in
        for (const task of tasks) {
          initial.insertTask({ ...task, dependsOn: [] });
        }

        for (const task of tasks) {
          initial.insertDependencies(task.id, task.dependsOn ?? []);
        }
      });
    } catch (error) {
      initial.close();
      fs.rmSync(building, { force: true });
      throw error;
    }

    initial.close();
    fs.renameSync(building, file);

    const store = new Store(new DatabaseSync(file), { clock, readOnly: false, file });

    store.configure();

    store.runId = run.id;

    return store;
  }

  static open(file, { clock, readOnly = false } = {}) {
    if (!fs.existsSync(file)) {
      throw new OrchestratorError(
        'usage',
        `no state database at ${file}; this is not a run directory created by the runner`,
      );
    }

    const db = new DatabaseSync(file, { readOnly });
    const store = new Store(db, { clock, readOnly, file });

    store.configure();

    const version = Number(store.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value);

    if (version !== STORE_SCHEMA_VERSION) {
      db.close();
      throw new OrchestratorError('storage', `unsupported state schema version ${version} in ${file}`);
    }

    store.runId = store.db.prepare('SELECT id FROM runs LIMIT 1').get()?.id ?? null;

    return store;
  }

  configure() {
    this.db.exec('PRAGMA busy_timeout = 10000');
    this.db.exec('PRAGMA foreign_keys = ON');

    if (!this.readOnly) {
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = FULL');
    }
  }

  migrate() {
    this.db.exec(MIGRATIONS[0]);
    this.db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(STORE_SCHEMA_VERSION));
  }

  close() {
    this.db.close();
  }

  isoNow() {
    return new Date(this.clock.now()).toISOString();
  }

  tx(fn) {
    if (this.inTransaction) {
      return fn();
    }

    this.db.exec('BEGIN IMMEDIATE');

    this.inTransaction = true;

    try {
      const result = fn();

      this.db.exec('COMMIT');

      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // the transaction may already be rolled back by SQLite
      }

      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  ownerTx(fn) {
    return this.tx(() => {
      this.assertOwner();
      return fn();
    });
  }

  assertOwner() {
    const row = this.db.prepare('SELECT owner_token, owner_generation FROM runs WHERE id = ?').get(this.runId);

    if (!row || row.owner_token !== this.ownerToken || row.owner_generation !== this.generation) {
      throw new LeaseLostError();
    }
  }

  // incrementing the ownership generation invalidates every attempt host started under the previous owner
  acquireLease({ token, leaseMs, allowSteal = false }) {
    return this.tx(() => {
      const now = this.clock.now();
      const row = this.run();

      if (!allowSteal && row.owner_token && row.owner_token !== token && row.lease_expires_at > now) {
        throw new OrchestratorError(
          'lease',
          `run ${row.id} is owned by a live supervisor until ${new Date(row.lease_expires_at).toISOString()}`,
        );
      }

      const generation = row.owner_generation + 1;

      this.update('runs', 'id', row.id, {
        owner_token: token,
        owner_generation: generation,
        lease_expires_at: now + leaseMs,
        status: 'active',
        updated_at: this.isoNow(),
      });

      this.ownerToken = token;
      this.generation = generation;

      this.appendEvent('lease.acquired', {
        data: {
          generation,
          previousOwnerExpired: Boolean(row.owner_token) && row.lease_expires_at <= now,
          previousGeneration: row.owner_generation,
        },
      });

      return {
        generation,
        previous: { token: row.owner_token, expiresAt: row.lease_expires_at, generation: row.owner_generation },
      };
    });
  }

  renewLease(leaseMs) {
    this.ownerTx(() => {
      this.db.prepare('UPDATE runs SET lease_expires_at = ? WHERE id = ?').run(this.clock.now() + leaseMs, this.runId);
    });
  }

  releaseLease() {
    try {
      this.ownerTx(() => {
        this.db.prepare('UPDATE runs SET lease_expires_at = 0, owner_token = NULL WHERE id = ?').run(this.runId);
        this.appendEvent('lease.released', { data: { generation: this.generation } });
      });
    } catch (error) {
      if (!(error instanceof LeaseLostError)) {
        throw error;
      }
    }
  }

  insert(table, fields) {
    const row = dehydrate(fields);
    const keys = Object.keys(row);

    return this.db
      .prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
      .run(...keys.map((key) => row[key]));
  }

  update(table, keyColumn, key, fields) {
    const row = dehydrate(fields);
    const keys = Object.keys(row);

    if (keys.length === 0) {
      return;
    }

    this.db
      .prepare(`UPDATE ${table} SET ${keys.map((name) => `${name} = ?`).join(', ')} WHERE ${keyColumn} = ?`)
      .run(...keys.map((name) => row[name]), key);
  }

  appendEvent(type, { taskId = null, attemptId = null, data = null } = {}) {
    const result = this.db
      .prepare('INSERT INTO events (at, type, task_id, attempt_id, data_json) VALUES (?, ?, ?, ?, ?)')
      .run(this.isoNow(), type, taskId, attemptId, data === null ? null : JSON.stringify(data));

    return Number(result.lastInsertRowid);
  }

  run() {
    return hydrate(this.db.prepare('SELECT * FROM runs WHERE id = ?').get(this.runId));
  }

  tasks() {
    return this.db
      .prepare('SELECT * FROM tasks ORDER BY ord')
      .all()
      .map((row) => hydrate(row));
  }

  task(id) {
    return hydrate(this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
  }

  dependencies(taskId) {
    return this.db
      .prepare('SELECT dep_id FROM task_deps WHERE task_id = ?')
      .all(taskId)
      .map((row) => row.dep_id);
  }

  attempts(taskId) {
    return this.db
      .prepare('SELECT * FROM attempts WHERE task_id = ? ORDER BY number')
      .all(taskId)
      .map((row) => hydrate(row));
  }

  attempt(id) {
    return hydrate(this.db.prepare('SELECT * FROM attempts WHERE id = ?').get(id));
  }

  // an attempt's input is recorded when its workspace is ready, just before its host starts
  launchedTaskIds() {
    const rows = this.db.prepare('SELECT DISTINCT task_id FROM attempts WHERE input_json IS NOT NULL').all();

    return new Set(rows.map((row) => row.task_id));
  }

  activeAttempts() {
    return this.db
      .prepare('SELECT * FROM attempts WHERE active = 1 ORDER BY created_at, id')
      .all()
      .map((row) => hydrate(row));
  }

  session(name) {
    return hydrate(this.db.prepare('SELECT * FROM sessions WHERE name = ?').get(name));
  }

  sessions() {
    return this.db
      .prepare('SELECT * FROM sessions ORDER BY created_at')
      .all()
      .map((row) => hydrate(row));
  }

  artifacts(attemptId) {
    return this.db
      .prepare('SELECT * FROM artifacts WHERE attempt_id = ? ORDER BY created_at')
      .all(attemptId)
      .map((row) => hydrate(row));
  }

  artifact(id) {
    return hydrate(this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id));
  }

  checks({ attemptId = null, scope = 'task' } = {}) {
    const rows =
      attemptId === null
        ? this.db.prepare('SELECT * FROM checks WHERE scope = ? ORDER BY id').all(scope)
        : this.db.prepare('SELECT * FROM checks WHERE attempt_id = ? ORDER BY id').all(attemptId);

    return rows.map((row) => hydrate(row));
  }

  events({ after = 0, limit = 500 } = {}) {
    return this.db
      .prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?')
      .all(after, limit)
      .map((row) => hydrate(row));
  }

  eventsOfType(type) {
    return this.db
      .prepare('SELECT * FROM events WHERE type = ? ORDER BY seq')
      .all(type)
      .map((row) => hydrate(row));
  }

  integrations() {
    return this.db
      .prepare('SELECT * FROM integrations ORDER BY id')
      .all()
      .map((row) => hydrate(row));
  }

  lastEventSeq() {
    return this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get().seq;
  }

  pendingControls() {
    return this.db
      .prepare("SELECT * FROM control_requests WHERE status = 'pending' ORDER BY id")
      .all()
      .map((row) => hydrate(row));
  }

  controls() {
    return this.db
      .prepare('SELECT * FROM control_requests ORDER BY id')
      .all()
      .map((row) => hydrate(row));
  }

  control(id) {
    return hydrate(this.db.prepare('SELECT * FROM control_requests WHERE id = ?').get(id));
  }

  latestIntegration() {
    return hydrate(this.db.prepare('SELECT * FROM integrations ORDER BY id DESC LIMIT 1').get());
  }

  latestCheckpoint(workflow) {
    return hydrate(
      this.db.prepare('SELECT * FROM checkpoints WHERE workflow = ? ORDER BY id DESC LIMIT 1').get(workflow),
    );
  }

  // callers must wrap the writes below in ownerTx

  insertTask(task) {
    const now = this.isoNow();

    this.insert('tasks', {
      id: task.id,
      ord: task.ord,
      step_key: task.stepKey ?? null,
      state: task.state ?? 'pending',
      spec_json: task.spec,
      session_name: task.sessionName ?? null,
      updated_at: now,
    });

    this.insertDependencies(task.id, task.dependsOn ?? []);
    this.appendEvent('task.created', { taskId: task.id, data: { state: task.state ?? 'pending' } });
  }

  insertDependencies(taskId, dependencies) {
    for (const dependency of dependencies) {
      this.insert('task_deps', { task_id: taskId, dep_id: dependency });
    }
  }

  /**
   * The expected current state guards against stale decisions, and the state version increments on
   * every transition so recovery decisions can name the version they observed.
   */
  transitionTask(taskId, from, to, fields = {}, data = null) {
    assertTransition(taskId, from, to);

    const result = this.db
      .prepare(
        'UPDATE tasks SET state = ?, state_version = state_version + 1, updated_at = ? WHERE id = ? AND state = ?',
      )
      .run(to, this.isoNow(), taskId, from);

    if (result.changes !== 1) {
      const current = this.task(taskId)?.state;

      throw new OrchestratorError('state', `task ${taskId}: expected state ${from}, found ${current}`);
    }

    this.update('tasks', 'id', taskId, fields);
    this.appendEvent('task.transition', { taskId, data: { from, to, ...data } });
  }

  updateTask(taskId, fields) {
    this.update('tasks', 'id', taskId, { ...fields, updated_at: this.isoNow() });
  }

  upsertSession({ name, adapter, profile, cwd }) {
    const existing = this.session(name);
    const now = this.isoNow();

    if (existing) {
      if (existing.adapter !== adapter) {
        throw new OrchestratorError('state', `session ${name} belongs to adapter ${existing.adapter}, not ${adapter}`);
      }

      return existing;
    }

    this.insert('sessions', {
      name,
      adapter,
      profile: profile ?? null,
      cwd: cwd ?? null,
      created_at: now,
      updated_at: now,
    });

    return this.session(name);
  }

  setSessionQuarantine(name, reason) {
    this.update('sessions', 'name', name, { quarantine: reason, updated_at: this.isoNow() });
    this.appendEvent(reason ? 'session.quarantined' : 'session.released', { data: { session: name, reason } });
  }

  recordProviderSession(name, providerSessionId) {
    const session = this.session(name);

    if (session && session.provider_session_id !== providerSessionId) {
      this.update('sessions', 'name', name, { provider_session_id: providerSessionId, updated_at: this.isoNow() });
      this.appendEvent('session.recorded', { data: { session: name, providerSessionId } });
    }
  }

  insertAttempt(fields) {
    this.insert('attempts', { ...fields, created_at: this.isoNow() });
  }

  updateAttempt(id, fields) {
    this.update('attempts', 'id', id, fields);
  }

  insertArtifact(fields) {
    this.insert('artifacts', { ...fields, created_at: this.isoNow() });
  }

  insertCheck(fields) {
    this.insert('checks', { ...fields, created_at: this.isoNow() });
  }

  insertIntegration(fields) {
    this.insert('integrations', { ...fields, created_at: this.isoNow() });
  }

  insertCheckpoint({ workflow, version, state, consumed }) {
    this.insert('checkpoints', {
      workflow,
      version,
      state_json: state,
      consumed_json: consumed,
      created_at: this.isoNow(),
    });
  }

  // control requests come from other processes, so they need no ownership
  enqueueControl({ kind, taskId = null, data = null }) {
    return this.tx(() => {
      const result = this.insert('control_requests', {
        at: this.isoNow(),
        kind,
        task_id: taskId,
        data_json: data,
      });

      return Number(result.lastInsertRowid);
    });
  }

  resolveControl(id, status, result) {
    this.update('control_requests', 'id', id, { status, applied_at: this.isoNow(), result });
  }
}
