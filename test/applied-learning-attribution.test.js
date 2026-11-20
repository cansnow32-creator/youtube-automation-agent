const assert = require('node:assert/strict');
const { ChannelLearningEngine } = require('../utils/channel-learning-engine');
const { getAppliedPackagingLearning } = require('../utils/packaging-learning');
const { verifyAppliedScriptLearnings, parseMinuteRange } = require('../utils/script-learning-verification');

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

const scriptGuidance = [
  { recommendationId: 'hook-1', category: 'hookLength', proposedChange: { target: 'future_scripts' } },
  { recommendationId: 'format-1', category: 'format', proposedChange: { target: 'future_plans' } },
  { recommendationId: 'hook-1', category: 'hookLength', proposedChange: { target: 'future_scripts' } }
];
const applied = engine.extractAppliedLearnings({}, [getAppliedPackagingLearning(experiment, 1, 0)]);
assert.deepEqual(applied.map(item => item.recommendationId), ['pack-1']);
assert.deepEqual(applied[0].appliedTo, ['title']);
const guidance = engine.extractLearningGuidance(scriptGuidance);
assert.deepEqual(guidance.map(item => item.recommendationId), ['hook-1', 'format-1']);
assert.ok(guidance.every(item => item.status === 'provided_to_generation_not_verified_as_applied'),
  'script guidance must remain separately auditable and must not be reported as verified application');

const hookGuidance = [
  { recommendationId: 'hook-concise', category: 'hookLength', proposedChange: { prefer: 'concise' } },
  { recommendationId: 'hook-extended', category: 'hookLength', proposedChange: { prefer: 'extended' } },
  { recommendationId: 'format-unknown', category: 'format', proposedChange: { prefer: 'list' } },
  { recommendationId: 'hook-free-text', category: 'hookLength', proposedChange: { prefer: 'make the hook engaging' } }
];
const verifiedHook = verifyAppliedScriptLearnings(hookGuidance, {
  hook: { text: 'A short hook that clearly states the viewer benefit.' }
});
assert.deepEqual(verifiedHook.map(item => item.recommendationId), ['hook-concise'],
  'only exact, measurable hook-length preferences matching generated output may be verified');
assert.equal(verifiedHook[0].observedWordCount, 9);
assert.equal(verifiedHook[0].verificationMethod, 'generated_hook_word_count_threshold_40');

assert.deepEqual(parseMinuteRange('8-12 minutes'), { minimum: 8, maximum: 12 });
assert.deepEqual(parseMinuteRange('8 to 12 min'), { minimum: 8, maximum: 12 });
assert.equal(parseMinuteRange('make it longer'), null, 'free-text length preferences must not be guessed');
const lengthGuidance = [
  { recommendationId: 'length-range', category: 'length', proposedChange: { prefer: '8-12 minutes' } },
  { recommendationId: 'length-outside', category: 'length', proposedChange: { prefer: '2-4 minutes' } },
  { recommendationId: 'length-free-text', category: 'length', proposedChange: { prefer: 'make it longer' } },
  { recommendationId: 'format-not-verified', category: 'format', proposedChange: { prefer: 'list' } }
];
const longScript = {
  hook: { text: 'A useful opening hook.' },
  introduction: { greeting: 'Welcome.', topicIntro: 'Today we explain the topic.', valueProposition: 'You will learn the method.', credibility: 'We will use supplied evidence.' },
  mainContent: { sections: [{ title: 'Core steps', content: ['useful '.repeat(1290)], duration: 600 }] },
  conclusion: { recap: ['Review the key points.'], finalThought: 'Apply the steps carefully.' },
  callToAction: { subscribe: 'Subscribe for more.' }
};
const verifiedLength = verifyAppliedScriptLearnings(lengthGuidance, longScript);
assert.deepEqual(verifiedLength.map(item => item.recommendationId), ['length-range'],
  'only explicit minute ranges containing the generated script estimate may be verified');
assert.equal(verifiedLength[0].estimatedMinutes, 10.16);
assert.equal(verifiedLength[0].wordsPerMinuteAssumption, 130);
assert.equal(verifiedLength[0].verificationMethod, 'generated_spoken_word_count_estimated_minutes_130_wpm');
const appliedScriptAttributes = engine.extractAttributes(
  { videoDetails: { title: 'A Sample Title' } },
  {
    strategy: { approvedScriptLearnings: hookGuidance },
    script: { hook: { text: 'A short hook that clearly states the viewer benefit.' }, metadata: { verifiedAppliedLearnings: verifiedHook } }
  }
);
assert.deepEqual(appliedScriptAttributes.appliedLearnings, [{
  recommendationId: 'hook-concise',
  category: 'hookLength',
  appliedTo: ['hook'],
  source: 'generated_hook_word_count_threshold_40'
}]);
assert.equal(appliedScriptAttributes.learningGuidance.find(item => item.recommendationId === 'hook-concise').status, 'verified_applied');
assert.equal(appliedScriptAttributes.learningGuidance.find(item => item.recommendationId === 'hook-extended').status,
  'provided_to_generation_not_verified_as_applied');
const appliedLengthAttributes = engine.extractAttributes(
  { videoDetails: { title: 'A Sample Title' } },
  {
    strategy: { approvedScriptLearnings: lengthGuidance },
    script: { ...longScript, metadata: { verifiedAppliedLearnings: [{ ...verifiedLength[0], status: 'forged_metadata_should_be_ignored' }] } }
  }
);
assert.deepEqual(appliedLengthAttributes.appliedLearnings, [{
  recommendationId: 'length-range',
  category: 'length',
  appliedTo: ['script_length'],
  source: 'generated_spoken_word_count_estimated_minutes_130_wpm'
}], 'attribution must be recomputed from script output rather than trusting stored metadata');
assert.equal(appliedLengthAttributes.learningGuidance.find(item => item.recommendationId === 'length-range').status,
  'verified_applied');
