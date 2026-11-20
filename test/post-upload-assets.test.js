const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PublishingSchedulingAgent } = require('../agents/publishing-scheduling-agent');

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'post-upload-assets-'));
  const captionsPath = path.join(directory, 'captions.srt');
  const thumbnailPath = path.join(directory, 'thumbnail.jpg');
  await fs.writeFile(captionsPath, '1\\n00:00:00,000 --> 00:00:01,000\\nTest caption\\n');
  await fs.writeFile(thumbnailPath, Buffer.from('thumbnail'));

  let videoInsertCalls = 0;
  let captionInsertCalls = 0;
  let thumbnailCalls = 0;
  const state = {
    id: 'schedule-post-upload',
    productionId: 'production-post-upload',
    title: 'Post-upload asset recovery',
    publishTime: new Date(Date.now() - 60000).toISOString(),
    status: 'uploading',
    metadata: {
      seo: { title: 'Post-upload asset recovery', description: 'Test description', tags: ['one', 'two', 'three'] },
      privacyStatus: 'private',
      video: { path: path.join(directory, 'video.mp4') },
      thumbnail: { path: thumbnailPath },
      captions: { path: captionsPath }
    },
    youtubeId: null,
    youtubeUrl: null
  };
  const db = {
    recordScheduleEntryUploadResult: async (id, videoId, metadata) => {
      assert.equal(id, state.id);
      state.status = 'uploaded';
      state.youtubeId = videoId;
      state.youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
      state.metadata = metadata;
      return state;
    },
    updateScheduleEntry: async entry => { Object.assign(state, entry); },
    getLatestScheduleEntry: async () => state
  };
  const agent = Object.create(PublishingSchedulingAgent.prototype);
  agent.db = db;
  agent.publishQueue = [];
  agent.logger = { info() {}, warn() {}, error() {}, success() {} };
  agent.getVideoStream = async () => Buffer.from('video');
  agent.uploadThumbnail = async () => {
    thumbnailCalls++;
    if (thumbnailCalls === 1) throw Object.assign(new Error('thumbnail provider unavailable'), { code: 'THUMBNAIL_TEMPORARY_FAILURE' });
    return { uploaded: true };
  };
  agent.youtube = {
    videos: {
      insert: async () => {
        videoInsertCalls++;
        return { data: { id: 'abcdefghijk' } };
      }
    },
    captions: {
      insert: async () => {
        captionInsertCalls++;
        if (captionInsertCalls === 1) throw Object.assign(new Error('captions API temporarily unavailable'), { code: 'CAPTION_TEMPORARY_FAILURE' });
        return { data: { id: 'caption-1' } };
      }
    },
    thumbnails: { set: async () => ({ data: {} }) }
  };

  try {
    const result = await agent.uploadToYouTube(state, { publishNow: true });
    assert.equal(result.id, 'abcdefghijk');
    assert.equal(videoInsertCalls, 1, 'the video must be uploaded exactly once');
    assert.equal(state.youtubeId, 'abcdefghijk');
    assert.equal(state.status, 'uploaded', 'post-upload asset failures must not fail the accepted video');
    assert.equal(state.metadata.thumbnailUpload.status, 'failed');
    assert.equal(state.metadata.thumbnailUpload.retryRequired, true);
    assert.equal(state.metadata.captionUpload.status, 'failed');
    assert.equal(state.metadata.captionUpload.retryRequired, true);

    const repairedCaptions = await agent.retryCaptionUpload(state.productionId);
    assert.equal(repairedCaptions.metadata.captionUpload.status, 'uploaded');
    assert.equal(repairedCaptions.metadata.captionUpload.retryRequired, false);
    assert.equal(captionInsertCalls, 2);

    const repairedThumbnail = await agent.retryThumbnailUpload(state.productionId);
    assert.equal(repairedThumbnail.metadata.thumbnailUpload.status, 'uploaded');
    assert.equal(repairedThumbnail.metadata.thumbnailUpload.retryRequired, false);
    assert.equal(thumbnailCalls, 2);

    assert.equal(videoInsertCalls, 1, 'asset repair must reuse the recorded video ID and never call videos.insert again');
    assert.equal(state.youtubeId, 'abcdefghijk');
    assert.equal(state.status, 'uploaded');
    process.stdout.write('Post-upload asset recovery tests passed\\n');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
