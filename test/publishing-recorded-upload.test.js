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

async function testThumbnailFailureNeverRepeatsVideoUpload() {
  const entry = {
    id: 'schedule-thumbnail-retry',
    productionId: 'production-thumbnail-retry',
    title: 'Thumbnail recovery test',
    publishTime: new Date(Date.now() - 60000).toISOString(),
    status: 'uploading',
    metadata: {
      seo: { title: 'Thumbnail recovery test', description: 'A valid test description', tags: ['one', 'two', 'three'], categoryId: '22', defaultLanguage: 'en' },
      video: { path: '/virtual/test.mp4' },
      thumbnail: { path: '/virtual/test.jpg' }
    }
  };
  let stored = { ...entry, metadata: { ...entry.metadata } };
  let videoInsertCalls = 0;
  let thumbnailCalls = 0;
  const agent = Object.create(PublishingSchedulingAgent.prototype);
  agent.publishQueue = [stored];
  agent.activePublishes = new Map();
  agent.logger = { info() {}, warn() {}, error() {}, success() {} };
  agent.getVideoStream = async () => ({});
  agent.uploadThumbnail = async videoId => {
    thumbnailCalls += 1;
    assert.equal(videoId, 'video-id-accepted');
    if (thumbnailCalls === 1) throw new Error('thumbnail provider temporarily unavailable');
    return { videoId, uploaded: true };
  };
  agent.youtube = {
    videos: {
      insert: async () => {
        videoInsertCalls += 1;
        return { data: { id: 'video-id-accepted' } };
      }
    }
  };
  agent.db = {
    recordScheduleEntryUploadResult: async (id, videoId, metadata) => {
      stored = {
        ...stored, id, status: 'uploaded', youtubeId: videoId,
        youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`, metadata
      };
      return { ...stored };
    },
    updateScheduleEntry: async next => { stored = { ...next }; },
    getLatestScheduleEntry: async () => ({ ...stored, metadata: { ...stored.metadata } })
  };

  const uploaded = await agent.uploadToYouTube(entry);
  assert.equal(uploaded.id, 'video-id-accepted');
  assert.equal(videoInsertCalls, 1);
  assert.equal(stored.youtubeId, 'video-id-accepted');
  assert.equal(stored.metadata.thumbnailUpload.status, 'failed');
  assert.equal(stored.metadata.thumbnailUpload.retryRequired, true);

  const repaired = await agent.retryThumbnailUpload(entry.productionId);
  assert.equal(repaired.metadata.thumbnailUpload.status, 'uploaded');
  assert.equal(videoInsertCalls, 1, 'thumbnail repair must never call videos.insert');
  assert.equal(thumbnailCalls, 2);
}

async function main() {
  await testRecordedVideoIsReconciledBeforeLocalAssetChecks();
  await testRecordedVideoCannotBeRescheduledOrDeleted();
  await testThumbnailFailureNeverRepeatsVideoUpload();
  process.stdout.write('Recorded YouTube upload protection tests passed\\n');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
