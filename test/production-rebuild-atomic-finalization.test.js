const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { Database } = require('../database/db');

async function run() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'production-rebuild-finalize-'));
  const database = Object.create(Database.prototype);
  database.dbPath = path.join(directory, 'rebuild.sqlite');
  database.db = new sqlite3.Database(database.dbPath);
  database.db.configure('busyTimeout', 5000);
  try {
    await database.executeQuery(`CREATE TABLE production_operation_locks (
      production_id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL
    )`);
    await database.executeQuery(`CREATE TABLE productions (
      id TEXT PRIMARY KEY, status TEXT, assets TEXT, timeline TEXT,
      scheduled_publish_time TEXT, priority INTEGER
    )`);
    await database.executeQuery(`CREATE TABLE production_scenes (
      id TEXT PRIMARY KEY, production_id TEXT NOT NULL, status TEXT, updated_at TEXT
    )`);
    await database.executeQuery(`CREATE TABLE content_provenance (
      production_id TEXT PRIMARY KEY, sources TEXT, claims TEXT, contains_synthetic_media INTEGER,
      status TEXT, summary TEXT, reviewed_at TEXT, updated_at TEXT
    )`);
    await database.executeQuery(`CREATE TABLE production_scene_revisions (
      id TEXT PRIMARY KEY, production_id TEXT, scene_id TEXT, action TEXT, status TEXT,
      before_state TEXT, after_state TEXT, cost_evidence TEXT, error TEXT, completed_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    await database.executeQuery(
      'INSERT INTO productions (id, status, assets, timeline, priority) VALUES (?, ?, ?, ?, ?)',
      ['production-1', 'processing', '{}', '{}', 10]
    );
    for (const id of ['scene-1', 'scene-2']) {
      await database.executeQuery(
        'INSERT INTO production_scenes (id, production_id, status) VALUES (?, ?, ?)',
        [id, 'production-1', 'needs_rebuild']
      );
    }
    await database.executeQuery(
      'INSERT INTO production_operation_locks (production_id, owner, expires_at) VALUES (?, ?, ?)',
      ['production-1', 'current-owner', Date.now() + 60000]
    );

    const stale = { productionId: 'production-1', owner: 'stale-owner' };
    await assert.rejects(
      database.finalizeProductionRebuild({
        production: { id: 'production-1', status: 'ready', assets: { finalVideo: { path: '/stale.mp4' } }, timeline: {}, priority: 1 },
        sceneIds: ['scene-1', 'scene-2'],
        provenance: { containsSyntheticMedia: true, sources: [], claims: [] },
        revision: { sceneId: 'scene-1', after: { finalVideo: '/stale.mp4' } }
      }, stale),
      error => error.code === 'SCENE_EDIT_LEASE_LOST'
    );
    assert.equal((await database.getRow('SELECT status FROM productions WHERE id = ?', ['production-1'])).status, 'processing');
    assert.equal((await database.getRow('SELECT COUNT(*) AS count FROM production_scene_revisions')).count, 0);
    assert.equal((await database.getRow('SELECT COUNT(*) AS count FROM content_provenance')).count, 0);

    const current = { productionId: 'production-1', owner: 'current-owner' };
    await database.finalizeProductionRebuild({
      production: {
        id: 'production-1', status: 'ready',
        assets: { finalVideo: { path: '/current.mp4' } }, timeline: { readyForUpload: 'now' },
        scheduledPublishTime: null, priority: 10
      },
      sceneIds: ['scene-1', 'scene-2'],
      provenance: { containsSyntheticMedia: true, sources: [], claims: [], reviewedAt: null },
      revision: { sceneId: 'scene-1', before: {}, after: { finalVideo: '/current.mp4' }, costEvidence: { billed: false } }
    }, current);
    assert.equal((await database.getRow('SELECT status FROM productions WHERE id = ?', ['production-1'])).status, 'ready');
    assert.equal((await database.getRow('SELECT COUNT(*) AS count FROM production_scenes WHERE status = ?', ['ready'])).count, 2);
    assert.equal((await database.getRow('SELECT contains_synthetic_media FROM content_provenance WHERE production_id = ?', ['production-1'])).contains_synthetic_media, 1);
    assert.equal((await database.getRow('SELECT COUNT(*) AS count FROM production_scene_revisions WHERE action = ?', ['rebuild'])).count, 1);

    await assert.rejects(
      database.updateProductionScene('production-1', 'missing-scene', { status: 'ready' }, current),
      error => error.code === 'PRODUCTION_SCENE_NOT_FOUND'
    );
    process.stdout.write('Production rebuild atomic finalization tests passed\\n');
  } finally {
    await new Promise((resolve, reject) => database.db.close(error => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
