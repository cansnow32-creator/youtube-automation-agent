const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { Database } = require('../database/db');

async function run() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'content-review-lease-'));
  const database = Object.create(Database.prototype);
  database.dbPath = path.join(directory, 'review.sqlite');
  database.db = new sqlite3.Database(database.dbPath);
  database.db.configure('busyTimeout', 5000);
  database.getProductionBundle = async productionId => ({
    id: productionId,
    ...(await database.getRow('SELECT * FROM content_reviews WHERE production_id = ?', [productionId]))
  });

  try {
    await database.executeQuery(`CREATE TABLE content_reviews (
      production_id TEXT PRIMARY KEY, status TEXT, editor_data TEXT,
      quality_checks TEXT, review_notes TEXT, reviewed_at TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    const productionId = 'review-lease-production';
    assert.equal(await database.acquireProductionOperationLock(productionId, 'editor-owner', 60000), true);
    await assert.rejects(
      database.saveContentReview(productionId, { status: 'rejected' }),
      error => error.code === 'CONTENT_REVIEW_LOCK_ACTIVE' && error.status === 409
    );
    assert.equal(await database.getRow('SELECT production_id FROM content_reviews WHERE production_id = ?', [productionId]), null,
      'a non-owner cannot overwrite review state while an operation lease is active');

    const lease = { productionId, owner: 'editor-owner' };
    const saved = await database.saveContentReview(productionId, {
      status: 'needs_review', editorData: { title: 'Edited' }, qualityChecks: []
    }, lease);
    assert.equal(saved.status, 'needs_review', 'the current lease owner can persist review state');
    await database.releaseProductionOperationLock(productionId, 'editor-owner');

    const unleased = await database.saveContentReview(productionId, {
      status: 'rejected', editorData: { title: 'Rejected' }
    });
    assert.equal(unleased.status, 'rejected', 'unleased review writes remain available when no operation is active');
    process.stdout.write('Content review write lease tests passed\\n');
  } finally {
    await new Promise((resolve, reject) => database.db.close(error => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

run().catch(error => {
  process.stderr.write(`Content review write lease tests failed: ${error.stack || error.message}\\n`);
  process.exitCode = 1;
});
