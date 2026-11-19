function isApprovedPackagingLearning(item) {
  if (!item || item.status !== 'approved') return false;
  const experiment = item.proposedChange?.experiment;
  if (experiment === 'title_thumbnail_variant') return true;
  return item.category === 'packaging_experiment' &&
    item.proposedChange?.target === 'future_packaging' &&
    experiment === 'validated_title_thumbnail_pattern';
}

module.exports = { isApprovedPackagingLearning };
