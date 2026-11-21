const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { Database } = require('../database/db');

async function run() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'short-edit-lease-'));
  const database = Object.create(Database.prototype);
  database.dbPath = path.join(directory, 'shorts.sqlite');
  database.db = new sqlite3.Database(database.dbPath);
  database.db.configure('busyTimeout', 5000);
  database.parseShortClip = row => row ? { ...row } : null;

  try {
    await database.executeQuery(`CREATE TABLE shorts_clips (
      id TEXT PRIMARY KEY, production_id TEXT NOT NULL, title TEXT NOT NULL,
      description TEXT DEFAULT '', tags TEXT DEFAULT '[]', source_scene_ids TEXT DEFAULT '[]',
      start_seconds REAL DEFAULT 0, duration REAL DEFAULT 30, layout TEXT DEFAULT 'blur',
      rationale TEXT, status TEXT DEFAULT 'proposed', output_path TEXT, captions_path TEXT,
      publish_time TEXT, privacy_status TEXT DEFAULT 'private', inherited_evidence TEXT DEFAULT '{}',
      rendered_at TEXT, approved_at TEXT, schedule_id TEXT, youtube_id TEXT, youtube_url TEXT,
      error TEXT, render_attempt_id TEXT, render_metadata TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    const productionId = 'short-edit-production';
    await database.executeQuery(
      'INSERT INTO shorts_clips (id, production_id, title, status) VALUES (?, ?, ?, ?)',
      ['short-edit-1', productionId, 'Original title', 'rendered']
    );
    assert.equal(await database.acquireProductionOperationLock(productionId, 'owner-a'), true);

    await assert.rejects(
      database.updateShortClip('short-edit-1', { title: 'Wrong owner' }, { productionId, owner: 'owner-b' }, productionId),
      error => error.code === 'SCENE_EDIT_LEASE_LOST' && error.status === 409
    );
    const saved = await database.updateShortClip(
      'short-edit-1', { title: 'Updated title' }, { productionId, owner: 'owner-a' }, productionId
    );
    assert.equal(saved.title, 'Updated title', 'the current production lease owner can edit its Short');

    await database.executeQuery("UPDATE shorts_clips SET status = 'scheduled' WHERE id = ?", ['short-edit-1']);
    await assert.rejects(
      database.updateShortClip('short-edit-1', { title: 'Late edit' }, { productionId, owner: 'owner-a' }, productionId),
      error => error.code === 'SHORT_EDIT_STATE_CONFLICT' && error.status === 409
    );
    process.stdout.write('Shorts update operation lease tests passed\n');
  } finally {
    await database.releaseProductionOperationLock('short-edit-production', 'owner-a').catch(() => {});
    await new Promise((resolve, reject) => database.db.close(error => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

run().catch(error => {
  process.stderr.write(`Shorts update operation lease tests failed: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
