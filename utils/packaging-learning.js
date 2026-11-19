function isApprovedPackagingLearning(item) {
  if (!item || item.status !== 'approved') return false;
  const experiment = item.proposedChange?.experiment;
  if (experiment === 'title_thumbnail_variant') return true;
  return item.category === 'packaging_experiment' &&
    item.proposedChange?.target === 'future_packaging' &&
    experiment === 'validated_title_thumbnail_pattern';
}

function getApprovedPackagingLearning(recommendations = []) {
  const recommendation = (Array.isArray(recommendations) ? recommendations : [])
    .find(isApprovedPackagingLearning);
  if (!recommendation) return null;
  return {
    recommendationId: recommendation.id || null,
    title: String(recommendation.title || '').slice(0, 200),
    rationale: String(recommendation.rationale || '').slice(0, 500),
    confidence: recommendation.confidence || 'unknown',
    winningTitle: String(recommendation.proposedChange?.winningTitle || '').slice(0, 100),
    winningThumbnailPattern: String(recommendation.proposedChange?.winningThumbnailPattern || '').slice(0, 80),
    winningArmLabel: String(recommendation.proposedChange?.winningArmLabel || '').slice(0, 100),
    hypothesis: String(recommendation.proposedChange?.hypothesis || '').slice(0, 300),
    evidence: {
      liftPercent: Number.isFinite(Number(recommendation.evidence?.liftPercent))
        ? Number(recommendation.evidence.liftPercent) : null,
      zScore: Number.isFinite(Number(recommendation.evidence?.zScore))
        ? Number(recommendation.evidence.zScore) : null
    }
  };
}

module.exports = { isApprovedPackagingLearning, getApprovedPackagingLearning };
