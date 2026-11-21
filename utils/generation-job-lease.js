const crypto = require('crypto');

const DEFAULT_GENERATION_JOB_LEASE_MS = 2 * 60 * 60 * 1000;
const DEFAULT_GENERATION_JOB_HEARTBEAT_MS = 30_000;

async function acquireGenerationJobLease(db, jobId, options = {}) {
  if (!jobId) throw new Error('A generation job ID is required for its operation lease');
  if (
    typeof db?.acquireProductionOperationLock !== 'function' ||
    typeof db?.renewProductionOperationLock !== 'function' ||
    typeof db?.releaseProductionOperationLock !== 'function'
  ) {
    const error = new Error('Generation requires database operation-lock support');
    error.code = 'GENERATION_JOB_LOCK_UNAVAILABLE';
    error.status = 503;
    throw error;
  }

  const lockId = 'generation:' + jobId;
  const owner = 'generation_' + process.pid + '_' + crypto.randomUUID();
  const leaseMs = Math.max(60_000, Number(options.leaseMs || DEFAULT_GENERATION_JOB_LEASE_MS));
  const heartbeatMs = Math.max(1_000, Number(options.heartbeatMs || DEFAULT_GENERATION_JOB_HEARTBEAT_MS));
  const acquired = await db.acquireProductionOperationLock(lockId, owner, leaseMs);
  if (!acquired) {
    const error = new Error('Generation job ' + jobId + ' is already being processed by another worker');
    error.code = 'GENERATION_JOB_LOCKED';
    error.status = 409;
    throw error;
  }

  let leaseFailure = null;
  let renewalInFlight = Promise.resolve();
  let released = false;
  const assertLease = async () => {
    await renewalInFlight;
    if (leaseFailure) throw leaseFailure;
  };
  // Expose the exact lock identity so checkpoint writes can fence stale workers
  // inside the same SQLite transaction as their mutation.
  assertLease.lease = Object.freeze({ productionId: lockId, owner });
  const heartbeat = setInterval(() => {
    if (released || leaseFailure) return;
    renewalInFlight = renewalInFlight.then(async () => {
      if (released || leaseFailure) return;
      try {
        const renewed = await db.renewProductionOperationLock(lockId, owner, leaseMs);
        if (!renewed) {
          leaseFailure = Object.assign(
            new Error('Generation job lease lost for ' + jobId),
            { code: 'GENERATION_JOB_LEASE_LOST', status: 409 }
          );
        }
      } catch (cause) {
        leaseFailure = Object.assign(
          new Error('Generation job lease could not be verified for ' + jobId + ': ' + cause.message),
          { code: 'GENERATION_JOB_LEASE_UNVERIFIED', status: 503 }
        );
      }
    });
  }, heartbeatMs);
  heartbeat.unref?.();

  const release = async () => {
    if (released) return;
    released = true;
    clearInterval(heartbeat);
    await renewalInFlight.catch(() => {});
    await db.releaseProductionOperationLock(lockId, owner);
  };

  return { lockId, owner, assertLease, release };
}

module.exports = {
  acquireGenerationJobLease,
  DEFAULT_GENERATION_JOB_LEASE_MS,
  DEFAULT_GENERATION_JOB_HEARTBEAT_MS
};
