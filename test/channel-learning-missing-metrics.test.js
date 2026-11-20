const assert = require('node:assert/strict');
const { ChannelLearningEngine } = require('../utils/channel-learning-engine');

const engine = new ChannelLearningEngine({});

const metrics = engine.normalizeMetrics({
  analytics: {
    views: { totalViews: 250, totalImpressions: 1200, averageCTR: null },
    watchTime: { totalWatchTime: null, averageViewDuration: null, averageViewPercentage: null },
    engagement: { engagementRate: null },
    outcomes: { subscribersAvailable: false, revenueAvailable: false }
  },
  performance: { score: 42 }
});

assert.equal(metrics.views, 250);
assert.equal(metrics.impressions, 1200);
assert.equal(metrics.ctr, null, 'unavailable CTR must remain null, not become zero');
assert.equal(metrics.retention, null, 'unavailable retention must remain null, not become zero');
assert.equal(metrics.watchMinutes, null);
assert.equal(metrics.watchHours, null);
assert.equal(metrics.engagementRate, null);
assert.equal(metrics.performanceScore, 42);

const noOptionalMetrics = [
  { metrics: { impressions: 1200, ctr: null, retention: null } },
  { metrics: { impressions: 900, ctr: null, retention: null } }
];
assert.deepEqual(
  engine.buildChannelRecommendations(noOptionalMetrics),
  [],
  'missing CTR and retention must not produce false negative recommendations'
);

const measuredRetentionOnly = [
  { metrics: { impressions: 1200, ctr: null, retention: 20 } },
  { metrics: { impressions: 900, ctr: null, retention: 30 } }
];
const retentionRecommendations = engine.buildChannelRecommendations(measuredRetentionOnly);
assert.equal(retentionRecommendations.length, 1);
assert.equal(retentionRecommendations[0].category, 'retention');
assert.equal(retentionRecommendations[0].evidence.sampleSize, 2);

const dimensionSamples = [
  { contentAttributes: { titleLength: 'concise' }, metrics: { ctr: 6 } },
  { contentAttributes: { titleLength: 'concise' }, metrics: { ctr: 7 } },
  { contentAttributes: { titleLength: 'long' }, metrics: { ctr: null } },
  { contentAttributes: { titleLength: 'long' }, metrics: { ctr: null } }
];
assert.deepEqual(
  engine.buildDimensionRecommendations(dimensionSamples),
  [],
  'an unmeasured cohort must not be treated as a zero-performance cohort'
);

process.stdout.write('Channel learning missing-metric tests passed\\n');
