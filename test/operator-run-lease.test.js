const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { Database } = require('../database/db');

async function run() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-run-lease-'));
  const database = Object.create(Database.prototype);
  database.dbPath = path.join(directory, 'operator.sqlite');
  database.db = new sqlite3.Database(database.dbPath);
  database.db.configure('busyTimeout', 5000);

  try {
    await database.executeQuery(`CREATE TABLE operator_runs (
      id TEXT PRIMARY KEY, strategy_id TEXT NOT NULL, status TEXT DEFAULT 'queued',
      stage TEXT DEFAULT 'queued', progress INTEGER DEFAULT 0, research TEXT,
      plan TEXT, generated_jobs TEXT, summary TEXT, error TEXT,
      cancel_requested INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP, completed_at TEXT
    )`);
    await database.executeQuery(`CREATE TABLE production_operation_locks (
      production_id TEXT PRIMARY KEY, owner TEXT NOT NULL,
      expires_at INTEGER NOT NULL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    await database.executeQuery(
      `INSERT INTO operator_runs (id, strategy_id, research, plan, generated_jobs, summary)
       VALUES ('run-1', 'strategy-1', '{}', '[]', '[]', '{}')`
    );

    const now = Date.now();
    await database.executeQuery(
      'INSERT INTO production_operation_locks (production_id, owner, expires_at) VALUES (?, ?, ?)',
      ['operator:active', 'worker-a', now + 60000]
    );

    await assert.rejects(
      database.updateOperatorRun('run-1', { status: 'completed' }),
      error => error.code === 'OPERATOR_LEASE_ACTIVE',
      'a process without the active lease must not overwrite an operator run'
    );

    const cancellation = await database.updateOperatorRun('run-1', {
      status: 'cancelling', cancelRequested: true
    });
    assert.equal(cancellation.status, 'cancelling');
    assert.equal(cancellation.cancelRequested, true,
      'a separate process may request cooperative cancellation without owning the lease');

    await assert.rejects(
      database.updateOperatorRun('run-1', { status: 'completed' }, {
        productionId: 'operator:active', owner: 'stale-worker'
      }),
      error => error.code === 'SCENE_EDIT_LEASE_LOST',
      'a stale owner must not write operator state'
    );

    const saved = await database.updateOperatorRun('run-1', {
      status: 'running', stage: 'researching', progress: 5
    }, { productionId: 'operator:active', owner: 'worker-a' });
    assert.equal(saved.status, 'running');
    assert.equal(saved.stage, 'researching');

    await database.executeQuery(
      'UPDATE production_operation_locks SET expires_at = ? WHERE production_id = ?',
      [Date.now() - 1000, 'operator:active']
    );
    const afterExpiry = await database.updateOperatorRun('run-1', { status: 'interrupted' });
    assert.equal(afterExpiry.status, 'interrupted',
      'an expired operator lease must not permanently block recovery');
    process.stdout.write('Operator run lease tests passed\\n');
  } finally {
    await new Promise((resolve, reject) => database.db.close(error => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

run().catch(error => {
  process.stderr.write(`Operator run lease tests failed: ${error.stack || error.message}\\n`);
  process.exitCode = 1;
});
