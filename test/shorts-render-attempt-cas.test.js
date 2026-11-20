const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { Database } = require('../database/db');

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'short-render-cas-'));
  const database = Object.create(Database.prototype);
  database.db = new sqlite3.Database(path.join(directory, 'shorts.sqlite'));
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

    await database.updateShortClip('short-1', { status: 'rendering', renderAttemptId: 'attempt-1' });
    const first = await database.updateShortClipForRender('short-1', 'attempt-1', {
      status: 'rendered',
      outputPath: '/tmp/attempt-1.mp4',
      renderMetadata: { width: 1080, height: 1920, duration: 30 }
    });
    assert.equal(first.status, 'rendered');
    assert.equal(first.renderAttemptId, 'attempt-1');
    assert.deepEqual(first.renderMetadata, { width: 1080, height: 1920, duration: 30 });

    await database.updateShortClip('short-1', {
      status: 'rendering',
      renderAttemptId: 'attempt-2',
      outputPath: null,
      renderMetadata: null
    });
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
    process.stdout.write('Shorts render attempt CAS tests passed\\n');
  } finally {
    await new Promise((resolve, reject) => database.db.close(error => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
