const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { Database } = require('../database/db');

async function close(db) {
  await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
}

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'publish-claim-cas-'));
  const dbA = Object.create(Database.prototype);
  const dbB = Object.create(Database.prototype);
  dbA.db = new sqlite3.Database(path.join(directory, 'schedule.sqlite'));
  dbB.db = new sqlite3.Database(path.join(directory, 'schedule.sqlite'));
  dbA.db.configure('busyTimeout', 5000);
  dbB.db.configure('busyTimeout', 5000);
  try {
    await dbA.executeQuery(`CREATE TABLE publish_schedule (
      id TEXT PRIMARY KEY, production_id TEXT NOT NULL, title TEXT NOT NULL,
      publish_time TEXT NOT NULL, status TEXT, priority INTEGER, metadata TEXT,
      youtube_id TEXT, youtube_url TEXT, published_at TEXT, error_message TEXT, upload_started_at TEXT, upload_attempt_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    await dbA.executeQuery(`CREATE TABLE content_reviews (
      production_id TEXT PRIMARY KEY, status TEXT NOT NULL
    )`);
    await dbA.executeQuery(`CREATE TABLE readiness_runs (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, checks TEXT NOT NULL, summary TEXT NOT NULL,
      started_at TEXT NOT NULL, completed_at TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    const readinessTime = new Date().toISOString();
    await dbA.executeQuery(
      'INSERT INTO readiness_runs (id, status, checks, summary, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['readiness-cas', 'passed', '[]', '{}', readinessTime, readinessTime]
    );
    await dbA.executeQuery(
      "INSERT INTO content_reviews (production_id, status) VALUES ('production-race', 'approved')"
    );
    const scheduleDraft = suffix => ({
      productionId: 'production-race',
      title: `Concurrent schedule ${suffix}`,
      publishTime: new Date(Date.now() + 120000).toISOString(),
      status: 'scheduled',
      priority: 50,
      metadata: { source: suffix }
    });
    const concurrentSaves = await Promise.all([
      dbA.saveScheduleEntry(scheduleDraft('A')),
      dbB.saveScheduleEntry(scheduleDraft('B'))
    ]);
    assert.equal(concurrentSaves[0].id, concurrentSaves[1].id,
      'concurrent schedule creation must return the same durable schedule row');
    const duplicateSchedules = await dbA.getRow(
      'SELECT COUNT(*) AS count FROM publish_schedule WHERE production_id = ?',
      ['production-race']
    );
    assert.equal(duplicateSchedules.count, 1,
      'only one schedule row may be created for a production even across SQLite connections');

    await dbA.executeQuery(
      "INSERT INTO publish_schedule (id, production_id, title, publish_time, status, priority, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ['schedule-1', 'short-1', 'Short title', new Date(Date.now() + 60000).toISOString(), 'scheduled', 60, JSON.stringify({ shortClipId: 'short-1' })]
    );
    await dbA.executeQuery(
      "INSERT INTO content_reviews (production_id, status) VALUES ('short-1', 'approved')"
    );

    const claims = await Promise.all([
      dbA.claimScheduleEntryForUpload('schedule-1'),
      dbB.claimScheduleEntryForUpload('schedule-1')
    ]);
    assert.equal(claims.filter(Boolean).length, 1, 'only one SQLite connection may claim a scheduled upload');
    const winner = claims.find(Boolean);
    const firstAttemptId = winner.uploadAttemptId;
    assert.ok(firstAttemptId, 'the claim returns a unique upload-attempt fencing token');
    assert.equal(winner.status, 'uploading');
    assert.equal(winner.productionId, 'short-1');
    assert.ok(winner.uploadStartedAt, 'the atomic claim records when the upload attempt began');
    const persisted = await dbA.getLatestScheduleEntry('short-1');
    assert.equal(persisted.status, 'uploading');

    const duplicate = await dbB.claimScheduleEntryForUpload('schedule-1');
    assert.equal(duplicate, null, 'an uploading schedule cannot be claimed a second time');

    await dbA.executeQuery("UPDATE publish_schedule SET status = 'reconciliation_required' WHERE id = ?", ['schedule-1']);
    const uncertain = await dbB.claimScheduleEntryForUpload('schedule-1');
    assert.equal(uncertain, null, 'an uncertain upload must never be automatically retried');

    await dbA.executeQuery("UPDATE publish_schedule SET status = 'failed' WHERE id = ?", ['schedule-1']);
    const retry = await dbB.claimScheduleEntryForUpload('schedule-1');
    assert.equal(retry.status, 'uploading', 'a known failed pre-upload attempt can be retried');
    assert.ok(retry.uploadAttemptId);
    assert.notEqual(retry.uploadAttemptId, firstAttemptId,
      'a retry receives a new fencing token, even when it reuses the same schedule row');

    const staleResult = await dbA.recordScheduleEntryUploadResult(
      'schedule-1', 'stale-worker-video', { source: 'stale' }, firstAttemptId
    );
    assert.equal(staleResult, null, 'a stale worker cannot attach its video ID to a newer upload attempt');
    const staleFinalize = await dbA.updateScheduleEntryForUpload({
      id: 'schedule-1', status: 'published', youtubeId: 'stale-worker-video',
      youtubeUrl: 'https://www.youtube.com/watch?v=stale-worker-video'
    }, firstAttemptId);
    assert.equal(staleFinalize, null, 'a stale worker cannot finalize a newer upload attempt');

    const recorded = await dbA.recordScheduleEntryUploadResult(
      'schedule-1', 'youtube-video-123', { source: 'test' }, retry.uploadAttemptId
    );
    assert.equal(recorded.status, 'uploaded');
    assert.equal(recorded.youtubeId, 'youtube-video-123');
    assert.equal(recorded.youtubeUrl, 'https://www.youtube.com/watch?v=youtube-video-123');
    assert.deepEqual(recorded.metadata, { source: 'test' });
    const idempotent = await dbB.recordScheduleEntryUploadResult(
      'schedule-1', 'youtube-video-123', { source: 'test' }, retry.uploadAttemptId
    );
    assert.equal(idempotent.youtubeId, 'youtube-video-123',
      'recording the same accepted YouTube ID twice must be idempotent');
    const conflicting = await dbB.recordScheduleEntryUploadResult(
      'schedule-1', 'different-video-id', {}, retry.uploadAttemptId
    );
    assert.equal(conflicting, null, 'a different video ID must never overwrite the accepted upload');
    const finalized = await dbA.updateScheduleEntryForUpload({
      ...recorded, status: 'published', publishedAt: new Date().toISOString()
    }, retry.uploadAttemptId);
    assert.equal(finalized.status, 'published', 'the current upload attempt can finalize its own schedule');
    const staleAfterFinalize = await dbB.updateScheduleEntryForUpload({
      ...recorded, status: 'failed', error: 'late stale failure'
    }, firstAttemptId);
    assert.equal(staleAfterFinalize, null, 'a late stale failure cannot downgrade a newer published schedule');
    process.stdout.write('Publish schedule upload claim CAS tests passed\\n');
  } finally {
    await Promise.all([close(dbA.db), close(dbB.db)]);
    await fs.rm(directory, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
