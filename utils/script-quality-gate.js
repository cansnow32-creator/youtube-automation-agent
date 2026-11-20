function assertScriptQualityGate(script, options = {}) {
  const enabled = options.enabled ?? process.env.QUALITY_PIPELINE_ENABLED === 'true';
  if (!enabled) return { enabled: false, status: 'not_required' };

  const report = script?.metadata?.qualityGate;
  const minimumScore = Number(report?.minimumScore || 80);
  const score = Number(report?.score);
  const reviewers = Array.isArray(report?.reviewers) ? report.reviewers : [];
  const automatedApproval = report?.status === 'approved' &&
    Number.isFinite(score) && score >= minimumScore &&
    reviewers.includes('ollama') &&
    Array.isArray(report.attempts) && report.attempts.length > 0;
  const humanApproval = Boolean(
    script?.metadata?.humanApproval?.reviewId &&
    script?.metadata?.humanApproval?.decidedAt
  );
  const valid = automatedApproval || humanApproval;

  if (!valid) {
    const error = new Error(
      'Production is blocked: the enabled local-first script quality gate has no valid approved Ollama review. Regenerate and review the script before production.'
    );
    error.code = 'SCRIPT_QUALITY_GATE_BLOCKED';
    error.status = 409;
    error.qualityReport = report || null;
    throw error;
  }

  return {
    enabled: true,
    status: automatedApproval ? report.status : 'human_approved',
    score: Number.isFinite(score) ? score : null,
    minimumScore,
    reviewers,
    approvalSource: automatedApproval ? 'ollama' : 'human'
  };
}

module.exports = { assertScriptQualityGate };
