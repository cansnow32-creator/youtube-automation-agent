const assert = require('node:assert/strict');
const { ChannelLearningEngine } = require('../utils/channel-learning-engine');
const { getAppliedPackagingLearning } = require('../utils/packaging-learning');

const engine = new ChannelLearningEngine({});

const experiment = {
  sourceRecommendationId: 'pack-1',
  titleVariants: [{ label: 'Control' }, { label: 'Curiosity' }],
  thumbnailVariants: [{ label: 'Control' }, { label: 'Centered' }]
};
assert.equal(getAppliedPackagingLearning(experiment, 0, 0), null, 'control variants must not count as applied learning');
assert.equal(getAppliedPackagingLearning(experiment, 1, 0, true), null, 'a manual title override must not be attributed to a generated title variant');
assert.deepEqual(
  getAppliedPackagingLearning(experiment, 1, 0).appliedTo,
  ['title'],
  'only the selected non-control title variant should be attributed'
);
assert.deepEqual(
  getAppliedPackagingLearning(experiment, 0, 1).appliedTo,
  ['thumbnail'],
  'only the selected non-control thumbnail variant should be attributed'
);
assert.deepEqual(
  getAppliedPackagingLearning(experiment, 1, 1).appliedTo,
  ['title', 'thumbnail']
);
assert.deepEqual(
  getAppliedPackagingLearning(experiment, 1, 1, true).appliedTo,
  ['thumbnail'],
  'a manual title override may still retain the separately selected thumbnail attribution'
);

const generationOnlyAttributes = engine.extractAttributes(
  { videoDetails: { title: 'A Sample Title' } },
  {
    strategy: { packagingLearning: { recommendationId: 'pack-1' } },
    appliedLearnings: [],
    packagingChangeHistory: [{ source: 'operator_post_publish', title: 'Updated title' }]
  }
);
assert.deepEqual(generationOnlyAttributes.appliedLearnings, [], 'generation guidance alone must not count as applied packaging');
assert.equal(generationOnlyAttributes.packagingChangeHistory[0].title, 'Updated title');

const applied = engine.extractAppliedLearnings({
  packagingLearning: { recommendationId: 'pack-1' },
  approvedScriptLearnings: [
    { recommendationId: 'hook-1', category: 'hookLength' },
    { recommendationId: 'format-1', category: 'format' },
    { recommendationId: 'hook-1', category: 'hookLength' }
  ]
}, [getAppliedPackagingLearning(experiment, 1, 0)]);
assert.deepEqual(applied.map(item => item.recommendationId), ['pack-1', 'hook-1', 'format-1']);
assert.deepEqual(applied[0].appliedTo, ['title']);
assert.deepEqual(applied[1].appliedTo, ['script']);

const snapshot = (id, recommendationId, category, delta, impressions = 1200, window = '7d') => ({
  id,
  videoId: `video-${id}`,
  productionId: `production-${id}`,
  measurementWindow: window,
  measuredAt: new Date(Date.UTC(2026, 10, 20, 12, 0, 0) - (id.charCodeAt(0) * 60000)).toISOString(),
  simulated: false,
  metrics: { impressions },
  deltas: { ctr: delta, retention: delta, watchHoursPerThousandViews: delta },
  contentAttributes: { surface: 'long_form', appliedLearnings: [{ recommendationId, category }] }
});

let feedback = engine.buildAppliedLearningFeedback([
  snapshot('a', 'hook-1', 'hookLength', 8),
  snapshot('b', 'hook-1', 'hookLength', 6)
]);
assert.equal(feedback[0].status, 'positive_signal');
assert.equal(feedback[0].measuredProductions, 2);
assert.equal(feedback[0].medianBaselineDeltaPercent, 7);
assert.match(feedback[0].interpretation, /does not establish causation/);

feedback = engine.buildAppliedLearningFeedback([
  snapshot('a', 'pack-1', 'packaging_experiment', 12)
]);
assert.equal(feedback[0].status, 'insufficient_data');

feedback = engine.buildAppliedLearningFeedback([
  snapshot('a', 'pack-1', 'packaging_experiment', -8),
  snapshot('b', 'pack-1', 'packaging_experiment', -6)
]);
assert.equal(feedback[0].status, 'negative_signal');

feedback = engine.buildAppliedLearningFeedback([
  snapshot('a', 'pack-1', 'packaging_experiment', 15, 1200, '24h'),
  snapshot('b', 'pack-1', 'packaging_experiment', 15, 1200, '7d'),
  { ...snapshot('c', 'pack-1', 'packaging_experiment', 15), simulated: true }
]);
assert.equal(feedback.length, 1);
assert.equal(feedback[0].status, 'insufficient_data', '24h and simulated measurements must not count as mature evidence');

feedback = engine.buildAppliedLearningFeedback([
  snapshot('a', 'format-1', 'format', null),
  snapshot('b', 'format-1', 'format', null)
]);
assert.equal(feedback[0].status, 'inconclusive', 'missing baseline deltas must not be treated as zero or negative');

const mixedSurfaces = [
  snapshot('a', 'surface-1', 'format', 8),
  { ...snapshot('b', 'surface-1', 'format', 6), contentAttributes: { surface: 'shorts', appliedLearnings: [{ recommendationId: 'surface-1', category: 'format' }] } }
];
feedback = engine.buildAppliedLearningFeedback(mixedSurfaces);
assert.equal(feedback.length, 2, 'feedback must remain separated by content surface');
assert.deepEqual(feedback.map(item => item.surface).sort(), ['long_form', 'shorts']);
assert.ok(feedback.every(item => item.measuredProductions === 1),
  'one long-form and one Shorts production must not combine into a two-video signal');

const duplicateProduction = [
  snapshot('a', 'dedupe-1', 'format', 2),
  { ...snapshot('z', 'dedupe-1', 'format', 10), videoId: 'video-a', productionId: 'production-a' },
  { ...snapshot('b', 'dedupe-1', 'format', 6) }
];
feedback = engine.buildAppliedLearningFeedback(duplicateProduction);
assert.equal(feedback[0].measuredProductions, 2, 'multiple snapshots for one production count once');
assert.equal(feedback[0].medianBaselineDeltaPercent, 8,
  'the latest snapshot for a production is used for feedback');

const oldSnapshot = snapshot('c', 'old-1', 'format', 12);
oldSnapshot.measuredAt = '2026-01-01T00:00:00.000Z';
feedback = engine.buildAppliedLearningFeedback([oldSnapshot], { now: new Date('2026-11-20T12:00:00.000Z') });
assert.equal(feedback[0].freshnessStatus, 'stale');
assert.equal(feedback[0].status, 'insufficient_data',
  'stale single-sample evidence cannot produce a positive signal');

const missingIdentity = snapshot('d', 'no-id', 'format', 20);
delete missingIdentity.videoId;
delete missingIdentity.productionId;
assert.deepEqual(engine.buildAppliedLearningFeedback([missingIdentity]), [],
  'snapshots without a stable production identity cannot inflate independent sample counts');

process.stdout.write('Applied learning attribution tests passed\\n');
