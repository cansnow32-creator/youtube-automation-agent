const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { Database } = require('../database/db');
const { SceneRepairService, replaceFileWithRollback } = require('../utils/scene-repair-service');
const { ProductionManagementAgent } = require('../agents/production-management-agent');

async function run() {
  const replacementDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-repair-replace-'));
  try {
    const destination = path.join(replacementDir, 'output.mp4');
    const replacement = path.join(replacementDir, 'output.mp4.writing');
    await fs.writeFile(destination, 'previous-valid-output');
    await fs.writeFile(replacement, 'new-valid-output');
    await replaceFileWithRollback(replacement, destination, 'success');
    assert.equal(await fs.readFile(destination, 'utf8'), 'new-valid-output');

    await fs.writeFile(destination, 'keep-this-output');
    await assert.rejects(replaceFileWithRollback(path.join(replacementDir, 'missing-temp'), destination, 'rollback'));
    assert.equal(await fs.readFile(destination, 'utf8'), 'keep-this-output', 'failed replacement restores the previous output');
  } finally {
    await fs.rm(replacementDir, { recursive: true, force: true });
  }

  // Rebuild artifacts are immutable per attempt: a stale worker cannot
  // overwrite a newer worker's final video or narration mix.
  const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-rebuild-attempts-'));
  try {
    const repair = new SceneRepairService({}, {}, {
      dataRoot: artifactDir,
      getMediaDuration: async () => 5,
      runFFmpeg: async args => {
        const output = args[args.length - 1];
        if (output.endsWith('.m4a')) await fs.writeFile(output, 'valid-test-audio');
      }
    });
    const scenes = [{ narrationStatus: 'current', audioPath: '/unused/scene.mp3', duration: 5 }];
    const first = await repair.rebuildNarration('prod', scenes, null, 'fingerprint', async () => {}, 'attempt-one');
    const second = await repair.rebuildNarration('prod', scenes, null, 'fingerprint', async () => {}, 'attempt-two');
    assert.notEqual(first, second, 'separate rebuild attempts publish to distinct narration paths');
    assert.equal(await fs.readFile(first, 'utf8'), 'valid-test-audio');
    assert.equal(await fs.readFile(second, 'utf8'), 'valid-test-audio');

    const videosDir = path.join(artifactDir, 'videos');
    await fs.mkdir(videosDir, { recursive: true });
    const staleVisualTemp = path.join(videosDir,
      'prod_repair_fingerprint_123e4567-e89b-12d3-a456-426614174000_visual.mp4.rendering.mp4');
    const recentVisualTemp = path.join(videosDir,
      'prod_repair_fingerprint_123e4567-e89b-12d3-a456-426614174001_visual.mp4.rendering.mp4');
    const completedFinal = path.join(videosDir,
      'prod_repair_fingerprint_123e4567-e89b-12d3-a456-426614174002.mp4');
    await fs.writeFile(staleVisualTemp, 'stale-temp');
    await fs.writeFile(recentVisualTemp, 'active-temp');
    await fs.writeFile(completedFinal, 'completed-output');
    const oldTime = new Date(Date.now() - 60_000);
    await fs.utimes(staleVisualTemp, oldTime, oldTime);
    await fs.utimes(completedFinal, oldTime, oldTime);
    assert.equal(await repair.cleanupStaleRepairTemps('prod', 1000), 1,
      'cleanup removes only stale temporary render files');
    await assert.rejects(fs.access(staleVisualTemp));
    assert.equal(await fs.readFile(recentVisualTemp, 'utf8'), 'active-temp',
      'recent in-progress render temp is preserved');
    assert.equal(await fs.readFile(completedFinal, 'utf8'), 'completed-output',
      'completed immutable output is never treated as a temp file');
  } finally {
    await fs.rm(artifactDir, { recursive: true, force: true });
  }

  // Exercise the lock against two independent SQLite connections. The
  // mocked assertions below verify SQL shape; this integration check verifies
  // SQLite's atomic conflict handling across separate connections.
  const lockDir = await fs.mkdtemp(path.join(os.tmpdir(), 'production-lock-sqlite-'));
  const lockPath = path.join(lockDir, 'locks.sqlite');
  const connectionA = Object.create(Database.prototype);
  const connectionB = Object.create(Database.prototype);
  connectionA.db = new sqlite3.Database(lockPath);
  connectionB.db = new sqlite3.Database(lockPath);
  connectionA.db.configure('busyTimeout', 5000);
  connectionB.db.configure('busyTimeout', 5000);
  try {
    // Create the table before racing the two independent connections.
    assert.equal(await connectionA.acquireProductionOperationLock('bootstrap', 'setup', 10000), true);
    await connectionA.releaseProductionOperationLock('bootstrap', 'setup');

    const claims = await Promise.all([
      connectionA.acquireProductionOperationLock('shared-job', 'worker-a', 10000),
      connectionB.acquireProductionOperationLock('shared-job', 'worker-b', 10000)
    ]);
    assert.equal(claims.filter(Boolean).length, 1, 'exactly one SQLite connection acquires a contested lock');

    const winner = claims[0] ? connectionA : connectionB;
    const loser = claims[0] ? connectionB : connectionA;
    const winnerOwner = claims[0] ? 'worker-a' : 'worker-b';
    const loserOwner = claims[0] ? 'worker-b' : 'worker-a';

    assert.equal(await loser.renewProductionOperationLock('shared-job', loserOwner, 10000), false,
      'a different connection cannot renew the current owner lease');
    await loser.releaseProductionOperationLock('shared-job', loserOwner);
    assert.equal(await winner.renewProductionOperationLock('shared-job', winnerOwner, 10000), true,
      'releasing as a non-owner does not remove the active lease');

    await winner.executeQuery(
      'UPDATE production_operation_locks SET expires_at = ? WHERE production_id = ?',
      [Date.now() - 1, 'shared-job']
    );
    assert.equal(await loser.acquireProductionOperationLock('shared-job', loserOwner, 10000), true,
      'an expired lease can be atomically taken over');
    assert.equal(await winner.renewProductionOperationLock('shared-job', winnerOwner, 10000), false,
      'the previous owner cannot renew after lease takeover');
    await loser.releaseProductionOperationLock('shared-job', loserOwner);

    // A stale owner must not update production metadata after another worker
    // takes over an expired lease. The write itself is fenced in SQL.
    await connectionA.executeQuery(`CREATE TABLE productions (
      id TEXT PRIMARY KEY, status TEXT, assets TEXT, timeline TEXT,
      scheduled_publish_time TEXT, priority INTEGER
    )`);
    await connectionA.executeQuery(
      'INSERT INTO productions (id, status, assets, timeline, priority) VALUES (?, ?, ?, ?, ?)',
      ['guarded-production', 'processing', '{}', '{}', 50]
    );
    assert.equal(await connectionA.acquireProductionOperationLock('guarded-production', 'old-owner', 10000), true);
    await connectionA.executeQuery(
      'UPDATE production_operation_locks SET expires_at = ? WHERE production_id = ?',
      [Date.now() - 1, 'guarded-production']
    );
    assert.equal(await connectionB.acquireProductionOperationLock('guarded-production', 'new-owner', 10000), true);
    await assert.rejects(
      connectionA.updateProductionData({
        id: 'guarded-production', status: 'ready', assets: {}, timeline: {}, priority: 1
      }, { productionId: 'guarded-production', owner: 'old-owner' }),
      error => error.code === 'SCENE_EDIT_LEASE_LOST'
    );
    const unchanged = await connectionB.getRow('SELECT status, priority FROM productions WHERE id = ?', ['guarded-production']);
    assert.deepEqual(unchanged, { status: 'processing', priority: 50 },
      'a stale worker cannot overwrite production state after lease takeover');
    await connectionB.releaseProductionOperationLock('guarded-production', 'new-owner');

    // Manifest replacement runs on a dedicated SQLite connection in one
    // BEGIN IMMEDIATE transaction. A stale lease cannot delete existing rows.
    connectionA.dbPath = lockPath;
    await connectionA.executeQuery(`CREATE TABLE generation_checkpoints (
      job_id TEXT NOT NULL, stage TEXT NOT NULL, status TEXT DEFAULT 'pending',
      artifact TEXT, attempt_count INTEGER DEFAULT 0, error TEXT, started_at TEXT,
      completed_at TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (job_id, stage)
    )`);
    const generationLockId = 'generation:lease-fenced-job';
    assert.equal(await connectionA.acquireProductionOperationLock(generationLockId, 'generation-old', 10000), true);
    await connectionA.executeQuery(
      'UPDATE production_operation_locks SET expires_at = ? WHERE production_id = ?',
      [Date.now() - 1, generationLockId]
    );
    assert.equal(await connectionB.acquireProductionOperationLock(generationLockId, 'generation-new', 10000), true);
    await assert.rejects(
      connectionA.saveGenerationCheckpoint('lease-fenced-job', 'script', {
        status: 'completed', artifact: { title: 'stale result' }
      }, { productionId: generationLockId, owner: 'generation-old' }),
      error => error.code === 'SCENE_EDIT_LEASE_LOST'
    );
    assert.equal(await connectionB.getGenerationCheckpoint('lease-fenced-job', 'script'), null,
      'a stale generation worker cannot write a checkpoint after lease takeover');
    await connectionB.saveGenerationCheckpoint('lease-fenced-job', 'script', {
      status: 'completed', artifact: { title: 'current result' }
    }, { productionId: generationLockId, owner: 'generation-new' });
    await assert.rejects(
      connectionA.deleteGenerationCheckpoints('lease-fenced-job', ['script'], {
        productionId: generationLockId, owner: 'generation-old'
      }),
      error => error.code === 'SCENE_EDIT_LEASE_LOST'
    );
    assert.deepEqual((await connectionB.getGenerationCheckpoint('lease-fenced-job', 'script')).artifact,
      { title: 'current result' }, 'a stale worker cannot delete the current checkpoint');

    await connectionA.executeQuery(`CREATE TABLE generation_jobs (
      id TEXT PRIMARY KEY, status TEXT, stage TEXT, progress INTEGER, production_id TEXT,
      title TEXT, error TEXT, details TEXT, cancel_requested INTEGER,
      updated_at TEXT, completed_at TEXT
    )`);
    await connectionA.executeQuery(
      `INSERT INTO generation_jobs
        (id, status, stage, progress, details, cancel_requested)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['lease-fenced-job', 'running', 'script', 25, '{}', 0]
    );
    await assert.rejects(
      connectionA.updateGenerationJob('lease-fenced-job', {
        status: 'failed', stage: 'script', error: 'stale worker'
      }, { productionId: generationLockId, owner: 'generation-old' }),
      error => error.code === 'SCENE_EDIT_LEASE_LOST'
    );
    assert.equal((await connectionB.getGenerationJob('lease-fenced-job')).status, 'running',
      'a stale worker cannot overwrite generation job state after lease takeover');
    const updatedJob = await connectionB.updateGenerationJob('lease-fenced-job', {
      status: 'completed', stage: 'quality_review', progress: 100,
      details: { accepted: true }
    }, { productionId: generationLockId, owner: 'generation-new' });
    assert.equal(updatedJob.status, 'completed');
    assert.equal(updatedJob.details.accepted, true,
      'the current generation owner can atomically update job state and merge details');
    await connectionA.executeQuery(`CREATE TABLE media_generation_tasks (
      id TEXT PRIMARY KEY, job_id TEXT, production_id TEXT, scene_index INTEGER NOT NULL,
      provider TEXT NOT NULL, model TEXT NOT NULL, external_task_id TEXT, status TEXT,
      request TEXT, provider_data TEXT, output_path TEXT, error TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT, UNIQUE(job_id, scene_index, provider)
    )`);
    const staleMediaLease = { productionId: generationLockId, owner: 'generation-old' };
    const currentMediaLease = { productionId: generationLockId, owner: 'generation-new' };
    await assert.rejects(
      connectionA.createMediaGenerationTask({
        jobId: 'lease-fenced-job', productionId: 'media-production',
        sceneIndex: 0, provider: 'test-provider', model: 'test-model'
      }, staleMediaLease),
      error => error.code === 'SCENE_EDIT_LEASE_LOST'
    );
    const createdMediaTask = await connectionB.createMediaGenerationTask({
      jobId: 'lease-fenced-job', productionId: 'media-production',
      sceneIndex: 0, provider: 'test-provider', model: 'test-model'
    }, currentMediaLease);
    assert.equal(createdMediaTask.createdByThisInvocation, true);
    await assert.rejects(
      connectionA.updateMediaGenerationTask(createdMediaTask.id, {
        status: 'failed', error: 'stale media worker'
      }, staleMediaLease),
      error => error.code === 'SCENE_EDIT_LEASE_LOST'
    );
    await connectionB.updateMediaGenerationTask(createdMediaTask.id, {
      status: 'failed', externalTaskId: 'remote-current'
    }, currentMediaLease);
    await assert.rejects(
      connectionA.claimMediaGenerationTaskForSubmission(
        createdMediaTask.id, 'failed', 'remote-current', [], staleMediaLease
      ),
      error => error.code === 'SCENE_EDIT_LEASE_LOST'
    );
    const mediaClaim = await connectionB.claimMediaGenerationTaskForSubmission(
      createdMediaTask.id, 'failed', 'remote-current', [{ externalTaskId: 'remote-current' }], currentMediaLease
    );
    assert.equal(mediaClaim.claimed, true,
      'only the current lease owner may claim a terminal media task for a new provider submission');
    assert.equal(mediaClaim.task.status, 'submitting');
    assert.equal(mediaClaim.task.external_task_id, null);
    await connectionB.releaseProductionOperationLock(generationLockId, 'generation-new');

    const productionJobLock = 'generation:production-manifest-fence';
    assert.equal(await connectionA.acquireProductionOperationLock(productionJobLock, 'production-job-current', 10000), true);
    await connectionA.executeQuery(`CREATE TABLE productions (
      id TEXT PRIMARY KEY, status TEXT, assets TEXT, timeline TEXT,
      scheduled_publish_time TEXT, priority INTEGER, estimated_duration TEXT
    )`);
    await connectionA.executeQuery(`CREATE TABLE production_snapshots (
      production_id TEXT PRIMARY KEY, strategy TEXT, script TEXT, thumbnail TEXT, seo TEXT
    )`);
    const staleProductionLease = { productionId: productionJobLock, owner: 'production-job-stale' };
    const currentProductionLease = { productionId: productionJobLock, owner: 'production-job-current' };
    const productionRecord = {
      id: 'production-row-under-generation-lock', status: 'processing',
      assets: { video: { visualAssets: [] } }, timeline: { jobId: 'production-manifest-fence' },
      scheduledPublishTime: null, priority: 50, estimatedDuration: 30,
      strategy: { topic: 'lease fence' }, script: { title: 'lease fence' },
      thumbnail: { path: 'thumbnail.jpg' }, seo: { title: 'lease fence' }
    };
    await assert.rejects(
      connectionA.saveProductionData(productionRecord, staleProductionLease),
      error => error.code === 'SCENE_EDIT_LEASE_LOST'
    );
    await connectionB.saveProductionData(productionRecord, currentProductionLease);
    await assert.rejects(
      connectionA.updateProductionData({ ...productionRecord, status: 'failed' }, staleProductionLease),
      error => error.code === 'SCENE_EDIT_LEASE_LOST'
    );
    await connectionB.updateProductionData({ ...productionRecord, status: 'ready' }, currentProductionLease);
    assert.equal((await connectionB.getRow('SELECT status FROM productions WHERE id = ?', [productionRecord.id])).status, 'ready');
    await assert.rejects(
      connectionA.saveProductionSnapshot(productionRecord, staleProductionLease),
      error => error.code === 'SCENE_EDIT_LEASE_LOST'
    );
    await connectionB.saveProductionSnapshot(productionRecord, currentProductionLease);
    assert.ok(await connectionB.getRow('SELECT production_id FROM production_snapshots WHERE production_id = ?', [productionRecord.id]));
    await connectionB.releaseProductionOperationLock(productionJobLock, 'production-job-current');

    await connectionA.executeQuery(`CREATE TABLE production_scenes (
      id TEXT PRIMARY KEY, production_id TEXT NOT NULL, position INTEGER NOT NULL,
      label TEXT, script_text TEXT, prompt TEXT, duration REAL, asset_type TEXT,
      asset_origin TEXT, asset_path TEXT, audio_path TEXT, narration_provider TEXT,
      narration_model TEXT, narration_task_id TEXT, narration_error TEXT,
      narration_generated_at TEXT, narration_cost TEXT, provider TEXT, model TEXT,
      external_task_id TEXT, status TEXT, narration_status TEXT, revision INTEGER,
      locked INTEGER, rights_confirmed INTEGER, provenance_source_ids TEXT,
      contains_synthetic_media INTEGER, estimated_cost TEXT, actual_cost TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(production_id, position)
    )`);
    await connectionA.executeQuery(
      'INSERT INTO production_scenes (id, production_id, position, label) VALUES (?, ?, ?, ?)',
      ['keep-scene', 'guarded-production', 0, 'Original']
    );

    assert.equal(await connectionA.acquireProductionOperationLock(productionJobLock, 'production-job-current', 10000), true);
    await connectionA.executeQuery(`CREATE TABLE production_scene_revisions (
      id TEXT PRIMARY KEY, production_id TEXT, scene_id TEXT, action TEXT, status TEXT,
      before_state TEXT, after_state TEXT, cost_evidence TEXT, error TEXT, created_at TEXT, completed_at TEXT
    )`);
    await connectionA.executeQuery(`CREATE TABLE content_provenance (
      production_id TEXT PRIMARY KEY, sources TEXT, claims TEXT, contains_synthetic_media INTEGER,
      status TEXT, summary TEXT, reviewed_at TEXT, updated_at TEXT
    )`);
    const initialScene = {
      id: 'generation-owned-scene', label: 'Scene 1', scriptText: 'A scene',
      prompt: 'A scene prompt', duration: 5, assetType: 'image',
      assetOrigin: 'generated', assetPath: '/data/scene.png'
    };
    await assert.rejects(
      connectionA.replaceProductionScenes(productionRecord.id, [initialScene], staleProductionLease),
      error => error.code === 'SCENE_EDIT_LEASE_LOST'
    );
    const generationScenes = await connectionB.replaceProductionScenes(
      productionRecord.id, [initialScene], currentProductionLease
    );
    assert.equal(generationScenes.length, 1);
    assert.equal(generationScenes[0].assetPath, '/data/scene.png');
    await assert.rejects(
      connectionA.updateProductionScene(productionRecord.id, initialScene.id, { label: 'Stale edit' }, staleProductionLease),
      error => error.code === 'SCENE_EDIT_LEASE_LOST'
    );
    const updatedGenerationScene = await connectionB.updateProductionScene(
      productionRecord.id, initialScene.id, { label: 'Current edit' }, currentProductionLease
    );
    assert.equal(updatedGenerationScene.label, 'Current edit');
    await assert.rejects(
      connectionA.saveProductionSceneRevision({
        productionId: productionRecord.id, sceneId: initialScene.id, action: 'edit'
      }, staleProductionLease),
      error => error.code === 'SCENE_EDIT_LEASE_LOST'
    );
    await connectionB.saveProductionSceneRevision({
      productionId: productionRecord.id, sceneId: initialScene.id, action: 'edit',
      before: { label: 'Scene 1' }, after: { label: 'Current edit' }
    }, currentProductionLease);
    await assert.rejects(
      connectionA.saveContentProvenance(productionRecord.id, { status: 'stale' }, staleProductionLease),
      error => error.code === 'SCENE_EDIT_LEASE_LOST'
    );
    const savedProvenance = await connectionB.saveContentProvenance(
      productionRecord.id, { status: 'reviewed', containsSyntheticMedia: true }, currentProductionLease
    );
    assert.equal(savedProvenance.status, 'reviewed');
    assert.equal(savedProvenance.containsSyntheticMedia, true);
    await connectionB.releaseProductionOperationLock(productionJobLock, 'production-job-current');
    await assert.rejects(
      connectionA.replaceProductionScenes('guarded-production', [], {
        productionId: 'guarded-production', owner: 'old-owner'
      }),
      error => error.code === 'SCENE_EDIT_LEASE_LOST'
    );
    assert.equal((await connectionA.getProductionScene('guarded-production', 'keep-scene')).label, 'Original',
      'stale manifest replacement cannot delete existing scenes');

    // A failure halfway through replacement rolls back the deletion and the
    // first insert, preserving the previous complete manifest.
    await connectionA.acquireProductionOperationLock('guarded-production', 'atomic-owner', 10000);
    await assert.rejects(connectionA.replaceProductionScenes('guarded-production', [
      { id: 'duplicate-scene', label: 'First', duration: 5 },
      { id: 'duplicate-scene', label: 'Duplicate', duration: 5 }
    ], { productionId: 'guarded-production', owner: 'atomic-owner' }));
    const preserved = await connectionA.getProductionScene('guarded-production', 'keep-scene');
    assert.equal(preserved.label, 'Original',
      'failed multi-row manifest replacement rolls back and preserves the previous manifest');
    await connectionA.releaseProductionOperationLock('guarded-production', 'atomic-owner');
  } finally {
    await Promise.all([
      new Promise(resolve => connectionA.db.close(() => resolve())),
      new Promise(resolve => connectionB.db.close(() => resolve()))
    ]);
    await fs.rm(lockDir, { recursive: true, force: true });
  }

  const database = Object.create(Database.prototype);
  const queries = [];
  database.executeQuery = async (sql, params) => {
    queries.push({ sql, params });
    if (sql.startsWith('INSERT INTO production_operation_locks')) return { changes: 1 };
    return { changes: 1 };
  };
  assert.equal(await database.acquireProductionOperationLock('p1', 'owner-a', 1000), true);
  const upsert = queries.find(item => item.sql.startsWith('INSERT INTO'));
  assert.match(upsert.sql, /ON CONFLICT\(production_id\) DO UPDATE/);
  assert.match(upsert.sql, /expires_at <= \?/);
  assert.match(upsert.sql, /owner = \?/);
  assert.equal(await database.renewProductionOperationLock('p1', 'owner-a', 5000), true);
  assert.match(queries.at(-1).sql, /UPDATE production_operation_locks/);
  assert.match(queries.at(-1).sql, /expires_at > \?/);
  assert.deepEqual(queries.at(-1).params.slice(1), ['p1', 'owner-a', queries.at(-1).params[3]]);
  await database.releaseProductionOperationLock('p1', 'owner-a');
  assert.match(queries.at(-1).sql, /WHERE production_id = \? AND owner = \?/);

  const missingRebuildLock = new SceneRepairService({}, {}, { dataRoot: '/tmp' });
  await assert.rejects(
    missingRebuildLock.rebuild('p-missing-lock'),
    error => error.code === 'SCENE_REBUILD_LOCK_UNAVAILABLE' && error.status === 503
  );
  assert.equal(missingRebuildLock.activeRebuilds.has('p-missing-lock'), false);

  const blockedDb = {
    acquireProductionOperationLock: async () => false,
    renewProductionOperationLock: async () => true,
    releaseProductionOperationLock: async () => { throw new Error('must not release another owner lock'); }
  };
  const blocked = new SceneRepairService(blockedDb, {}, { dataRoot: '/tmp' });
  await assert.rejects(
    blocked.rebuild('p2'),
    error => error.code === 'SCENE_REBUILD_IN_PROGRESS' && error.status === 409
  );
  assert.equal(blocked.activeRebuilds.has('p2'), false, 'local lock is cleared when DB lease is held elsewhere');

  let released = false;
  const ownedDb = {
    acquireProductionOperationLock: async () => true,
    renewProductionOperationLock: async () => true,
    releaseProductionOperationLock: async (_id, owner) => { released = owner.length > 0; }
  };
  const owned = new SceneRepairService(ownedDb, {}, { dataRoot: '/tmp' });
  let rebuildLeaseContext;
  owned.rebuildUnlocked = async (_id, assertLease) => {
    rebuildLeaseContext = assertLease.lease;
    return 'ok';
  };
  assert.equal(await owned.rebuild('p3'), 'ok');
  assert.equal(rebuildLeaseContext.productionId, 'p3');
  assert.equal(typeof rebuildLeaseContext.owner, 'string');
  assert.ok(rebuildLeaseContext.owner.length > 0,
    'rebuild passes its database lease owner into every fenced metadata write');
  assert.equal(released, true, 'owned DB lease is released after work');
  assert.equal(owned.activeRebuilds.has('p3'), false);

  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  let heartbeat;
  global.setInterval = callback => {
    heartbeat = callback;
    return { unref() {} };
  };
  global.clearInterval = () => {};
  try {
    const lostLeaseDb = {
      acquireProductionOperationLock: async () => true,
      renewProductionOperationLock: async () => false,
      releaseProductionOperationLock: async () => {}
    };
    const lostLease = new SceneRepairService(lostLeaseDb, {}, { dataRoot: '/tmp' });
    lostLease.rebuildUnlocked = async (_id, assertLease) => {
      heartbeat();
      await assertLease();
      return 'must-not-commit';
    };
    await assert.rejects(
      lostLease.rebuild('p4'),
      error => error.code === 'SCENE_REBUILD_LEASE_LOST' && error.status === 409
    );
    assert.equal(lostLease.activeRebuilds.has('p4'), false, 'local lock is cleared after lease loss');
  } finally {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  }

  const resumeMissingRenewal = Object.create(ProductionManagementAgent.prototype);
  resumeMissingRenewal.db = {
    acquireProductionOperationLock: async () => true,
    releaseProductionOperationLock: async () => true
  };
  await assert.rejects(
    resumeMissingRenewal.resumeProduction('p-resume-no-renew'),
    error => error.code === 'PRODUCTION_OPERATION_LOCK_UNAVAILABLE' && error.status === 503
  );

  const resumeBlocked = Object.create(ProductionManagementAgent.prototype);
  resumeBlocked.db = {
    acquireProductionOperationLock: async () => false,
    renewProductionOperationLock: async () => true,
    releaseProductionOperationLock: async () => { throw new Error('must not release another resume lock'); }
  };
  await assert.rejects(
    resumeBlocked.resumeProduction('p5'),
    error => error.code === 'PRODUCTION_OPERATION_LOCKED' && error.status === 409
  );

  const resumeSetInterval = global.setInterval;
  const resumeClearInterval = global.clearInterval;
  let resumeHeartbeat;
  global.setInterval = callback => {
    resumeHeartbeat = callback;
    return { unref() {} };
  };
  global.clearInterval = () => {};
  try {
    let resumeReleased = false;
    const resumeLostLease = Object.create(ProductionManagementAgent.prototype);
    resumeLostLease.logger = { error() {} };
    resumeLostLease.db = {
      acquireProductionOperationLock: async () => true,
      renewProductionOperationLock: async () => false,
      releaseProductionOperationLock: async () => { resumeReleased = true; }
    };
    resumeLostLease.resumeProductionUnlocked = async (_id, assertLease) => {
      resumeHeartbeat();
      await assertLease();
      return 'must-not-commit';
    };
    await assert.rejects(
      resumeLostLease.resumeProduction('p6'),
      error => error.code === 'PRODUCTION_RESUME_LEASE_LOST' && error.status === 409
    );
    assert.equal(resumeReleased, true, 'resume lock is released after lease loss');
  } finally {
    global.setInterval = resumeSetInterval;
    global.clearInterval = resumeClearInterval;
  }

  const jobMissingRenewal = Object.create(ProductionManagementAgent.prototype);
  jobMissingRenewal.db = {
    acquireProductionOperationLock: async () => true,
    releaseProductionOperationLock: async () => true
  };
  await assert.rejects(
    jobMissingRenewal.processContent({ jobId: 'job-no-renew' }),
    error => error.code === 'PRODUCTION_JOB_LOCK_UNAVAILABLE' && error.status === 503
  );

  const jobBlocked = Object.create(ProductionManagementAgent.prototype);
  jobBlocked.db = {
    acquireProductionOperationLock: async () => false,
    renewProductionOperationLock: async () => true,
    releaseProductionOperationLock: async () => { throw new Error('must not release another job lock'); }
  };
  await assert.rejects(
    jobBlocked.processContent({ jobId: 'job-locked' }),
    error => error.code === 'PRODUCTION_JOB_LOCKED' && error.status === 409
  );

  let jobHeartbeat;
  let jobReleased = false;
  const jobLeaseLost = Object.create(ProductionManagementAgent.prototype);
  jobLeaseLost.logger = { error() {} };
  jobLeaseLost.db = {
    acquireProductionOperationLock: async () => true,
    renewProductionOperationLock: async () => false,
    releaseProductionOperationLock: async () => { jobReleased = true; }
  };
  jobLeaseLost.processContentUnlocked = async (_input, assertLease) => {
    jobHeartbeat();
    await assertLease();
    return 'must-not-create';
  };
  global.setInterval = callback => {
    jobHeartbeat = callback;
    return { unref() {} };
  };
  try {
    await assert.rejects(
      jobLeaseLost.processContent({ jobId: 'job-lost' }),
      error => error.code === 'PRODUCTION_JOB_LEASE_LOST' && error.status === 409
    );
    assert.equal(jobReleased, true, 'job lock is released after lease loss');
  } finally {
    global.setInterval = resumeSetInterval;
    global.clearInterval = resumeClearInterval;
  }

  // A generation worker that loses its lease must not write either script
  // artifact. If ownership is lost between the two writes, the TTS file must
  // remain unpublished as well.
  const scriptAgent = Object.create(ProductionManagementAgent.prototype);
  scriptAgent.formatScriptForTTS = () => 'tts narration';
  const originalWriteFile = fs.writeFile;
  const attemptedWrites = [];
  fs.writeFile = async (filePath, content) => {
    attemptedWrites.push({ filePath, content });
  };
  try {
    await assert.rejects(
      scriptAgent.processScript({ duration: 12, mainContent: { sections: [] } }, async () => {
        throw Object.assign(new Error('job lease lost'), { code: 'PRODUCTION_JOB_LEASE_LOST' });
      }),
      error => error.code === 'PRODUCTION_JOB_LEASE_LOST'
    );
    assert.equal(attemptedWrites.length, 0, 'a lost job lease prevents the first script file write');

    let leaseChecks = 0;
    await assert.rejects(
      scriptAgent.processScript({ duration: 12, mainContent: { sections: [] } }, async () => {
        leaseChecks += 1;
        if (leaseChecks === 2) {
          throw Object.assign(new Error('job lease lost between script writes'), { code: 'PRODUCTION_JOB_LEASE_LOST' });
        }
      }),
      error => error.code === 'PRODUCTION_JOB_LEASE_LOST'
    );
    assert.equal(attemptedWrites.length, 1, 'lease loss between writes prevents publishing the TTS companion file');
    assert.match(String(attemptedWrites[0].filePath), /_script\.json$/);
  } finally {
    fs.writeFile = originalWriteFile;
  }

  // Lease loss during AI thumbnail generation must not be swallowed by the
  // fallback path or create a copied/placeholder thumbnail.
  const thumbnailAgent = Object.create(ProductionManagementAgent.prototype);
  thumbnailAgent.aiVideoGenerator = {
    generateThumbnail: async () => ({ simulated: true })
  };
  thumbnailAgent.logger = { error() {} };
  const originalMkdir = fs.mkdir;
  const thumbnailSideEffects = [];
  fs.mkdir = async (...args) => { thumbnailSideEffects.push({ type: 'mkdir', args }); };
  try {
    let thumbnailLeaseChecks = 0;
    await assert.rejects(
      thumbnailAgent.processThumbnail({}, { title: 'test' }, async () => {
        thumbnailLeaseChecks += 1;
        if (thumbnailLeaseChecks === 2) {
          throw Object.assign(new Error('job lease lost during thumbnail generation'), { code: 'PRODUCTION_JOB_LEASE_LOST' });
        }
      }),
      error => error.code === 'PRODUCTION_JOB_LEASE_LOST'
    );
    assert.deepEqual(thumbnailSideEffects, [], 'lease loss during thumbnail generation prevents fallback directory creation');
  } finally {
    fs.mkdir = originalMkdir;
  }

  // Lease loss after a failed TTS provider call must not be converted into
  // a simulated narration artifact by the catch/fallback path.
  const audioAgent = Object.create(ProductionManagementAgent.prototype);
  audioAgent.logger = { info() {}, error() {} };
  audioAgent.aiVideoGenerator = {
    lastNarrationResult: {},
    generateTTSAudio: async () => { throw new Error('provider unavailable'); }
  };
  const originalReadFile = fs.readFile;
  const audioWrites = [];
  fs.readFile = async () => 'narration text';
  fs.writeFile = async (...args) => { audioWrites.push(args); };
  try {
    let audioLeaseChecks = 0;
    await assert.rejects(
      audioAgent.generateAudioNarration({
        id: 'lease-lost-audio',
        assets: { script: { ttsPath: '/tmp/narration.txt' } },
        strategy: {},
        estimatedDuration: 10
      }, async () => {
        audioLeaseChecks += 1;
        if (audioLeaseChecks === 2) {
          throw Object.assign(new Error('job lease lost during TTS fallback'), { code: 'PRODUCTION_JOB_LEASE_LOST' });
        }
      }),
      error => error.code === 'PRODUCTION_JOB_LEASE_LOST'
    );
    assert.equal(audioWrites.length, 0, 'lease loss prevents simulated narration fallback writes');
  } finally {
    fs.readFile = originalReadFile;
    fs.writeFile = originalWriteFile;
  }

    // A visual worker that loses its lease after the image provider returns
  // must not persist scene metadata or swallow lease loss as a provider error.
  const visualAgent = Object.create(ProductionManagementAgent.prototype);
  visualAgent.logger = { info() {}, warn() {} };
  visualAgent.db = {
    getChannelProfile: async () => ({ visual_style: 'test' }),
    updateProductionData: async () => { throw new Error('stale visual worker must not persist'); }
  };
  visualAgent.createVisualPromptsFromScript = () => ['scene prompt'];
  let visualGenerations = 0;
  visualAgent.aiVideoGenerator = {
    generateVisualAssets: async () => {
      visualGenerations += 1;
      return [];
    }
  };
  const visualProduction = {
    script: {},
    strategy: {},
    assets: { video: {} },
    timeline: {},
    estimatedDuration: 10
  };
  let visualLeaseChecks = 0;
  await assert.rejects(
    visualAgent.generateVideoContent(visualProduction, async () => {
      visualLeaseChecks += 1;
      if (visualLeaseChecks >= 3) {
        throw Object.assign(new Error('visual job lease lost'), { code: 'PRODUCTION_JOB_LEASE_LOST' });
      }
    }),
    error => error.code === 'PRODUCTION_JOB_LEASE_LOST'
  );
  assert.equal(visualGenerations, 1, 'visual generation stops after lease loss is observed');
  assert.equal(visualLeaseChecks >= 3, true, 'lease loss is rechecked in the provider-error catch path');

  // Losing the production lease while splitting narration must stop scene
  // manifest persistence after FFmpeg returns.
  const sceneInitDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-init-lease-'));
  let sceneInitWrites = 0;
  let segmentRuns = 0;
  const segmentOutputs = [];
  const sceneInit = new SceneRepairService({
    replaceProductionScenes: async () => {
      sceneInitWrites += 1;
      return [];
    }
  }, {
    isUsableAudioFile: async () => true
  }, {
    dataRoot: sceneInitDir,
    runFFmpeg: async args => {
      segmentRuns += 1;
      segmentOutputs.push(args.at(-1));
    }
  });
  let sceneInitLeaseChecks = 0;
  try {
    await assert.rejects(
      sceneInit.initializeProduction({
        id: 'lease-lost-scene-init',
        script: { title: 'Lease test', hook: { text: 'Opening narration' } },
        assets: {
          audio: { path: '/tmp/narration.mp3', status: 'ready', provider: 'test' },
          video: { visualAssets: [] }
        },
        estimatedDuration: 8
      }, {}, async () => {
        sceneInitLeaseChecks += 1;
        if (sceneInitLeaseChecks >= 4) {
          throw Object.assign(new Error('production lease lost after narration split'), { code: 'PRODUCTION_RESUME_LEASE_LOST' });
        }
      }),
      error => error.code === 'PRODUCTION_RESUME_LEASE_LOST'
    );
    assert.equal(segmentRuns, 1, 'the narration segment render completes before lease loss is observed');
    assert.match(path.basename(segmentOutputs[0] || ''), /^000_r1_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mp3$/i,
      'each initialization attempt writes narration to a unique immutable artifact path');
    assert.equal(sceneInitWrites, 0, 'scene manifest is not persisted after lease loss during audio splitting');
  } finally {
    await fs.rm(sceneInitDir, { recursive: true, force: true });
  }

  // Rebuild may need to create a missing scene manifest. The rebuild lease
  // must reach that fallback path; a stale worker must not write scene rows.
  const ensureManifestDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ensure-manifest-lease-'));
  try {
    let ensureManifestWrites = 0;
    const ensureManifestService = new SceneRepairService({
      replaceProductionScenes: async () => {
        ensureManifestWrites += 1;
        return [];
      }
    }, {
      isUsableAudioFile: async () => false
    }, { dataRoot: ensureManifestDir });
    let ensureManifestChecks = 0;
    await assert.rejects(
      ensureManifestService.ensureManifest({
        id: 'lease-lost-ensure-manifest',
        script: { title: 'Manifest lease test' },
        assets: { audio: {}, video: {} },
        estimatedDuration: 8
      }, async () => {
        ensureManifestChecks += 1;
        if (ensureManifestChecks >= 2) {
          throw Object.assign(new Error('scene rebuild lease lost before manifest write'), { code: 'SCENE_REBUILD_LEASE_LOST' });
        }
      }),
      error => error.code === 'SCENE_REBUILD_LEASE_LOST'
    );
    assert.equal(ensureManifestWrites, 0, 'missing scene manifest is not persisted after lease loss');
  } finally {
    await fs.rm(ensureManifestDir, { recursive: true, force: true });
  }

  // Scene metadata edits must share the production operation lock with rebuilds.
  let editLockReleased = false;
  let editCallbackRan = false;
  const editLockedService = new SceneRepairService({
    acquireProductionOperationLock: async () => false,
    releaseProductionOperationLock: async () => { throw new Error('must not release another operation lock'); }
  }, {}, { dataRoot: '/tmp' });
  editLockedService.updateSceneUnlocked = async () => { editCallbackRan = true; };
  await assert.rejects(
    editLockedService.updateScene('edit-locked', 'scene-1', {}),
    error => error.code === 'SCENE_EDIT_IN_PROGRESS' && error.status === 409
  );
  assert.equal(editCallbackRan, false, 'scene edit is not started when another production operation owns the lock');

  const editOwnedService = new SceneRepairService({
    acquireProductionOperationLock: async () => true,
    releaseProductionOperationLock: async (_id, owner) => { editLockReleased = Boolean(owner); }
  }, {}, { dataRoot: '/tmp' });
  editOwnedService.updateSceneUnlocked = async () => { editCallbackRan = true; return 'updated'; };
  assert.equal(await editOwnedService.updateScene('edit-owned', 'scene-1', {}), 'updated');
  assert.equal(editCallbackRan, true, 'scene edit runs after acquiring the production lock');
  assert.equal(editLockReleased, true, 'scene edit releases only its owned lock after completion');

  // Long-running scene regeneration/override operations share the production
  // lock and renew it while provider work is in flight.
  let operationCallbackRan = false;
  const sceneOperationBlocked = new SceneRepairService({
    acquireProductionOperationLock: async () => false,
    releaseProductionOperationLock: async () => { throw new Error('must not release another scene operation lock'); }
  }, {}, { dataRoot: '/tmp' });
  await assert.rejects(
    sceneOperationBlocked.withProductionOperationLease('scene-op-blocked', async () => {
      operationCallbackRan = true;
    }, 'test operation'),
    error => error.code === 'SCENE_EDIT_IN_PROGRESS' && error.status === 409
  );
  assert.equal(operationCallbackRan, false, 'long-running scene operation does not start without the shared lock');

  const operationSetInterval = global.setInterval;
  const operationClearInterval = global.clearInterval;
  let operationHeartbeat;
  let operationReleased = false;
  global.setInterval = callback => {
    operationHeartbeat = callback;
    return { unref() {} };
  };
  global.clearInterval = () => {};
  try {
    const sceneOperationLeaseLost = new SceneRepairService({
      acquireProductionOperationLock: async () => true,
      renewProductionOperationLock: async () => false,
      releaseProductionOperationLock: async () => { operationReleased = true; }
    }, {}, { dataRoot: '/tmp' });
    await assert.rejects(
      sceneOperationLeaseLost.withProductionOperationLease('scene-op-lost', async assertLease => {
        operationHeartbeat();
        await assertLease();
      }, 'test operation'),
      error => error.code === 'SCENE_EDIT_LEASE_LOST' && error.status === 409
    );
    assert.equal(operationReleased, true, 'long-running scene operation releases only its owned lock after lease loss');
  } finally {
    global.setInterval = operationSetInterval;
    global.clearInterval = operationClearInterval;
  }

  // Public mutation entry points must all enter the lease wrapper.
  for (const [method, args] of [
    ['regenerateNarration', ['p', 's', { confirmCost: true }]],
    ['regenerate', ['p', 's', {}]],
    ['setSilenceOverride', ['p', { enabled: true, confirmed: true, reason: 'approved test reason' }]]
  ]) {
    const service = new SceneRepairService({}, {}, { dataRoot: '/tmp' });
    let entered = false;
    service.withProductionOperationLease = async (_id, callback) => callback(async () => {});
    const unlocked = method === 'regenerateNarration' ? 'regenerateNarrationUnlocked'
      : method === 'regenerate' ? 'regenerateUnlocked' : 'setSilenceOverrideUnlocked';
    service[unlocked] = async (...callArgs) => { entered = true; return callArgs.at(-1) instanceof Function; };
    assert.equal(await service[method](...args), true, `${method} forwards the lease assertion to its protected implementation`);
    assert.equal(entered, true, `${method} executes only through its lease wrapper`);
  }

  process.stdout.write('Production operation lock tests passed\\n');
}

run().catch(error => {
  process.stderr.write(`Production operation lock tests failed: ${error.stack || error.message}\\n`);
  process.exitCode = 1;
});
