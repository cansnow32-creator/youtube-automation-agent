const assert = require('node:assert/strict');
const {
  isApprovedPackagingLearning,
  getApprovedPackagingLearning
} = require('../utils/packaging-learning');

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
  evidence: { liftPercent: 18.5, zScore: 2.1 },
  proposedChange: {
    target: 'future_packaging',
    experiment: 'validated_title_thumbnail_pattern',
    winningTitle: 'A proven title pattern',
    hypothesis: 'Curiosity framing improves clicks'
  }
};

assert.equal(isApprovedPackagingLearning(legacy), true);
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
assert.equal(context.evidence.liftPercent, 18.5);
assert.equal(context.confidence, 'high');
assert.equal(getApprovedPackagingLearning([]), null);
assert.equal(getApprovedPackagingLearning(null), null);

process.stdout.write('Packaging learning selection tests passed\\n');
