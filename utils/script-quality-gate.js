function assertScriptQualityGate(script, options = {}) {
  const enabled = options.enabled ?? process.env.QUALITY_PIPELINE_ENABLED === 'true';
  if (!enabled) return { enabled: false, status: 'not_required' };

  const report = script?.metadata?.qualityGate;
  const minimumScore = Number(report?.minimumScore || 80);
  const score = Number(report?.score);
  const reviewers = Array.isArray(report?.reviewers) ? report.reviewers : [];
  const valid = report?.status === 'approved' &&
    Number.isFinite(score) && score >= minimumScore &&
    reviewers.includes('ollama') &&
    Array.isArray(report.attempts) && report.attempts.length > 0;

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
    status: report.status,
    score,
    minimumScore,
    reviewers
  };
}

module.exports = { assertScriptQualityGate };
