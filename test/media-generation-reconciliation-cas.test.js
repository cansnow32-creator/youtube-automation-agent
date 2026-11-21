const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { Database } = require('../database/db');

async function run() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'media-reconciliation-cas-'));
  const database = Object.create(Database.prototype);
  database.dbPath = path.join(directory, 'media.sqlite');
  database.db = new sqlite3.Database(database.dbPath);
  database.db.configure('busyTimeout', 5000);

  try {
    await database.executeQuery(`CREATE TABLE production_operation_locks (
      production_id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL
    )`);
    await database.executeQuery(`CREATE TABLE media_generation_tasks (
      id TEXT PRIMARY KEY, job_id TEXT, production_id TEXT, scene_index INTEGER NOT NULL,
      provider TEXT NOT NULL, model TEXT NOT NULL, external_task_id TEXT,
      status TEXT DEFAULT 'submitting', request TEXT NOT NULL DEFAULT '{}',
      provider_data TEXT NOT NULL DEFAULT '{}', output_path TEXT, error TEXT,
      completed_at TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    const insertTask = async (id, jobId, productionId) => database.executeQuery(
      `INSERT INTO media_generation_tasks
       (id, job_id, production_id, scene_index, provider, model, status, request, provider_data)
       VALUES (?, ?, ?, 0, 'test-provider', 'test-model', 'submission_unknown', '{}', '{}')`,
      [id, jobId, productionId]
    );
    await insertTask('manual-task', 'job-manual', 'production-manual');
    const manual = await database.compareAndSetMediaGenerationTask(
      'manual-task', 'submission_unknown', null,
      { externalTaskId: 'remote-manual', status: 'queued', error: null }
    );
    assert.equal(manual.updated, true, 'operator reconciliation can attach a remote ID when no worker owns the task');
    assert.equal(manual.task.external_task_id, 'remote-manual');
    assert.equal(manual.task.status, 'queued');

    await insertTask('locked-task', 'job-locked', 'production-locked');
    await database.executeQuery(
      'INSERT INTO production_operation_locks (production_id, owner, expires_at) VALUES (?, ?, ?)',
      ['generation:job-locked', 'active-worker', Date.now() + 60000]
    );
    await assert.rejects(
      database.compareAndSetMediaGenerationTask(
        'locked-task', 'submission_unknown', null,
        { externalTaskId: 'must-not-attach', status: 'queued' }
      ),
      error => error.code === 'MEDIA_TASK_LEASE_ACTIVE' && error.status === 409
    );
    assert.equal((await database.getMediaGenerationTaskById('locked-task')).external_task_id, null,
      'manual reconciliation cannot race an active generation worker');

    const wrongLease = { productionId: 'generation:job-other', owner: 'other-worker' };
    await database.executeQuery(
      'INSERT INTO production_operation_locks (production_id, owner, expires_at) VALUES (?, ?, ?)',
      [wrongLease.productionId, wrongLease.owner, Date.now() + 60000]
    );
    await assert.rejects(
      database.compareAndSetMediaGenerationTask(
        'locked-task', 'submission_unknown', null,
        { externalTaskId: 'cross-job', status: 'queued' }, wrongLease
      ),
      error => error.code === 'GENERATION_JOB_LEASE_INVALID' && error.status === 409
    );

    const correctLease = { productionId: 'generation:job-locked', owner: 'active-worker' };
    const owned = await database.compareAndSetMediaGenerationTask(
      'locked-task', 'submission_unknown', null,
      { externalTaskId: 'remote-locked', status: 'queued' }, correctLease
    );
    assert.equal(owned.updated, true, 'the exact active job lease can perform its own CAS');
    assert.equal(owned.task.external_task_id, 'remote-locked');

    const stale = await database.compareAndSetMediaGenerationTask(
      'locked-task', 'submission_unknown', null,
      { externalTaskId: 'stale-overwrite', status: 'queued' }, correctLease
    );
    assert.equal(stale.updated, false, 'stale expected state cannot overwrite a reconciled task');
    assert.equal(stale.task.external_task_id, 'remote-locked');
    process.stdout.write('Media reconciliation CAS tests passed\\n');
  } finally {
    await new Promise((resolve, reject) => database.db.close(error => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

run().catch(error => {
  process.stderr.write(`Media reconciliation CAS tests failed: ${error.stack || error.message}\\n`);
  process.exitCode = 1;
});
