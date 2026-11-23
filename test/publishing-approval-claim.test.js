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
    await database.executeQuery(`CREATE TABLE readiness_runs (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, checks TEXT NOT NULL, summary TEXT NOT NULL,
      started_at TEXT NOT NULL, completed_at TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    const addReadiness = (id, status = 'passed', checks = [], completedAt = new Date().toISOString()) =>
      database.executeQuery(
        'INSERT INTO readiness_runs (id, status, checks, summary, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?)',
        [id, status, typeof checks === 'string' ? checks : JSON.stringify(checks), '{}', completedAt, completedAt]
      );
    await addReadiness('readiness-initial', 'passed', [], new Date(Date.now() - 10000).toISOString());

    const insertSchedule = async (id, productionId, shortClipId = null, sourceProductionId = null) => database.executeQuery(
      `INSERT INTO publish_schedule (id, production_id, title, publish_time, status, metadata)
       VALUES (?, ?, 'Test', ?, 'scheduled', ?)`,
      [id, productionId, new Date(Date.now() + 3600000).toISOString(),
        shortClipId ? JSON.stringify({ contentType: 'short', shortClipId, sourceProductionId }) : '{}']
    );

    await insertSchedule('no-readiness', 'production-no-readiness');
    await database.executeQuery(
      'INSERT INTO content_reviews (production_id, status) VALUES (?, ?)',
      ['production-no-readiness', 'approved']
    );
    await database.executeQuery('DELETE FROM readiness_runs');
    assert.equal(await database.claimScheduleEntryForUpload('no-readiness'), null,
      'upload must fail closed when no production readiness run exists');
    await addReadiness('readiness-initial-restored', 'passed', [], new Date(Date.now() - 10000).toISOString());

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
    await addReadiness('readiness-newer-failed', 'failed', [
      { id: 'video_assembly', blocking: true, status: 'failed' }
    ], new Date(Date.now() - 9000).toISOString());
    assert.equal(await database.claimScheduleEntryForUpload('unapproved-production'), null,
      'the newest failed readiness run must block upload even when an older run passed');
    await addReadiness('readiness-restored', 'passed', [], new Date(Date.now() - 8000).toISOString());
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
    await database.executeQuery(
      'INSERT INTO production_operation_locks (production_id, owner, expires_at) VALUES (?, ?, ?)',
      ['production-2', 'active-review', Date.now() + 60000]
    );
    assert.equal(await database.claimScheduleEntryForUpload('unapproved-short'), null,
      'an active source production review/edit lease must block the Short upload claim');
    await database.executeQuery("DELETE FROM production_operation_locks WHERE production_id = 'production-2'");
    const approvedShort = await database.claimScheduleEntryForUpload('unapproved-short');
    assert.equal(approvedShort.status, 'uploading',
      'a Short with explicit approval and verified inherited evidence may be claimed');
    assert.ok(approvedShort.uploadAttemptId);

    await insertSchedule('no-approval-evidence', 'production-3');
    assert.equal(await database.claimScheduleEntryForUpload('no-approval-evidence'), null,
      'a schedule without a matching approved production or Short must fail closed');
    await database.executeQuery(
      'INSERT INTO content_reviews (production_id, status) VALUES (?, ?)',
      ['production-3', 'approved']
    );

    await database.executeQuery(
      'INSERT INTO content_reviews (production_id, status) VALUES (?, ?)',
      ['production-4', 'approved']
    );
    await insertSchedule('stale-readiness', 'production-4');
    await database.executeQuery('DELETE FROM readiness_runs');
    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await addReadiness('readiness-stale', 'passed', [], staleTime);
    assert.equal(await database.claimScheduleEntryForUpload('stale-readiness'), null,
      'a readiness run older than 24 hours must block upload');
    await addReadiness('readiness-fresh-after-stale', 'passed', [], new Date(Date.now() - 5000).toISOString());
    const freshAfterStale = await database.claimScheduleEntryForUpload('stale-readiness');
    assert.equal(freshAfterStale.status, 'uploading',
      'a fresh readiness run should restore upload eligibility');
    await insertSchedule('malformed-readiness', 'production-3');
    await addReadiness('readiness-malformed', 'passed', '{not-json}', new Date(Date.now() - 2000).toISOString());
    assert.equal(await database.claimScheduleEntryForUpload('malformed-readiness'), null,
      'malformed readiness evidence must fail closed without breaking the claim query');

    await addReadiness('readiness-warning', 'warning', [], new Date(Date.now() - 1000).toISOString());
    const warningReadinessClaim = await database.claimScheduleEntryForUpload('malformed-readiness');
    assert.equal(warningReadinessClaim.status, 'uploading',
      'a fresh warning readiness run without blocking failures may allow upload');

    await database.executeQuery(
      'INSERT INTO content_reviews (production_id, status) VALUES (?, ?)',
      ['production-5', 'approved']
    );
    await insertSchedule('tied-readiness', 'production-5');
    const tiedTime = new Date(Date.now() - 100).toISOString();
    await addReadiness('readiness-tied-failed', 'failed', [
      { id: 'video_assembly', blocking: true, status: 'failed' }
    ], tiedTime);
    await addReadiness('readiness-tied-passed', 'passed', [], tiedTime);
    const tiedReadinessClaim = await database.claimScheduleEntryForUpload('tied-readiness');
    assert.equal(tiedReadinessClaim.status, 'uploading',
      'when readiness timestamps tie, the latest inserted run must determine upload eligibility');

    process.stdout.write('Publishing approval claim tests passed\n');
  } finally {
    await new Promise((resolve, reject) => database.db.close(error => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

run().catch(error => {
  process.stderr.write(`Publishing approval claim tests failed: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
