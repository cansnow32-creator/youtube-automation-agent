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
      liftPercent: recommendation.evidence?.liftPercent != null && Number.isFinite(Number(recommendation.evidence.liftPercent))
        ? Number(recommendation.evidence.liftPercent) : null,
      zScore: recommendation.evidence?.zScore != null && Number.isFinite(Number(recommendation.evidence.zScore))
        ? Number(recommendation.evidence.zScore) : null
    }
  };
}

function getAppliedPackagingLearning(experiment, selectedTitleVariant, selectedThumbnailVariant, manualTitleOverride = false) {
  const recommendationId = experiment?.sourceRecommendationId;
  if (!recommendationId) return null;
  const appliedTo = [];
  const titleIndex = Number(selectedTitleVariant);
  const thumbnailIndex = Number(selectedThumbnailVariant);
  if (!manualTitleOverride && Number.isInteger(titleIndex) && titleIndex > 0 && experiment.titleVariants?.[titleIndex]) {
    appliedTo.push('title');
  }
  if (Number.isInteger(thumbnailIndex) && thumbnailIndex > 0 && experiment.thumbnailVariants?.[thumbnailIndex]) {
    appliedTo.push('thumbnail');
  }
  if (!appliedTo.length) return null;
  return {
    recommendationId: String(recommendationId),
    category: 'packaging_experiment',
    appliedTo,
    titleVariant: appliedTo.includes('title') ? String(experiment.titleVariants[titleIndex].label || '').slice(0, 100) : null,
    thumbnailVariant: appliedTo.includes('thumbnail') ? String(experiment.thumbnailVariants[thumbnailIndex].label || '').slice(0, 100) : null,
    appliedAt: new Date().toISOString(),
    source: 'human_approved_pre_publish_selection'
  };
}

function getApprovedScriptLearnings(recommendations = []) {
  const allowedCategories = new Set(['format', 'length', 'hookLength', 'retention']);
  return (Array.isArray(recommendations) ? recommendations : [])
    .filter(item => item?.status === 'approved' &&
      allowedCategories.has(String(item.category || '')) &&
      ['future_plans', 'future_scripts'].includes(item.proposedChange?.target))
    .slice(0, 8)
    .map(item => ({
      recommendationId: item.id || null,
      category: String(item.category).slice(0, 40),
      title: String(item.title || '').slice(0, 160),
      rationale: String(item.rationale || '').slice(0, 400),
      confidence: ['high', 'medium', 'low'].includes(item.confidence) ? item.confidence : 'unknown',
      evidence: item.evidence && typeof item.evidence === 'object' ? {
        metric: String(item.evidence.metric || '').slice(0, 40),
        sampleSize: Number.isFinite(Number(item.evidence.best?.count))
          ? Number(item.evidence.best.count)
          : Number.isFinite(Number(item.evidence.sampleSize)) ? Number(item.evidence.sampleSize) : null
      } : null,
      proposedChange: {
        dimension: String(item.proposedChange.dimension || item.category).slice(0, 40),
        prefer: String(item.proposedChange.prefer || '').slice(0, 100),
        deprioritize: String(item.proposedChange.deprioritize || '').slice(0, 100)
      }
    }))
    .filter(item => item.proposedChange.prefer || item.rationale);
}

module.exports = { isApprovedPackagingLearning, getApprovedPackagingLearning, getApprovedScriptLearnings, getAppliedPackagingLearning };
