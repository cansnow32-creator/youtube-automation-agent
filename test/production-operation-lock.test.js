const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
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
  assert.match(queries.at(-1).sql, /expires_at > \\?/);
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

    process.stdout.write('Production operation lock tests passed\\n');
}

run().catch(error => {
  process.stderr.write(`Production operation lock tests failed: ${error.stack || error.message}\\n`);
  process.exitCode = 1;
});
