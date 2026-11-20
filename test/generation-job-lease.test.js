const assert = require('node:assert/strict');
const { acquireGenerationJobLease } = require('../utils/generation-job-lease');
const { YouTubeAutomationAgent } = require('../index');

function createLockDatabase(options = {}) {
  const locks = new Map();
  const released = [];
  return {
    locks,
    released,
    async acquireProductionOperationLock(lockId, owner) {
      if (options.blocked) return false;
      if (locks.has(lockId)) return false;
      locks.set(lockId, owner);
      return true;
    },
    async renewProductionOperationLock(lockId, owner) {
      if (options.renewalError) throw options.renewalError;
      return locks.get(lockId) === owner && options.renewed !== false;
    },
    async releaseProductionOperationLock(lockId, owner) {
      if (locks.get(lockId) === owner) {
        locks.delete(lockId);
        released.push({ lockId, owner });
      }
    }
  };
}

async function testCompetingWorkersCannotAcquireSameJob() {
  const db = createLockDatabase();
  const first = await acquireGenerationJobLease(db, 'job-1');
  await assert.rejects(
    acquireGenerationJobLease(db, 'job-1'),
    error => error.code === 'GENERATION_JOB_LOCKED' && error.status === 409
  );
  await first.release();
  const second = await acquireGenerationJobLease(db, 'job-1');
  await second.assertLease();
  await second.release();
  assert.equal(db.released.length, 2);
  assert.equal(db.locks.size, 0);
}

async function testLeaseLossFailsClosedAndReleasesOnlyOwnedLock() {
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  let heartbeat;
  global.setInterval = callback => {
    heartbeat = callback;
    return { unref() {} };
  };
  global.clearInterval = () => {};

  const db = createLockDatabase({ renewed: false });
  try {
    const lease = await acquireGenerationJobLease(db, 'job-2');
    heartbeat();
    await assert.rejects(
      lease.assertLease(),
      error => error.code === 'GENERATION_JOB_LEASE_LOST' && error.status === 409
    );
    await lease.release();
    assert.equal(db.released.length, 1);
    assert.equal(db.released[0].lockId, 'generation:job-2');
    assert.equal(db.released[0].owner, lease.owner);
  } finally {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  }
}

async function testMissingLockSupportFailsClosed() {
  await assert.rejects(
    acquireGenerationJobLease({}, 'job-3'),
    error => error.code === 'GENERATION_JOB_LOCK_UNAVAILABLE' && error.status === 503
  );
}

async function testGenerationRunnerHoldsLeaseUntilAllStagesFinish() {
  const locks = new Map();
  const updates = [];
  let resolveAcquired;
  const acquiredSignal = new Promise(resolve => { resolveAcquired = resolve; });
  const db = {
    async acquireProductionOperationLock(lockId, owner) {
      if (locks.has(lockId)) return false;
      locks.set(lockId, owner);
      resolveAcquired();
      return true;
    },
    async renewProductionOperationLock(lockId, owner) {
      return locks.get(lockId) === owner;
    },
    async releaseProductionOperationLock(lockId, owner) {
      if (locks.get(lockId) === owner) locks.delete(lockId);
    },
    async updateGenerationJob(jobId, changes) {
      updates.push({ jobId, changes });
    },
    async setSetting() {}
  };
  const agent = Object.create(YouTubeAutomationAgent.prototype);
  agent.db = db;
  agent.logger = { error() {}, info() {}, warn() {} };
  agent.operator = { notify: async () => {} };

  let releaseProducer;
  let producerStarted;
  const startedSignal = new Promise(resolve => { producerStarted = resolve; });
  const producerGate = new Promise(resolve => { releaseProducer = resolve; });
  let producerCalls = 0;
  agent.generateContent = async () => {
    producerCalls += 1;
    producerStarted();
    await producerGate;
    return {
      contentId: 'production-1',
      title: 'Lease test',
      reviewStatus: 'needs_review',
      qualityScore: 95
    };
  };

  const firstRun = agent.runGenerationJob('job-shared', {
    topic: 'Lease test',
    style: 'explainer',
    length: 'short',
    strategyContext: {}
  });
  await acquiredSignal;
  await startedSignal;
  await assert.rejects(
    agent.runGenerationJob('job-shared', {
      topic: 'Lease test',
      style: 'explainer',
      length: 'short',
      strategyContext: {}
    }),
    error => error.code === 'GENERATION_JOB_LOCKED' && error.status === 409
  );
  assert.equal(producerCalls, 1, 'a competing worker cannot enter the same generation job');
  assert.equal(locks.has('generation:job-shared'), true, 'the lease remains held while the producer is running');

  releaseProducer();
  await firstRun;
  assert.equal(locks.has('generation:job-shared'), false, 'the job lease is released after all stages finish');
  assert.equal(updates.some(item => item.changes.status === 'completed'), true);
}

async function run() {
  await testCompetingWorkersCannotAcquireSameJob();
  await testLeaseLossFailsClosedAndReleasesOnlyOwnedLock();
  await testMissingLockSupportFailsClosed();
  await testGenerationRunnerHoldsLeaseUntilAllStagesFinish();
  console.log('Generation job lease tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
