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

  const blockedDb = {
    acquireProductionOperationLock: async () => false,
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
    releaseProductionOperationLock: async (_id, owner) => { released = owner.length > 0; }
  };
  const owned = new SceneRepairService(ownedDb, {}, { dataRoot: '/tmp' });
  owned.rebuildUnlocked = async () => 'ok';
  assert.equal(await owned.rebuild('p3'), 'ok');
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

  const resumeBlocked = Object.create(ProductionManagementAgent.prototype);
  resumeBlocked.db = {
    acquireProductionOperationLock: async () => false,
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

  const jobBlocked = Object.create(ProductionManagementAgent.prototype);
  jobBlocked.db = {
    acquireProductionOperationLock: async () => false,
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
  const sceneInit = new SceneRepairService({
    replaceProductionScenes: async () => {
      sceneInitWrites += 1;
      return [];
    }
  }, {
    isUsableAudioFile: async () => true
  }, {
    dataRoot: sceneInitDir,
    runFFmpeg: async () => { segmentRuns += 1; }
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
    assert.equal(sceneInitWrites, 0, 'scene manifest is not persisted after lease loss during audio splitting');
  } finally {
    await fs.rm(sceneInitDir, { recursive: true, force: true });
  }

  process.stdout.write('Production operation lock tests passed\\n');
}

run().catch(error => {
  process.stderr.write(`Production operation lock tests failed: ${error.stack || error.message}\\n`);
  process.exitCode = 1;
});
