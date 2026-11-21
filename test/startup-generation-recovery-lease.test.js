const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { Database } = require('../database/db');

async function run() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'startup-generation-recovery-'));
  const database = Object.create(Database.prototype);
  database.dbPath = path.join(directory, 'startup.sqlite');
  database.db = new sqlite3.Database(database.dbPath);
  database.db.configure('busyTimeout', 5000);

  try {
    await database.executeQuery(`CREATE TABLE generation_jobs (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, error TEXT,
      updated_at TEXT, completed_at TEXT
    )`);
    await database.executeQuery(`CREATE TABLE operator_runs (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, stage TEXT,
      error TEXT, updated_at TEXT, completed_at TEXT
    )`);
    await database.executeQuery(`CREATE TABLE production_operation_locks (
      production_id TEXT PRIMARY KEY, owner TEXT NOT NULL,
      expires_at INTEGER NOT NULL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    for (const [id, status] of [
      ['active-generation', 'running'],
      ['active-production-manager', 'queued'],
      ['expired-lease', 'running'],
      ['unleased-job', 'queued']
    ]) {
      await database.executeQuery(
        'INSERT INTO generation_jobs (id, status) VALUES (?, ?)', [id, status]
      );
    }
    const now = Date.now();
    await database.executeQuery(
      'INSERT INTO production_operation_locks (production_id, owner, expires_at) VALUES (?, ?, ?)',
      ['generation:active-generation', 'worker-a', now + 60000]
    );
    await database.executeQuery(
      'INSERT INTO production_operation_locks (production_id, owner, expires_at) VALUES (?, ?, ?)',
      ['job:active-production-manager', 'worker-b', now + 60000]
    );
    await database.executeQuery(
      'INSERT INTO production_operation_locks (production_id, owner, expires_at) VALUES (?, ?, ?)',
      ['generation:expired-lease', 'old-worker', now - 1000]
    );
    await database.executeQuery(
      "INSERT INTO operator_runs (id, status, stage) VALUES ('operator-1', 'running', 'research'), ('operator-2', 'queued', 'queued')"
    );
    await database.executeQuery(
      'INSERT INTO production_operation_locks (production_id, owner, expires_at) VALUES (?, ?, ?)',
      ['operator:active', 'operator-worker', now + 60000]
    );

    await database.markInterruptedJobs();

    const status = async id => (await database.getRow(
      'SELECT status FROM generation_jobs WHERE id = ?', [id]
    )).status;
    assert.equal(await status('active-generation'), 'running',
      'startup recovery must preserve a job with an active generation lease');
    assert.equal(await status('active-production-manager'), 'queued',
      'startup recovery must preserve a job with an active job:<id> lease');
    assert.equal(await status('expired-lease'), 'interrupted',
      'an expired lease does not protect a stale job');
    assert.equal(await status('unleased-job'), 'interrupted',
      'an unleased queued job is recovered as interrupted');
    const activeOperator = await database.getRow('SELECT status, stage FROM operator_runs WHERE id = ?', ['operator-1']);
    assert.equal(activeOperator.status, 'running',
      'startup recovery must preserve an operator run with a live cross-process lease');
    const staleOperator = await database.getRow('SELECT status, stage FROM operator_runs WHERE id = ?', ['operator-2']);
    assert.equal(staleOperator.status, 'interrupted',
      'startup recovery must interrupt an operator run without a live lease');
    assert.equal(staleOperator.stage, 'interrupted');
    process.stdout.write('Startup generation recovery lease tests passed\\n');
  } finally {
    await new Promise((resolve, reject) => database.db.close(error => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

run().catch(error => {
  process.stderr.write(`Startup generation recovery lease tests failed: ${error.stack || error.message}\\n`);
  process.exitCode = 1;
});
