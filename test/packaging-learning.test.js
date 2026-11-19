const assert = require('node:assert/strict');
const { isApprovedPackagingLearning } = require('../utils/packaging-learning');

const legacy = {
  status: 'approved',
  proposedChange: { experiment: 'title_thumbnail_variant' }
};
const adoptedWinner = {
  status: 'approved',
  category: 'packaging_experiment',
  proposedChange: {
    target: 'future_packaging',
    experiment: 'validated_title_thumbnail_pattern',
    winningTitle: 'A proven title pattern'
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

process.stdout.write('Packaging learning selection tests passed\\n');
