const assert = require('node:assert/strict');
const { ChannelLearningEngine } = require('../utils/channel-learning-engine');

async function run() {
  const snapshots = [];
  const add = (videoId, surface, titleLength, ctr) => snapshots.push({
    videoId,
    measurementWindow: '7d',
    simulated: false,
    metrics: { impressions: 1200, views: 300, ctr, retention: null },
    contentAttributes: { surface, titleLength, format: surface, pillar: 'education' }
  });

  add('long-a', 'long_form', 'concise', 7);
  add('long-b', 'long_form', 'concise', 8);
  add('long-c', 'long_form', 'long', 3);
  add('long-d', 'long_form', 'long', 4);
  add('short-a', 'shorts', 'concise', 10);
  add('short-b', 'shorts', 'concise', 11);
  add('short-c', 'shorts', 'long', 10.2);
  add('short-d', 'shorts', 'long', 11.2);

  const saved = [];
  const engine = new ChannelLearningEngine({
    listPerformanceSnapshots: async options => {
      assert.equal(options.measurementWindow, '7d');
      assert.equal(options.reliableOnly, true);
      return snapshots;
    },
    getChannelStrategy: async () => null,
    saveLearningRecommendation: async recommendation => {
      saved.push(recommendation);
      return recommendation;
    }
  });

  await engine.refreshRecommendations();
  const titleRecommendations = saved.filter(item => item.category === 'titleLength');
  assert.equal(titleRecommendations.length, 1,
    'a title-style signal in long-form must not be manufactured by pooling Shorts with long-form');
  assert.equal(titleRecommendations[0].evidence.surface, 'long_form');
  assert.equal(titleRecommendations[0].proposedChange.surface, 'long_form');

  process.stdout.write('Channel learning surface isolation tests passed\\n');
}

run().catch(error => {
  process.stderr.write(`Channel learning surface isolation tests failed: ${error.stack || error.message}\\n`);
  process.exitCode = 1;
});
