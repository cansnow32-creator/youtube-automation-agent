const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PublishingSchedulingAgent } = require('../agents/publishing-scheduling-agent');

async function run() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'packaging-audit-'));
  const thumbnailPath = path.join(directory, 'thumbnail.jpg');
  await fs.writeFile(thumbnailPath, Buffer.from('thumbnail-bytes'));

  const entry = {
    id: 'schedule-1',
    productionId: 'production-1',
    youtubeId: 'youtube-1',
    status: 'published',
    metadata: { packagingChangeHistory: [{ source: 'prior', title: 'Earlier title' }] }
  };
  let saved = false;
  const agent = Object.create(PublishingSchedulingAgent.prototype);
  agent.logger = { info() {}, warn() {} };
  agent.youtube = {
    videos: {
      list: async () => ({ data: { items: [{ snippet: { title: 'Before', description: 'Description', tags: ['tag'] } }] } }),
      update: async () => ({ data: { id: 'youtube-1' } })
    },
    thumbnails: { set: async () => ({ data: { items: [] } }) }
  };
  agent.db = {
    getScheduleEntryByYoutubeId: async id => id === 'youtube-1' ? entry : null,
    updateScheduleEntry: async updated => { saved = true; Object.assign(entry, updated); }
  };

  try {
    const result = await agent.applyVideoPackaging('youtube-1', {
      title: 'After',
      thumbnailPath
    }, { title: 'Before' });
    assert.equal(result.auditRecorded, true);
    assert.equal(saved, true);
    assert.equal(entry.metadata.packagingChangeHistory.length, 2);
    assert.equal(entry.metadata.packagingChangeHistory[1].source, 'operator_post_publish');
    assert.equal(entry.metadata.packagingChangeHistory[1].previousTitle, 'Before');
    assert.equal(entry.metadata.packagingChangeHistory[1].title, 'After');
    process.stdout.write('Post-publish packaging audit tests passed\\n');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
