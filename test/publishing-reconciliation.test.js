const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { Database } = require('../database/db');
const { PublishingSchedulingAgent } = require('../agents/publishing-scheduling-agent');

async function close(db) {
  await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
}

async function insertSchedule(db, id, status = 'reconciliation_required', title = 'Expected title', uploadStartedAt = new Date(Date.now() - 11 * 60 * 1000).toISOString()) {
  await db.executeQuery(
    `INSERT INTO publish_schedule
      (id, production_id, title, publish_time, status, priority, metadata, upload_started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, id, title, new Date().toISOString(), status, 50, JSON.stringify({ seo: { title } }), uploadStartedAt]
  );
}

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'publish-reconcile-'));
  const db = Object.create(Database.prototype);
  db.db = new sqlite3.Database(path.join(directory, 'schedule.sqlite'));
  try {
    await db.executeQuery(`CREATE TABLE publish_schedule (
      id TEXT PRIMARY KEY, production_id TEXT NOT NULL, title TEXT NOT NULL,
      publish_time TEXT NOT NULL, status TEXT, priority INTEGER, metadata TEXT,
      youtube_id TEXT, youtube_url TEXT, published_at TEXT, error_message TEXT, upload_started_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    await insertSchedule(db, 'schedule-good');
    await insertSchedule(db, 'schedule-wrong-channel');
    await insertSchedule(db, 'schedule-wrong-title', 'uploading', 'Expected title');
    await insertSchedule(db, 'schedule-absent');
    await insertSchedule(db, 'schedule-race');
    await insertSchedule(db, 'schedule-fresh-uploading', 'uploading', 'Expected title', new Date().toISOString());
    for (const [id, videoId] of [
      ['schedule-recorded-valid', 'knownGood01'],
      ['schedule-recorded-channel', 'wrongCHAN01'],
      ['schedule-recorded-title', 'wrongTITL01']
    ]) {
      await db.executeQuery(
        `INSERT INTO publish_schedule
          (id, production_id, title, publish_time, status, priority, metadata, youtube_id, upload_started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, id, 'Expected title', new Date().toISOString(), 'uploading', 50, JSON.stringify({ seo: { title: 'Expected title' } }), videoId, new Date(Date.now() - 11 * 60 * 1000).toISOString()]
      );
    }

    const agent = Object.create(PublishingSchedulingAgent.prototype);
    agent.db = db;
    agent.logger = { info() {}, warn() {}, error() {}, success() {} };
    agent.publishQueue = [];
    agent.syncShortStatus = async () => null;
    agent.youtube = {
      videos: {
        list: async ({ id }) => ({
          data: {
            items: [{
              id,
              snippet: {
                channelId: id === 'wrongCHAN01' ? 'other-channel' : 'owned-channel',
                title: id === 'wrongTITL01' ? 'Different title' : 'Expected title'
              },
              status: { privacyStatus: 'private' }
            }]
          }
        })
      },
      channels: {
        list: async () => ({ data: { items: [{ id: 'owned-channel' }] } })
      }
    };

    const knownUpload = await agent.reconcileUploadedVideo(await db.getScheduleEntry('schedule-recorded-valid'));
    assert.equal(knownUpload.status, 'published');
    assert.equal(knownUpload.youtubeId, 'knownGood01');
    await assert.rejects(
      agent.reconcileUploadedVideo(await db.getScheduleEntry('schedule-recorded-channel')),
      error => error.code === 'YOUTUBE_CHANNEL_MISMATCH'
    );
    assert.equal((await db.getScheduleEntry('schedule-recorded-channel')).status, 'reconciliation_required');
    await assert.rejects(
      agent.reconcileUploadedVideo(await db.getScheduleEntry('schedule-recorded-title')),
      error => error.code === 'YOUTUBE_TITLE_MISMATCH'
    );
    assert.equal((await db.getScheduleEntry('schedule-recorded-title')).status, 'reconciliation_required');

    const reconciled = await agent.reconcileUnresolvedUpload('schedule-good', 'goodVideo01');
    assert.equal(reconciled.status, 'published');
    assert.equal(reconciled.youtubeId, 'goodVideo01');
    assert.equal(reconciled.youtubeUrl, 'https://www.youtube.com/watch?v=goodVideo01');
    assert.equal(reconciled.metadata.uploadReconciliation.action, 'video_attached');

    await assert.rejects(
      agent.reconcileUnresolvedUpload('schedule-wrong-channel', 'wrongCHAN01'),
      error => error.code === 'YOUTUBE_CHANNEL_MISMATCH'
    );
    assert.equal((await db.getScheduleEntry('schedule-wrong-channel')).status, 'reconciliation_required');

    await assert.rejects(
      agent.reconcileUnresolvedUpload('schedule-wrong-title', 'wrongTITL01'),
      error => error.code === 'YOUTUBE_TITLE_MISMATCH'
    );
    assert.equal((await db.getScheduleEntry('schedule-wrong-title')).status, 'uploading');

    await assert.rejects(
      agent.resolveUnresolvedUploadAsAbsent('schedule-absent', false),
      error => error.code === 'UPLOAD_ABSENCE_CONFIRMATION_REQUIRED'
    );
    await assert.rejects(
      agent.resolveUnresolvedUploadAsAbsent('schedule-fresh-uploading', true),
      error => error.code === 'UPLOAD_GRACE_PERIOD_ACTIVE'
    );
    assert.equal((await db.getScheduleEntry('schedule-fresh-uploading')).status, 'uploading');

    const absent = await agent.resolveUnresolvedUploadAsAbsent('schedule-absent', true);
    assert.equal(absent.status, 'failed');
    assert.equal(absent.youtubeId, null);
    assert.equal(absent.metadata.uploadReconciliation.action, 'operator_confirmed_absent');

    const race = await Promise.all([
      db.reconcileScheduleEntryUpload('schedule-race', 'raceVideo001', { source: 'video' }),
      db.resolveScheduleEntryUploadAbsent('schedule-race', { source: 'absent' }, 'operator confirmed absent')
    ]);
    assert.equal(race.filter(Boolean).length, 1, 'only one competing reconciliation decision may win');
    const finalRace = await db.getScheduleEntry('schedule-race');
    assert.ok(['published', 'failed'].includes(finalRace.status));
    if (finalRace.status === 'published') assert.equal(finalRace.youtubeId, 'raceVideo001');
    else assert.equal(finalRace.youtubeId, null);

    await db.executeQuery(
      `INSERT INTO publish_schedule
        (id, production_id, title, publish_time, status, priority, metadata, youtube_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['schedule-verify-race', 'schedule-verify-race', 'Expected title', new Date().toISOString(), 'uploading', 50, '{}', 'knownGood01']
    );
    const verifyRace = await Promise.all([
      db.updateScheduleEntryUploadVerification('schedule-verify-race', 'uploading', 'knownGood01', 'published', null),
      db.updateScheduleEntryUploadVerification('schedule-verify-race', 'uploading', 'knownGood01', 'reconciliation_required', 'verification failed')
    ]);
    assert.equal(verifyRace.filter(Boolean).length, 1, 'only one verification outcome may update a recorded video');
    const unresolved = await db.listUnresolvedPublishScheduleEntries(20);
    assert.deepEqual(
      unresolved.map(entry => entry.id).sort(),
      ['schedule-fresh-uploading', 'schedule-recorded-channel', 'schedule-recorded-title', 'schedule-wrong-channel', 'schedule-wrong-title']
    );
    process.stdout.write('Publishing reconciliation tests passed\\n');
  } finally {
    await close(db.db);
    await fs.rm(directory, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
