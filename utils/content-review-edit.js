function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function buildContentReviewAfterEdit(bundle, editorData, reviewNotes) {
  const previousEditorData = bundle.editorData || {};
  const changed = stableSerialize(editorData || {}) !== stableSerialize(previousEditorData);
  const approvalRevoked = bundle.review_status === 'approved' && changed;
  return {
    status: approvalRevoked ? 'needs_review' : (bundle.review_status || 'needs_review'),
    editorData,
    qualityChecks: approvalRevoked ? [] : (bundle.qualityChecks || []),
    reviewNotes: reviewNotes ?? (approvalRevoked
      ? 'Content was edited after approval; a fresh review is required.'
      : bundle.review_notes),
    reviewedAt: approvalRevoked ? null : bundle.reviewed_at
  };
}

module.exports = { buildContentReviewAfterEdit };
