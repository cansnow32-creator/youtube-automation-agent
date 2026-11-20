const assert = require('node:assert/strict');
const { PublishingSchedulingAgent } = require('../agents/publishing-scheduling-agent');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function main() {
  const uploadStarted = deferred();
  const allowUpload = deferred();
  let uploadCalls = 0;
  const state = {
    id: 'schedule-short-1',
    productionId: 'short-1',
    title: 'Short title',
    publishTime: new Date(Date.now() - 60000).toISOString(),
    status: 'scheduled',
    priority: 60,
    metadata: {
      shortClipId: 'short-1',
      contentType: 'short',
      audio: { intentionalSilence: true },
      video: { path: '/tmp/short.mp4' }
    },
    youtubeId: null,
    youtubeUrl: null
  };
  const db = {
    getProductionBundle: async () => null,
    getShortClip: async () => ({
      id: 'short-1',
      status: 'failed',
      approvedAt: new Date().toISOString(),
      inheritedEvidence: { ready: true }
    }),
    getLatestScheduleEntry: async () => ({ ...state, metadata: { ...state.metadata } }),
    claimScheduleEntryForUpload: async id => {
      if (id !== state.id || !['scheduled', 'paused', 'failed'].includes(state.status) || state.youtubeId) return null;
      state.status = 'uploading';
      return { ...state, metadata: { ...state.metadata } };
    },
    updateScheduleEntry: async entry => { Object.assign(state, entry); }
  };
  const makeAgent = () => {
    const agent = Object.create(PublishingSchedulingAgent.prototype);
    agent.db = db;
    agent.logger = { info() {}, warn() {}, error() {}, success() {} };
    agent.publishQueue = [{ ...state, metadata: { ...state.metadata } }];
    agent.isNarrationReady = async () => true;
    agent.syncShortStatus = async () => null;
    agent.uploadToYouTube = async () => {
      uploadCalls += 1;
      uploadStarted.resolve();
      await allowUpload.promise;
      return { id: 'youtube-video-1' };
    };
    return agent;
  };

  const first = makeAgent();
  const second = makeAgent();
  const firstRun = first.publishContentOnce('short-1');
  const secondRun = second.publishContentOnce('short-1');
  try {
    await uploadStarted.promise;
    const secondResult = await Promise.allSettled([secondRun]);
    assert.equal(uploadCalls, 1, 'two independent publisher instances must not upload the same Short');
    assert.equal(secondResult[0].status, 'rejected');
    assert.equal(secondResult[0].reason.code, 'UPLOAD_OUTCOME_UNKNOWN');
    assert.equal(state.status, 'uploading', 'the durable claim blocks a second worker while the first upload is active');
  } finally {
    allowUpload.resolve();
  }
  const firstResult = await firstRun;
  assert.equal(firstResult.status, 'published');
  assert.equal(state.status, 'published');
  assert.equal(state.youtubeId, 'youtube-video-1');
  process.stdout.write('Publishing atomic claim integration tests passed\\n');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
