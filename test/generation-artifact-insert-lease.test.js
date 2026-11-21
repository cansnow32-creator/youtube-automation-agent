const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { Database } = require('../database/db');

async function run() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'generation-artifact-lease-'));
  const database = Object.create(Database.prototype);
  database.dbPath = path.join(directory, 'artifacts.sqlite');
  database.db = new sqlite3.Database(database.dbPath);
  database.db.configure('busyTimeout', 5000);
  const lease = { productionId: 'generation:job-1', owner: 'worker-current' };
  try {
    await database.executeQuery(`CREATE TABLE production_operation_locks (
      production_id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL
    )`);
    await database.executeQuery(`INSERT INTO production_operation_locks (production_id, owner, expires_at)
      VALUES (?, ?, ?)`, [lease.productionId, lease.owner, Date.now() + 60000]);
    await database.executeQuery(`CREATE TABLE content_strategies (
      id TEXT PRIMARY KEY, topic TEXT, angle TEXT, target_audience TEXT, content_type TEXT,
      keywords TEXT, estimated_views INTEGER, best_publish_time TEXT, competitor_analysis TEXT
    )`);
    await database.executeQuery(`CREATE TABLE scripts (
      id TEXT PRIMARY KEY, title TEXT, hook TEXT, introduction TEXT, main_content TEXT,
      conclusion TEXT, call_to_action TEXT, full_script TEXT, duration TEXT, tone TEXT, pacing TEXT, keywords TEXT
    )`);
    await database.executeQuery(`CREATE TABLE thumbnails (
      id TEXT PRIMARY KEY, path TEXT, concept TEXT, prompt TEXT, dimensions TEXT, file_size INTEGER
    )`);
    await database.executeQuery(`CREATE TABLE seo_data (
      id TEXT PRIMARY KEY, title TEXT, description TEXT, tags TEXT, hashtags TEXT,
      chapters TEXT, end_screen TEXT, seo_score INTEGER, metadata TEXT
    )`);

    await database.saveContentStrategy({
      topic: 'Lease-safe topic', angle: 'Test', targetAudience: 'Viewers',
      contentType: 'Explainer', keywords: ['lease'], estimatedViews: 10,
      bestPublishTime: null, competitorAnalysis: {}
    }, lease);
    await database.saveScript({
      title: 'Lease-safe script', hook: {}, introduction: {}, mainContent: {},
      conclusion: {}, callToAction: {}, fullScript: 'body', duration: 'short',
      tone: 'calm', pacing: 'steady', keywords: ['lease']
    }, lease);
    await database.saveThumbnail({
      path: '/data/thumbnail.jpg', concept: {}, prompt: 'test',
      dimensions: { width: 1280, height: 720 }, fileSize: 100
    }, lease);
    await database.saveSEOData({
      title: 'Lease-safe title', description: 'Description', tags: ['lease'],
      hashtags: ['#lease'], chapters: [], endScreen: {}, seoScore: 90, metadata: {}
    }, lease);

    const staleLease = { productionId: lease.productionId, owner: 'worker-stale' };
    await assert.rejects(
      database.saveThumbnail({ path: '/data/stale.jpg', concept: {}, prompt: 'stale', dimensions: {}, fileSize: 1 }, staleLease),
      error => error.code === 'SCENE_EDIT_LEASE_LOST'
    );
    await assert.rejects(
      database.saveScript({ title: 'stale', fullScript: 'must not persist' }, staleLease),
      error => error.code === 'SCENE_EDIT_LEASE_LOST'
    );

    for (const table of ['content_strategies', 'scripts', 'thumbnails', 'seo_data']) {
      const row = await database.getRow(`SELECT COUNT(*) AS count FROM ${table}`);
      assert.equal(Number(row.count), 1, `${table} inserts are committed only by the current lease owner`);
    }
    process.stdout.write('Generation artifact insert lease tests passed\\n');
  } finally {
    await new Promise((resolve, reject) => database.db.close(error => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
