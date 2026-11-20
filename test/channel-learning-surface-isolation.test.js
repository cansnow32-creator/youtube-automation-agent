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
  add('long-c', 'long_form', 'concise', 7.5);
  add('long-d', 'long_form', 'long', 3);
  add('long-e', 'long_form', 'long', 4);
  add('long-f', 'long_form', 'long', 3.5);
  add('short-a', 'shorts', 'concise', 10);
  add('short-b', 'shorts', 'concise', 11);
  add('short-c', 'shorts', 'concise', 10.5);
  add('short-d', 'shorts', 'long', 10.2);
  add('short-e', 'shorts', 'long', 11.2);
  add('short-f', 'shorts', 'long', 10.7);

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
  const insights = engine.buildPerformanceInsights(snapshots, 3, '7d');
  assert.equal(insights.dimensions.titleLength.leader, null,
    'pooled Shorts and long-form cohorts must not produce a cross-surface leader');
  assert.equal(insights.dimensions.titleLength.evidenceStatus, 'cross_surface_not_comparable');
  assert.ok(insights.surfaceBreakdowns.long_form);
  assert.ok(insights.surfaceBreakdowns.shorts);
  assert.equal(insights.surfaceBreakdowns.long_form.titleLength.leader.name, 'concise');
  assert.equal(insights.surfaceBreakdowns.shorts.titleLength.leader.name, 'long');

  const smallGroups = [
    ...snapshots.filter(item => item.contentAttributes.surface === 'long_form').slice(0, 4)
  ];
  const smallSaved = [];
  const smallEngine = new ChannelLearningEngine({
    listPerformanceSnapshots: async () => smallGroups,
    getChannelStrategy: async () => null,
    saveLearningRecommendation: async item => { smallSaved.push(item); return item; }
  });
  await smallEngine.refreshRecommendations();
  assert.equal(smallSaved.some(item => item.category === 'titleLength'), false,
    'two samples in each dimension group are insufficient for a recommendation');

  const missingSurface = engine.extractAttributes({ videoDetails: { title: 'A test' } }, {});
  assert.equal(missingSurface.surface, 'unknown',
    'missing format metadata must not be silently classified as long-form');


  process.stdout.write('Channel learning surface isolation tests passed\\n');
}

run().catch(error => {
  process.stderr.write(`Channel learning surface isolation tests failed: ${error.stack || error.message}\\n`);
  process.exitCode = 1;
});
