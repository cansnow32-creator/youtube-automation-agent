const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { Database } = require('../database/db');

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'short-render-cas-'));
  const database = Object.create(Database.prototype);
  database.dbPath = path.join(directory, 'shorts.sqlite');
  database.db = new sqlite3.Database(database.dbPath);
  database.db.configure('busyTimeout', 5000);
  try {
    await database.executeQuery(`CREATE TABLE shorts_clips (
      id TEXT PRIMARY KEY, production_id TEXT, position INTEGER, title TEXT, description TEXT,
      tags TEXT, source_scene_ids TEXT, start_seconds REAL, duration REAL, layout TEXT, rationale TEXT,
      status TEXT, output_path TEXT, captions_path TEXT, publish_time TEXT, privacy_status TEXT,
      inherited_evidence TEXT, rendered_at TEXT, approved_at TEXT, schedule_id TEXT, youtube_id TEXT,
      youtube_url TEXT, error TEXT, render_attempt_id TEXT, render_metadata TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    await database.executeQuery(
      "INSERT INTO shorts_clips (id, production_id, position, title, description, tags, source_scene_ids, start_seconds, duration, layout, status, inherited_evidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ['short-1', 'production-1', 0, 'Test Short', '', '[]', '[]', 0, 30, 'crop', 'proposed', '{}']
    );
    await database.executeQuery(`CREATE TABLE production_operation_locks (
      production_id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL
    )`);

    const wrongProductionClaim = await database.claimShortClipRender('short-1', 'another-production', 'wrong-production-attempt');
    assert.equal(wrongProductionClaim, null, 'a render claim must be scoped to its owning production');
    const firstClaim = await database.claimShortClipRender('short-1', 'production-1', 'attempt-1');
    assert.equal(firstClaim.status, 'rendering');
    assert.equal(firstClaim.renderAttemptId, 'attempt-1');
    const competingClaim = await database.claimShortClipRender('short-1', 'production-1', 'competing-attempt');
    assert.equal(competingClaim, null, 'a second worker cannot replace an active render attempt');
    const first = await database.updateShortClipForRender('short-1', 'attempt-1', {
      status: 'rendered',
      outputPath: '/tmp/attempt-1.mp4',
      renderMetadata: { width: 1080, height: 1920, duration: 30 }
    });
    assert.equal(first.status, 'rendered');
    assert.equal(first.renderAttemptId, 'attempt-1');
    assert.deepEqual(first.renderMetadata, { width: 1080, height: 1920, duration: 30 });

    const secondClaim = await database.claimShortClipRender('short-1', 'production-1', 'attempt-2');
    assert.equal(secondClaim.status, 'rendering');
    assert.equal(secondClaim.renderAttemptId, 'attempt-2');
    const stale = await database.updateShortClipForRender('short-1', 'attempt-1', {
      status: 'rendered',
      outputPath: '/tmp/stale-attempt.mp4'
    });
    assert.equal(stale, null, 'an older render attempt must fail its conditional update');
    const current = await database.getShortClip('short-1');
    assert.equal(current.status, 'rendering');
    assert.equal(current.renderAttemptId, 'attempt-2');
    assert.equal(current.outputPath, null, 'a stale attempt cannot publish its output path');

    const second = await database.updateShortClipForRender('short-1', 'attempt-2', {
      status: 'failed',
      error: 'test failure'
    });
    assert.equal(second.status, 'failed');
    assert.equal(second.renderAttemptId, 'attempt-2');

    await database.updateShortClip('short-1', { status: 'scheduled', scheduleId: 'schedule-current' });
    const synced = await database.updateShortClipForSchedule('short-1', 'schedule-current', {
      status: 'uploading',
      youtubeId: null,
      youtubeUrl: null
    });
    assert.equal(synced.status, 'uploading');
    assert.equal(synced.scheduleId, 'schedule-current');
    const staleScheduleSync = await database.updateShortClipForSchedule('short-1', 'schedule-old', {
      status: 'failed',
      error: 'stale publisher'
    });
    assert.equal(staleScheduleSync, null, 'an old schedule cannot overwrite the current Short status');
    assert.equal((await database.getShortClip('short-1')).status, 'uploading');

    // The clip CAS must also validate the production lease inside the same
    // SQLite transaction; an assertLease call immediately before SQL is not enough.
    await database.executeQuery(
      "INSERT INTO shorts_clips (id, production_id, position, title, description, tags, source_scene_ids, start_seconds, duration, layout, status, inherited_evidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ['short-lease', 'production-lease', 1, 'Lease Short', '', '[]', '[]', 0, 30, 'crop', 'proposed', '{}']
    );
    await database.executeQuery(
      'INSERT INTO production_operation_locks (production_id, owner, expires_at) VALUES (?, ?, ?)',
      ['production-lease', 'current-owner', Date.now() + 60000]
    );
    const staleLease = { productionId: 'production-lease', owner: 'old-owner' };
    const currentLease = { productionId: 'production-lease', owner: 'current-owner' };
    await assert.rejects(
      database.claimShortClipRender('short-lease', 'production-lease', 'stale-claim', staleLease),
      error => error.code === 'SCENE_EDIT_LEASE_LOST'
    );
    assert.equal((await database.getShortClip('short-lease')).status, 'proposed',
      'a stale worker cannot claim a Short after losing the production lease');
    const leasedClaim = await database.claimShortClipRender(
      'short-lease', 'production-lease', 'current-claim', currentLease
    );
    assert.equal(leasedClaim.renderAttemptId, 'current-claim');
    await assert.rejects(
      database.updateShortClipForRender('short-lease', 'current-claim', {
        status: 'rendered', outputPath: '/tmp/stale-lease.mp4'
      }, staleLease),
      error => error.code === 'SCENE_EDIT_LEASE_LOST'
    );
    assert.equal((await database.getShortClip('short-lease')).status, 'rendering',
      'a stale worker cannot finalize a render after lease takeover');
    const leaseFinalized = await database.updateShortClipForRender('short-lease', 'current-claim', {
      status: 'rendered', outputPath: '/tmp/current-lease.mp4'
    }, currentLease);
    assert.equal(leaseFinalized.outputPath, '/tmp/current-lease.mp4');
    process.stdout.write('Shorts render and schedule CAS tests passed\\n');
  } finally {
    await new Promise((resolve, reject) => database.db.close(error => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
