const assert = require('node:assert/strict');
const { DailyAutomation } = require('../schedules/daily-automation');

function makeScheduler(concepts, generateContent) {
  const events = [];
  const settings = new Map([['content_buffer_days', '3'], ['posting_frequency', 'daily']]);
  const db = {
    async listVideoConcepts(limit) {
      assert.equal(limit, 100);
      return concepts;
    },
    async getSetting(key) { return settings.get(key) || null; },
    async setSetting(key, value) { settings.set(key, value); }
  };
  const scheduler = new DailyAutomation({
    publishing: { async getUpcomingSchedule() { return []; } }
  }, db, { generateContent });
  scheduler.logAutomationEvent = async (type, status, data) => events.push({ type, status, data });
  scheduler.sendFailureNotification = async () => {};
  return { scheduler, events };
}

async function run() {
  let queued = false;
  const blocked = makeScheduler([], async () => {
    queued = true;
    return { id: 'must-not-queue' };
  });
  await blocked.scheduler.runDailyContentGeneration();
  assert.equal(queued, false, 'Queue adapter must not run without an approved concept');
  assert.ok(blocked.events.some(event =>
    event.type === 'daily_content_generation' &&
    event.status === 'error' &&
    /approved/i.test(event.data.error)
  ), 'Blocked scheduler run must be recorded');

  let received = null;
  const approvedConcept = {
    id: 'approved-concept-1',
    status: 'approved',
    concept: { name: 'Approved cinematic concept', scenePlan: [{ scene: 1 }, { scene: 2 }] }
  };
  const allowed = makeScheduler([{
    id: approvedConcept.id,
    status: approvedConcept.status,
    concept: approvedConcept.concept
  }], async input => {
    received = input;
    return { id: 'queued-job-1' };
  });
  await allowed.scheduler.runDailyContentGeneration();
  assert.deepEqual(received, {
    source: 'scheduler',
    approvedVideoConcept: approvedConcept.concept,
    approvedVideoConceptId: approvedConcept.id
  }, 'Queue adapter must receive the exact approved concept and ID');
  assert.ok(allowed.events.some(event =>
    event.type === 'daily_content_generation' &&
    event.status === 'queued' &&
    event.data.jobId === 'queued-job-1'
  ), 'Approved scheduler run must be recorded as queued');

  process.stdout.write('Daily scheduler approved-concept gate tests passed\\n');
}

run().catch(error => {
  process.stderr.write('Daily scheduler approved-concept gate tests failed: ' + (error.stack || error.message) + '\\n');
  process.exitCode = 1;
});
