const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { Database } = require('../database/db');

async function run() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'generation-job-lease-scope-'));
  const database = Object.create(Database.prototype);
  database.dbPath = path.join(directory, 'jobs.sqlite');
  database.db = new sqlite3.Database(database.dbPath);
  database.db.configure('busyTimeout', 5000);

  const lease = { productionId: 'generation:job-1', owner: 'worker-job-1' };
  try {
    await database.executeQuery(`CREATE TABLE production_operation_locks (
      production_id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL
    )`);
    await database.executeQuery(
      'INSERT INTO production_operation_locks (production_id, owner, expires_at) VALUES (?, ?, ?)',
      [lease.productionId, lease.owner, Date.now() + 60000]
    );
    await database.executeQuery(`CREATE TABLE generation_jobs (
      id TEXT PRIMARY KEY, topic TEXT, style TEXT, length TEXT, source TEXT,
      status TEXT, stage TEXT, progress INTEGER, production_id TEXT, title TEXT,
      error TEXT, details TEXT, cancel_requested INTEGER, updated_at TEXT, completed_at TEXT
    )`);
    await database.executeQuery(`CREATE TABLE generation_checkpoints (
      job_id TEXT NOT NULL, stage TEXT NOT NULL, status TEXT, artifact TEXT,
      attempt_count INTEGER DEFAULT 0, error TEXT, started_at TEXT, completed_at TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(job_id, stage)
    )`);
    for (const id of ['job-1', 'job-2']) {
      await database.executeQuery(
        'INSERT INTO generation_jobs (id, status, stage, progress, details, cancel_requested) VALUES (?, ?, ?, ?, ?, 0)',
        [id, 'queued', 'queued', 0, '{}']
      );
      await database.saveGenerationCheckpoint(id, 'strategy', {
        status: 'completed', artifact: { topic: id }
      });
    }

    await assert.rejects(
      database.updateGenerationJob('job-2', { status: 'failed', error: 'cross-job write' }, lease),
      error => error.code === 'GENERATION_JOB_LEASE_INVALID' && error.status === 409
    );
    await assert.rejects(
      database.saveGenerationCheckpoint('job-2', 'strategy', {
        status: 'failed', error: 'cross-job checkpoint overwrite'
      }, lease),
      error => error.code === 'GENERATION_JOB_LEASE_INVALID' && error.status === 409
    );
    await assert.rejects(
      database.deleteGenerationCheckpoints('job-2', ['strategy'], lease),
      error => error.code === 'GENERATION_JOB_LEASE_INVALID' && error.status === 409
    );

    const untouchedJob = await database.getGenerationJob('job-2');
    const untouchedCheckpoint = await database.getGenerationCheckpoint('job-2', 'strategy');
    assert.equal(untouchedJob.status, 'queued', 'a job lease cannot mutate another generation job');
    assert.equal(untouchedCheckpoint.status, 'completed', 'a job lease cannot overwrite another job checkpoint');
    assert.deepEqual(untouchedCheckpoint.artifact, { topic: 'job-2' }, 'cross-job checkpoint artifact remains intact');

    await database.updateGenerationJob('job-1', { status: 'running', stage: 'strategy', progress: 10 }, lease);
    await database.saveGenerationCheckpoint('job-1', 'strategy', {
      status: 'completed', artifact: { topic: 'job-1-updated' }
    }, lease);
    await database.deleteGenerationCheckpoints('job-1', ['strategy'], lease);
    assert.equal((await database.getGenerationJob('job-1')).status, 'running');
    assert.equal(await database.getGenerationCheckpoint('job-1', 'strategy'), null);

    const alternateLease = { productionId: 'job:job-2', owner: 'worker-job-2' };
    await database.executeQuery(
      'INSERT INTO production_operation_locks (production_id, owner, expires_at) VALUES (?, ?, ?)',
      [alternateLease.productionId, alternateLease.owner, Date.now() + 60000]
    );
    await database.updateGenerationJob('job-2', { status: 'running' }, alternateLease);
    assert.equal((await database.getGenerationJob('job-2')).status, 'running',
      'the production manager job:<id> lease remains valid for its own generation job');
    process.stdout.write('Generation job lease scope tests passed\\n');
  } finally {
    await new Promise((resolve, reject) => database.db.close(error => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

run().catch(error => {
  process.stderr.write(`Generation job lease scope tests failed: ${error.stack || error.message}\\n`);
  process.exitCode = 1;
});
