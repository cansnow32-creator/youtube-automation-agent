function isValidAutomatedApproval(report) {
  if (!report || report.status !== 'approved') return false;
  const score = Number(report.score);
  const minimumScore = Number(report.minimumScore ?? 80);
  const reviewers = Array.isArray(report.reviewers) ? [...new Set(report.reviewers)] : [];
  const attempts = Array.isArray(report.attempts) ? report.attempts : [];
  if (!Number.isFinite(score) || score < 0 || score > 100 ||
      !Number.isFinite(minimumScore) || minimumScore < 0 || minimumScore > 100 ||
      score < minimumScore || !reviewers.includes('ollama') || !attempts.length) {
    return false;
  }

  // Validate the final successful attempt, not just the summary fields. This
  // prevents an incomplete or inconsistent persisted report from opening the
  // production gate.
  const finalAttempt = attempts[attempts.length - 1];
  if (!finalAttempt || finalAttempt.approved !== true ||
      !Number.isFinite(Number(finalAttempt.score)) ||
      Number(finalAttempt.score) !== score ||
      Number(finalAttempt.score) < minimumScore ||
      !finalAttempt.reviewers || typeof finalAttempt.reviewers !== 'object') {
    return false;
  }

  return reviewers.every(name => {
    const result = finalAttempt.reviewers[name];
    return Boolean(
      result &&
      result.approved === true &&
      Number.isFinite(Number(result.score)) &&
      Number(result.score) >= minimumScore &&
      Array.isArray(result.blockers) &&
      result.blockers.length === 0
    );
  });
}

function isValidHumanApproval(approval) {
  if (typeof approval?.reviewId !== 'string' || !approval.reviewId.trim()) return false;
  if (typeof approval.decidedAt !== 'string' || !approval.decidedAt.trim()) return false;
  return Number.isFinite(Date.parse(approval.decidedAt));
}

function assertScriptQualityGate(script, options = {}) {
  const enabled = options.enabled ?? process.env.QUALITY_PIPELINE_ENABLED === 'true';
  if (!enabled) return { enabled: false, status: 'not_required' };

  const report = script?.metadata?.qualityGate;
  const automatedApproval = isValidAutomatedApproval(report);
  const humanApproval = isValidHumanApproval(script?.metadata?.humanApproval);
  const score = Number(report?.score);
  const minimumScore = Number(report?.minimumScore ?? 80);
  const reviewers = Array.isArray(report?.reviewers) ? report.reviewers : [];
  const valid = automatedApproval || humanApproval;

  if (!valid) {
    const error = new Error(
      'Production is blocked: the enabled local-first script quality gate has no valid approved Ollama review or persisted human approval. Regenerate and review the script before production.'
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
    minimumScore: Number.isFinite(minimumScore) ? minimumScore : 80,
    reviewers,
    approvalSource: automatedApproval ? 'ollama' : 'human'
  };
}

module.exports = { assertScriptQualityGate, isValidAutomatedApproval, isValidHumanApproval };
