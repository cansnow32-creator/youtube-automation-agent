const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { Database } = require('../database/db');

async function run() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'generation-finalization-lease-'));
  const database = Object.create(Database.prototype);
  database.dbPath = path.join(directory, 'finalization.sqlite');
  database.db = new sqlite3.Database(database.dbPath);
  database.db.configure('busyTimeout', 5000);
  const lease = { productionId: 'generation:job-finalize', owner: 'worker-current' };
  try {
    await database.executeQuery(`CREATE TABLE production_operation_locks (
      production_id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL
    )`);
    await database.executeQuery(`INSERT INTO production_operation_locks
      (production_id, owner, expires_at) VALUES (?, ?, ?)`,
      [lease.productionId, lease.owner, Date.now() + 60000]);
    await database.executeQuery(`CREATE TABLE productions (
      id TEXT PRIMARY KEY, status TEXT, assets TEXT, timeline TEXT,
      scheduled_publish_time TEXT, priority INTEGER, estimated_duration TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    await database.executeQuery(`INSERT INTO productions
      (id, status, assets, timeline, scheduled_publish_time, priority, estimated_duration)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['production-1', 'processing', '{}', JSON.stringify({ jobId: 'job-finalize' }),
        new Date(Date.now() + 60000).toISOString(), 50, 'short']);
    await database.executeQuery(`CREATE TABLE content_reviews (
      production_id TEXT PRIMARY KEY, status TEXT, editor_data TEXT,
      quality_checks TEXT, review_notes TEXT, reviewed_at TEXT, updated_at TEXT
    )`);
    await database.executeQuery(`CREATE TABLE publish_schedule (
      id TEXT PRIMARY KEY, production_id TEXT NOT NULL, title TEXT NOT NULL,
      publish_time TEXT NOT NULL, status TEXT, priority INTEGER, metadata TEXT,
      youtube_id TEXT, youtube_url TEXT, published_at TEXT, error_message TEXT,
      upload_started_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    const staleLease = { productionId: lease.productionId, owner: 'worker-stale' };
    await assert.rejects(
      database.updateProductionStatus('production-1', 'failed', staleLease),
      error => error.code === 'SCENE_EDIT_LEASE_LOST'
    );
    await assert.rejects(
      database.saveContentReview('production-1', { status: 'needs_attention' }, staleLease),
      error => error.code === 'SCENE_EDIT_LEASE_LOST'
    );
    await assert.rejects(
      database.saveScheduleEntry({
        productionId: 'production-1', title: 'Stale schedule',
        publishTime: new Date().toISOString(), status: 'scheduled',
        priority: 50, metadata: {}
      }, staleLease),
      error => error.code === 'SCENE_EDIT_LEASE_LOST'
    );
    await assert.rejects(
      database.saveDiscoverabilityAudit('production-1', 'youtube', {
        status: 'passed', findings: []
      }, staleLease),
      error => error.code === 'SCENE_EDIT_LEASE_LOST'
    );

    await database.updateProductionStatus('production-1', 'needs_review', lease);
    const status = await database.getRow('SELECT status FROM productions WHERE id = ?', ['production-1']);
    assert.equal(status.status, 'needs_review');

    const schedule = await database.saveScheduleEntry({
      productionId: 'production-1', title: 'Current worker schedule',
      publishTime: new Date(Date.now() + 60000).toISOString(), status: 'scheduled',
      priority: 50, metadata: {}
    }, lease);
    assert.ok(schedule.id);
    const rows = await database.getRow('SELECT COUNT(*) AS count FROM publish_schedule');
    assert.equal(Number(rows.count), 1, 'only the current generation lease may create the schedule row');

    const reviewRows = await database.getRow('SELECT COUNT(*) AS count FROM content_reviews');
    assert.equal(Number(reviewRows.count), 0, 'a stale worker cannot write a content review');
    process.stdout.write('Generation finalization lease tests passed\\n');
  } finally {
    await new Promise((resolve, reject) => database.db.close(error => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
