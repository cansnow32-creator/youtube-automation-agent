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
      youtube_id TEXT, youtube_url TEXT, published_at TEXT, error_message TEXT, upload_started_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    await dbA.executeQuery(
      "INSERT INTO publish_schedule (id, production_id, title, publish_time, status, priority, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ['schedule-1', 'short-1', 'Short title', new Date(Date.now() + 60000).toISOString(), 'scheduled', 60, JSON.stringify({ shortClipId: 'short-1' })]
    );

    const claims = await Promise.all([
      dbA.claimScheduleEntryForUpload('schedule-1'),
      dbB.claimScheduleEntryForUpload('schedule-1')
    ]);
    assert.equal(claims.filter(Boolean).length, 1, 'only one SQLite connection may claim a scheduled upload');
    const winner = claims.find(Boolean);
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
