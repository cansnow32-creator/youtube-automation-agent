const assert = require('node:assert/strict');
const {
  isApprovedPackagingLearning,
  getApprovedPackagingLearning
} = require('../utils/packaging-learning');
const { ThumbnailDesignerAgent } = require('../agents/thumbnail-designer-agent');

const legacy = {
  status: 'approved',
  proposedChange: { experiment: 'title_thumbnail_variant' }
};
const adoptedWinner = {
  id: 'learning-1',
  status: 'approved',
  category: 'packaging_experiment',
  title: 'Reuse the Curiosity packaging pattern',
  rationale: 'The curiosity variant improved qualified CTR.',
  confidence: 'high',
  evidence: {
    liftPercent: 18.5, zScore: 2.1,
    freshness: {
      status: 'fresh', sampleCount: 6, maxAgeDays: 90,
      oldestMeasuredAt: '2026-11-01T00:00:00.000Z',
      latestMeasuredAt: '2026-11-19T00:00:00.000Z'
    }
  },
  proposedChange: {
    target: 'future_packaging',
    experiment: 'validated_title_thumbnail_pattern',
    winningTitle: 'A proven title pattern',
    winningThumbnailPattern: 'Centered composition',
    winningArmLabel: 'Curiosity / Centered composition',
    hypothesis: 'Curiosity framing improves clicks'
  }
};

assert.equal(isApprovedPackagingLearning(legacy), false, 'legacy packaging approvals without timestamped evidence must not be reused');
assert.equal(isApprovedPackagingLearning(adoptedWinner), true);
assert.equal(isApprovedPackagingLearning({ ...adoptedWinner, status: 'pending' }), false);
assert.equal(isApprovedPackagingLearning({
  ...adoptedWinner,
  proposedChange: { ...adoptedWinner.proposedChange, target: 'current_video_only' }
}), false);
assert.equal(isApprovedPackagingLearning({
  ...adoptedWinner,
  proposedChange: { ...adoptedWinner.proposedChange, experiment: 'unrelated_change' }
}), false);
assert.equal(isApprovedPackagingLearning(null), false);

const context = getApprovedPackagingLearning([{
  ...adoptedWinner,
  status: 'pending'
}, adoptedWinner]);
assert.equal(context.recommendationId, 'learning-1');
assert.equal(context.winningTitle, 'A proven title pattern');
assert.equal(context.winningThumbnailPattern, 'Centered composition');
assert.equal(context.winningArmLabel, 'Curiosity / Centered composition');
assert.equal(context.evidence.liftPercent, 18.5);
const missingEvidence = getApprovedPackagingLearning([{
  ...adoptedWinner,
  evidence: { ...adoptedWinner.evidence, liftPercent: null, zScore: null }
}]);
assert.equal(missingEvidence.evidence.liftPercent, null);
assert.equal(missingEvidence.evidence.zScore, null);
assert.equal(isApprovedPackagingLearning({ ...adoptedWinner, evidence: {} }), false);
assert.equal(context.confidence, 'high');
assert.equal(getApprovedPackagingLearning([]), null);
assert.equal(getApprovedPackagingLearning(null), null);

const designer = new ThumbnailDesignerAgent({}, {});
const script = { title: 'A Complete Guide to Better Habits', metadata: { strategy: { contentType: 'explainer' } } };
(async () => {
  const baseline = await designer.generateConcept(script);
  const contrast = await designer.generateConcept(script, { winningThumbnailPattern: 'Color contrast' });
  const alternate = await designer.generateConcept(script, { winningThumbnailPattern: 'Alternate promise' });
  const centered = await designer.generateConcept(script, { winningThumbnailPattern: 'Centered composition' });
  assert.equal(contrast.colors.primary, baseline.colors.secondary);
  assert.equal(contrast.colors.secondary, baseline.colors.primary);
  assert.equal(alternate.primaryText, designer.generateAlternativeText(baseline.primaryText));
  assert.equal(centered.composition, 'centered');
  process.stdout.write('Packaging learning selection and thumbnail tests passed\\n');
})().catch(error => {
  process.stderr.write(`Packaging learning tests failed: ${error.stack || error.message}\\n`);
  process.exitCode = 1;
});

