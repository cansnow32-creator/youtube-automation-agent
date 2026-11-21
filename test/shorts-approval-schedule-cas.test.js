const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { Database } = require('../database/db');

async function run() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'short-approval-schedule-'));
  const database = Object.create(Database.prototype);
  database.dbPath = path.join(directory, 'shorts.sqlite');
  database.db = new sqlite3.Database(database.dbPath);
  database.db.configure('busyTimeout', 5000);
  const lease = { productionId: 'production-source', owner: 'approval-current' };
  try {
    await database.executeQuery(`CREATE TABLE production_operation_locks (
      production_id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL
    )`);
    await database.executeQuery(`INSERT INTO production_operation_locks
      (production_id, owner, expires_at) VALUES (?, ?, ?)`,
      [lease.productionId, lease.owner, Date.now() + 60000]);
    await database.executeQuery(`CREATE TABLE productions (
      id TEXT PRIMARY KEY, status TEXT, assets TEXT, timeline TEXT,
      scheduled_publish_time TEXT, priority INTEGER, estimated_duration TEXT
    )`);
    await database.executeQuery(`INSERT INTO productions (id, status, assets, timeline)
      VALUES (?, 'ready', '{}', '{}')`, [lease.productionId]);
    await database.executeQuery(`CREATE TABLE publish_schedule (
      id TEXT PRIMARY KEY, production_id TEXT NOT NULL, title TEXT NOT NULL,
      publish_time TEXT NOT NULL, status TEXT, priority INTEGER, metadata TEXT,
      youtube_id TEXT, youtube_url TEXT, published_at TEXT, error_message TEXT,
      upload_started_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    await database.executeQuery(`CREATE TABLE shorts_clips (
      id TEXT PRIMARY KEY, production_id TEXT NOT NULL, position INTEGER NOT NULL,
      title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
      source_scene_ids TEXT NOT NULL DEFAULT '[]', start_seconds REAL NOT NULL DEFAULT 0,
      duration REAL NOT NULL DEFAULT 30, layout TEXT NOT NULL DEFAULT 'blur', rationale TEXT,
      status TEXT NOT NULL DEFAULT 'proposed', output_path TEXT, captions_path TEXT,
      publish_time TEXT, privacy_status TEXT DEFAULT 'private', inherited_evidence TEXT NOT NULL DEFAULT '{}',
      rendered_at TEXT, approved_at TEXT, schedule_id TEXT, youtube_id TEXT, youtube_url TEXT,
      error TEXT, render_attempt_id TEXT, render_metadata TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(production_id, position)
    )`);
    await database.executeQuery(`INSERT INTO shorts_clips
      (id, production_id, position, title, status, output_path, rendered_at)
      VALUES ('short-1', 'production-source', 0, 'Approved Short', 'rendered', '/tmp/short.mp4', datetime('now'))`);

    const staleLease = { productionId: lease.productionId, owner: 'approval-stale' };
    const entry = {
      productionId: 'short-1', title: 'Approved Short',
      publishTime: new Date(Date.now() + 60000).toISOString(),
      status: 'scheduled', priority: 60, metadata: { contentType: 'short' }
    };
    await assert.rejects(
      database.saveScheduleEntry({ ...entry }, staleLease, 'production-source'),
      error => error.code === 'SCENE_EDIT_LEASE_LOST'
    );
    const scheduleCount = await database.getRow('SELECT COUNT(*) AS count FROM publish_schedule');
    assert.equal(Number(scheduleCount.count), 0, 'a stale approval cannot create a Short schedule');

    const schedule = await database.saveScheduleEntry({ ...entry }, lease, 'production-source');
    const staleClaim = await database.claimShortClipForSchedule(
      'short-1', 'production-source', schedule.id,
      { publishTime: entry.publishTime, privacyStatus: 'private', inheritedEvidence: { ready: true } },
      staleLease
    );
    assert.rejects(Promise.resolve(staleClaim), error => error.code === 'SCENE_EDIT_LEASE_LOST');
  } finally {
    await new Promise((resolve, reject) => database.db.close(error => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