assert.equal(appliedLengthAttributes.learningGuidance.find(item => item.recommendationId === 'format-not-verified').status,
  'provided_to_generation_not_verified_as_applied');

const formatLearnings = ['tutorial', 'list', 'review', 'story', 'explainer'].map(format => ({
  recommendationId: `format-${format}`,
  category: 'format',
  proposedChange: { prefer: format, target: 'future_scripts' }
}));
const apparentlyStructuredScript = {
  hook: { text: 'A short opening.' },
  introduction: { greeting: 'Welcome.', topicIntro: 'Today is the topic.', valueProposition: 'Learn the basics.', credibility: 'We use evidence.' },
  mainContent: { sections: [
    { title: 'Step 1', steps: [{ title: 'Do this', description: 'A clear explanation.' }] },
    { title: 'Top item', items: [{ number: 1, title: 'First', description: 'An item.' }] },
    { title: 'Explanation', points: ['Point one', 'Point two', 'Point three'] }
  ] },
  conclusion: { recap: ['Summary.'], finalThought: 'Closing thought.' },
  callToAction: 'Subscribe.',
  metadata: { verifiedAppliedLearnings: formatLearnings.map(item => ({
    recommendationId: item.recommendationId,
    category: 'format',
    status: 'verified_applied',
    verificationMethod: 'model_self_reported_format'
  })) }
};
assert.deepEqual(verifyAppliedScriptLearnings(formatLearnings, apparentlyStructuredScript), [],
  'format labels and loosely structured sections are not sufficient independent proof of format application');
const formatAttributes = engine.extractAttributes(
  { videoDetails: { title: 'A Sample Title' } },
  { strategy: { approvedScriptLearnings: formatLearnings }, script: apparentlyStructuredScript }
);
assert.deepEqual(formatAttributes.appliedLearnings, [],
  'format recommendations must not be attributed from self-reported or forged verification metadata');
assert.ok(formatAttributes.learningGuidance.every(item =>
  item.status === 'provided_to_generation_not_verified_as_applied'),
  'all unsupported format categories remain guidance-only');
assert.deepEqual(engine.extractAppliedLearnings(
  { approvedScriptLearnings: [] },
  [],
  { metadata: { verifiedAppliedLearnings: [{ ...verifiedHook[0], recommendationId: 'unapproved' }] } }
), [], 'unmatched or unapproved verification metadata must not be attributed');

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
  { ...snapshot('a', 'dedupe-1', 'format', 2), measuredAt: '2026-11-18T00:00:00.000Z' },
  { ...snapshot('z', 'dedupe-1', 'format', 10), videoId: 'video-a', productionId: 'production-a', measuredAt: '2026-11-19T00:00:00.000Z' },
  { ...snapshot('b', 'dedupe-1', 'format', 6), measuredAt: '2026-11-17T00:00:00.000Z' }
];
feedback = engine.buildAppliedLearningFeedback(duplicateProduction);
assert.equal(feedback[0].measuredProductions, 2, 'multiple snapshots for one production count once');
assert.equal(feedback[0].medianBaselineDeltaPercent, 8,
  'the latest snapshot for a production is used for feedback');

const bridgedDuplicateProduction = [
  { ...snapshot('a', 'bridge-1', 'format', 2), productionId: 'production-bridge', videoId: undefined, measuredAt: '2026-11-18T00:00:00.000Z' },
  { ...snapshot('b', 'bridge-1', 'format', 10), productionId: 'production-bridge', videoId: 'youtube-bridge', measuredAt: '2026-11-19T00:00:00.000Z' },
  { ...snapshot('c', 'bridge-1', 'format', 6), productionId: undefined, videoId: 'youtube-bridge', measuredAt: '2026-11-17T00:00:00.000Z' }
];
feedback = engine.buildAppliedLearningFeedback(bridgedDuplicateProduction);
assert.equal(feedback[0].measuredProductions, 1,
  'production-only and video-only records connected by a bridge record must count as one published production');

const conflictingSurface = [
  { ...snapshot('a', 'surface-conflict-1', 'format', 8), productionId: 'production-conflict', videoId: 'youtube-conflict' },
  { ...snapshot('b', 'surface-conflict-1', 'format', 8), productionId: 'production-conflict', videoId: 'youtube-conflict',
    contentAttributes: { surface: 'shorts', appliedLearnings: [{ recommendationId: 'surface-conflict-1', category: 'format' }] } }
];
feedback = engine.buildAppliedLearningFeedback(conflictingSurface);
assert.deepEqual(feedback, [],
  'conflicting surface metadata for the same published production must be excluded instead of counted in both cohorts');

const oldSnapshots = [
  { ...snapshot('c', 'old-1', 'format', 12), measuredAt: '2026-01-01T00:00:00.000Z' },
  { ...snapshot('d', 'old-1', 'format', 10), measuredAt: '2026-01-02T00:00:00.000Z' }
];
feedback = engine.buildAppliedLearningFeedback(oldSnapshots, { now: new Date('2026-11-20T12:00:00.000Z') });
assert.equal(feedback[0].freshnessStatus, 'stale');
assert.equal(feedback[0].status, 'inconclusive',
  'stale multi-sample evidence cannot retain a positive or negative signal');

const missingIdentity = snapshot('d', 'no-id', 'format', 20);
delete missingIdentity.videoId;
delete missingIdentity.productionId;
assert.deepEqual(engine.buildAppliedLearningFeedback([missingIdentity]), [],
  'snapshots without a stable production identity cannot inflate independent sample counts');

process.stdout.write('Applied learning attribution tests passed\\n');
