const assert = require('node:assert/strict');
const { ProductionReadinessService } = require('../utils/production-readiness-service');

const NOW = new Date('2026-11-19T12:00:00.000Z');

function serviceWith(latest) {
  return new ProductionReadinessService({
    getLatestReadinessRun: async () => latest
  }, {}, { now: () => NOW });
}

async function rejectsWithStatus(promise, status, message) {
  await assert.rejects(promise, error => {
    assert.equal(error.status, status);
    assert.match(error.message, message);
    return true;
  });
}

async function run() {
  const unverified = serviceWith(null);
  await rejectsWithStatus(
    unverified.assertReady('Autonomous production'),
    409,
    /Run the verified production readiness check/
  );

  const stale = serviceWith({
    status: 'passed',
    completed_at: '2026-11-18T11:59:59.000Z',
    checks: []
  });
  await rejectsWithStatus(
    stale.assertReady('Automated generation'),
    409,
    /older than 24 hours/
  );

  const failed = serviceWith({
    status: 'failed',
    completed_at: NOW.toISOString(),
    checks: [{ id: 'youtube_access', blocking: true, status: 'failed' }]
  });
  await rejectsWithStatus(
    failed.assertReady('Autonomous production'),
    409,
    /youtube_access/
  );

  const passed = serviceWith({
    status: 'passed',
    completed_at: NOW.toISOString(),
    checks: [{ id: 'youtube_access', blocking: true, status: 'passed' }]
  });
  const passedSummary = await passed.assertReady('Autonomous production');
  assert.equal(passedSummary.status, 'passed');

  const warning = serviceWith({
    status: 'warning',
    completed_at: NOW.toISOString(),
    checks: [
      { id: 'youtube_access', blocking: true, status: 'passed' },
      { id: 'image_provider', blocking: false, status: 'skipped' }
    ]
  });
  const warningSummary = await warning.assertReady('Automated generation');
  assert.equal(warningSummary.status, 'warning');
  assert.deepEqual(warningSummary.blockingFailures, []);

  process.stdout.write('Production readiness gate tests passed\\n');
}

run().catch(error => {
  process.stderr.write(`Production readiness gate tests failed: ${error.stack || error.message}\\n`);
  process.exitCode = 1;
});
