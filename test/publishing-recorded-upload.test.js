const assert = require('node:assert/strict');
const { PublishingSchedulingAgent } = require('../agents/publishing-scheduling-agent');

function makeAgent(entry) {
  const agent = Object.create(PublishingSchedulingAgent.prototype);
  agent.publishQueue = [{ ...entry }];
  agent.activePublishes = new Map();
  agent.logger = { info() {}, warn() {}, error() {}, success() {} };
  agent.db = {
    getProductionBundle: async () => ({
      id: entry.productionId,
      review_status: 'approved',
      provenance: { status: 'not_required' }
    }),
    getLatestScheduleEntry: async () => ({ ...entry }),
    updateScheduleEntry: async () => { throw new Error('must not update a recorded upload'); },
    deleteScheduleEntry: async () => { throw new Error('must not delete a recorded upload'); }
  };
  return agent;
}

async function testRecordedVideoIsReconciledBeforeLocalAssetChecks() {
  const entry = {
    id: 'schedule-recorded',
    productionId: 'production-recorded',
    title: 'Already uploaded',
    publishTime: new Date(Date.now() - 60000).toISOString(),
    status: 'failed',
    youtubeId: 'knownVideo01',
    metadata: { audio: null }
  };
  const agent = makeAgent(entry);
  let reconciliations = 0;
  agent.isNarrationReady = async () => false;
  agent.reconcileUploadedVideo = async schedule => {
    reconciliations += 1;
    assert.equal(schedule.youtubeId, 'knownVideo01');
    return { ...schedule, status: 'published' };
  };

  const result = await agent.publishContentOnce(entry.productionId);
  assert.equal(result.status, 'published');
  assert.equal(reconciliations, 1, 'recorded YouTube IDs must be verified before local asset readiness');
}

async function testRecordedVideoCannotBeRescheduledOrDeleted() {
  const entry = {
    id: 'schedule-recorded',
    productionId: 'production-recorded',
    title: 'Already uploaded',
    publishTime: new Date(Date.now() + 3600000).toISOString(),
    status: 'failed',
    youtubeId: 'knownVideo01'
  };
  const agent = makeAgent(entry);

  await assert.rejects(
    agent.rescheduleContent(entry.productionId, new Date(Date.now() + 7200000).toISOString()),
    /recorded YouTube video ID/
  );
  await assert.rejects(
    agent.deleteScheduledContent(entry.productionId),
    /recorded YouTube video ID/
  );
}

async function main() {
  await testRecordedVideoIsReconciledBeforeLocalAssetChecks();
  await testRecordedVideoCannotBeRescheduledOrDeleted();
  process.stdout.write('Recorded YouTube upload protection tests passed\\n');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
