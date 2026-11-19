const assert = require('node:assert/strict');
const { ContentStrategyAgent } = require('../agents/content-strategy-agent');

function snapshot(videoId, pillar, format, durationBucket, score, views, window = '7d') {
  return {
    videoId,
    measurementWindow: window,
    measuredAt: window === '7d' ? '2026-11-19T00:00:00.000Z' : '2026-11-18T00:00:00.000Z',
    contentAttributes: { pillar, format, durationBucket },
    metrics: {
      views,
      performanceScore: score,
      ctr: 5,
      retention: 45,
      engagementRate: 3
    }
  };
}

async function run() {
  const insufficientAgent = new ContentStrategyAgent({
    listPerformanceSnapshots: async () => [
      snapshot('a1', 'Education', 'tutorial', '3_to_8m', 90, 1000),
      snapshot('a2', 'Education', 'tutorial', '3_to_8m', 88, 950),
      snapshot('b1', 'News', 'review', '8_to_15m', 60, 500),
      snapshot('b2', 'News', 'review', '8_to_15m', 62, 520)
    ]
  }, {});
  const insufficient = await insufficientAgent.buildPerformancePlanGuidance();
  assert.equal(insufficient.status, 'insufficient_evidence');
  assert.equal(insufficient.preferences.length, 0, 'two videos per cohort must not create a planning preference');

  const snapshots = [];
  for ((let i = 1; i <= 3; i++)) {
    snapshots.push(snapshot(`edu-${i}`, 'Education', 'tutorial', '3_to_8m', 90 + i, 1000 + i * 100));
    snapshots.push(snapshot(`news-${i}`, 'News', 'review', '8_to_15m', 60 + i, 500 + i * 50));
  }
  // A second measurement window for an existing video must not inflate the sample.
  snapshots.push(snapshot('edu-1', 'Education', 'tutorial', '3_to_8m', 20, 10, '24h'));

  const agent = new ContentStrategyAgent({
    listPerformanceSnapshots: async () => snapshots
  }, {});
  const guidance = await agent.buildPerformancePlanGuidance();
  assert.equal(guidance.status, 'evidence_backed');
  assert.equal(guidance.independentVideoCount, 6, 'each video must count once across measurement windows');
  assert.equal(guidance.minimumSamplesPerGroup, 3);

  const byDimension = Object.fromEntries(guidance.preferences.map(item => [item.dimension, item]));
  assert.equal(byDimension.pillar.prefer, 'Education');
  assert.equal(byDimension.format.prefer, 'tutorial');
  assert.equal(byDimension.length.prefer, 'medium', '3-to-8-minute winning cohort maps to medium planning length');
  assert.ok(guidance.preferences.every(item => item.sampleSize >= 3 && item.comparisonSampleSize >= 3));

  const plan = [
    { topic: 'News story', pillar: 'News', format: 'review', length: 'long', rationale: 'Original rationale.' },
    { topic: 'Education guide', pillar: 'Education', format: 'tutorial', length: 'medium', rationale: 'Useful guide.' }
  ];
  const ranked = agent.applyPerformanceGuidance(plan, guidance);
  assert.equal(ranked[0].topic, 'Education guide', 'evidence-matching plan should rank first');
  assert.match(ranked[0].rationale, /Performance evidence:/);
  assert.equal(ranked[1].topic, 'News story');
  assert.equal(plan[0].topic, 'News story', 'ranking must not mutate the caller plan');

  const noGuidance = agent.applyPerformanceGuidance(plan, { preferences: [] });
  assert.deepEqual(noGuidance, plan, 'no evidence must leave plan unchanged');

  console.log('✓ Performance plan guidance requires independent samples and only re-ranks suitable plans');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
