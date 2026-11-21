const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { Database } = require('../database/db');

async function run() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'publishing-approval-claim-'));
  const database = Object.create(Database.prototype);
  database.dbPath = path.join(directory, 'publishing.sqlite');
  database.db = new sqlite3.Database(database.dbPath);
  database.db.configure('busyTimeout', 5000);
  let nextId = 0;
  database.generateId = prefix => `${prefix}-${++nextId}`;

  try {
    await database.executeQuery(`CREATE TABLE publish_schedule (
      id TEXT PRIMARY KEY, production_id TEXT NOT NULL, title TEXT NOT NULL,
      publish_time TEXT NOT NULL, status TEXT DEFAULT 'scheduled', priority INTEGER DEFAULT 50,
      metadata TEXT, youtube_id TEXT, youtube_url TEXT, published_at TEXT,
      error_message TEXT, upload_started_at TEXT, upload_attempt_id TEXT
    )`);
    await database.executeQuery(`CREATE TABLE content_reviews (
      production_id TEXT PRIMARY KEY, status TEXT DEFAULT 'needs_review'
    )`);
    await database.executeQuery(`CREATE TABLE shorts_clips (
      id TEXT PRIMARY KEY, production_id TEXT NOT NULL, schedule_id TEXT,
      status TEXT NOT NULL, approved_at TEXT, inherited_evidence TEXT NOT NULL DEFAULT '{}'
    )`);

    const insertSchedule = async (id, productionId, shortClipId = null, sourceProductionId = null) => database.executeQuery(
      `INSERT INTO publish_schedule (id, production_id, title, publish_time, status, metadata)
       VALUES (?, ?, 'Test', ?, 'scheduled', ?)`,
      [id, productionId, new Date(Date.now() + 3600000).toISOString(),
        shortClipId ? JSON.stringify({ contentType: 'short', shortClipId, sourceProductionId }) : '{}']
    );

    await insertSchedule('unapproved-production', 'production-1');
    await database.executeQuery(
      'INSERT INTO content_reviews (production_id, status) VALUES (?, ?)',
      ['production-1', 'pending']
    );
    assert.equal(await database.claimScheduleEntryForUpload('unapproved-production'), null,
      'a pending production review must block the durable upload claim');

    await database.executeQuery(
      "UPDATE content_reviews SET status = 'approved' WHERE production_id = 'production-1'"
    );
    const approvedProduction = await database.claimScheduleEntryForUpload('unapproved-production');
    assert.equal(approvedProduction.status, 'uploading');
    assert.ok(approvedProduction.uploadAttemptId);

    await database.executeQuery(
      'INSERT INTO content_reviews (production_id, status) VALUES (?, ?)',
      ['production-2', 'approved']
    );
    await insertSchedule('unapproved-short', 'short-2', 'short-2', 'production-2');
    await database.executeQuery(
      `INSERT INTO shorts_clips (id, production_id, schedule_id, status, approved_at, inherited_evidence)
       VALUES ('short-2', 'production-2', 'unapproved-short', 'scheduled', NULL, '{"ready":true}')`
    );
    assert.equal(await database.claimScheduleEntryForUpload('unapproved-short'), null,
      'a Short without explicit approval timestamp must not be claimed');

    await database.executeQuery(
      "UPDATE shorts_clips SET approved_at = datetime('now') WHERE id = 'short-2'"
    );
    await database.executeQuery(
      "UPDATE content_reviews SET status = 'needs_review' WHERE production_id = 'production-2'"
    );
    assert.equal(await database.claimScheduleEntryForUpload('unapproved-short'), null,
      'a Short approval must not outlive revocation of its source production approval');

    await database.executeQuery(
      "UPDATE content_reviews SET status = 'approved' WHERE production_id = 'production-2'"
    );
    const approvedShort = await database.claimScheduleEntryForUpload('unapproved-short');
    assert.equal(approvedShort.status, 'uploading',
      'a Short with explicit approval and verified inherited evidence may be claimed');
    assert.ok(approvedShort.uploadAttemptId);

    await insertSchedule('no-approval-evidence', 'production-3');
    assert.equal(await database.claimScheduleEntryForUpload('no-approval-evidence'), null,
      'a schedule without a matching approved production or Short must fail closed');
    process.stdout.write('Publishing approval claim tests passed\\n');
  } finally {
    await new Promise((resolve, reject) => database.db.close(error => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

run().catch(error => {
  process.stderr.write(`Publishing approval claim tests failed: ${error.stack || error.message}\\n`);
  process.exitCode = 1;
});
