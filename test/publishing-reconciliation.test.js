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

async function insertSchedule(db, id, status = 'reconciliation_required', title = 'Expected title') {
  await db.executeQuery(
    `INSERT INTO publish_schedule
      (id, production_id, title, publish_time, status, priority, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, id, title, new Date().toISOString(), status, 50, JSON.stringify({ seo: { title } })]
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
      youtube_id TEXT, youtube_url TEXT, published_at TEXT, error_message TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    await insertSchedule(db, 'schedule-good');
    await insertSchedule(db, 'schedule-wrong-channel');
    await insertSchedule(db, 'schedule-wrong-title', 'uploading', 'Expected title');
    await insertSchedule(db, 'schedule-absent');
    await insertSchedule(db, 'schedule-race');

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

    const unresolved = await db.listUnresolvedPublishScheduleEntries(20);
    assert.deepEqual(
      unresolved.map(entry => entry.id).sort(),
      ['schedule-wrong-channel', 'schedule-wrong-title']
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
