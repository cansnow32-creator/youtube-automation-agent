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
  simulated: false,
  metrics: { impressions },
  deltas: { ctr: delta, retention: delta, watchHoursPerThousandViews: delta },
  contentAttributes: { appliedLearnings: [{ recommendationId, category }] }
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

process.stdout.write('Applied learning attribution tests passed\\n');
