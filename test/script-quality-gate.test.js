const assert = require('node:assert/strict');
const { assertScriptQualityGate } = require('../utils/script-quality-gate');

function run() {
  assert.deepEqual(assertScriptQualityGate({}), { enabled: false, status: 'not_required' }, 'quality gate stays opt-in');

  const approved = {
    metadata: {
      qualityGate: {
        status: 'approved',
        score: 88,
        minimumScore: 80,
        reviewers: ['ollama'],
        attempts: [{
          revision: 0,
          score: 88,
          approved: true,
          reviewers: {
            ollama: { score: 88, approved: true, blockers: [] }
          }
        }]
      }
    }
  };
  const result = assertScriptQualityGate(approved, { enabled: true });
  assert.equal(result.status, 'approved');
  assert.equal(result.score, 88);

  const blocked = report => assert.throws(
    () => assertScriptQualityGate({ metadata: { qualityGate: report } }, { enabled: true }),
    error => error.code === 'SCRIPT_QUALITY_GATE_BLOCKED' && error.status === 409
  );
  blocked(null);
  blocked({ status: 'human_review_required', score: 60, minimumScore: 80, reviewers: ['ollama'], attempts: [{}] });
  blocked({ status: 'approved', score: 99, minimumScore: 80, reviewers: ['gemini'], attempts: [{}] });
  blocked({ status: 'approved', score: 99, minimumScore: 80, reviewers: ['ollama'], attempts: [{}] });
  blocked({
    status: 'approved', score: 99, minimumScore: 80, reviewers: ['ollama'],
    attempts: [{ approved: true, score: 99, reviewers: { ollama: { score: 99, approved: false, blockers: [] } } }]
  });
  blocked({
    status: 'approved', score: 99, minimumScore: 80, reviewers: ['ollama'],
    attempts: [{ approved: true, score: 99, reviewers: { ollama: { score: 99, approved: true, blockers: ['unsupported claim'] } } }]
  });
  blocked({
    status: 'approved', score: 99, minimumScore: 80, reviewers: ['ollama'],
    attempts: [{ approved: true, score: 95, reviewers: { ollama: { score: 95, approved: true, blockers: [] } } }]
  });
  blocked({
    status: 'approved', score: 99, minimumScore: 101, reviewers: ['ollama'],
    attempts: [{ approved: true, score: 99, reviewers: { ollama: { score: 99, approved: true, blockers: [] } } }]
  });

  const humanApproved = {
    metadata: {
      qualityGate: { status: 'human_review_required', score: 61, minimumScore: 80, reviewers: ['ollama'], attempts: [{}] },
      humanApproval: { reviewId: 'quality_review_1', decidedAt: '2026-11-20 10:00:00' }
    }
  };
  const humanResult = assertScriptQualityGate(humanApproved, { enabled: true });
  assert.equal(humanResult.status, 'human_approved');
  assert.equal(humanResult.approvalSource, 'human');
  assert.throws(() => assertScriptQualityGate({
    metadata: { humanApproval: { reviewId: 'quality_review_1' } }
  }, { enabled: true }), /no valid approved Ollama review or persisted human approval/);
  assert.throws(() => assertScriptQualityGate({
    metadata: { humanApproval: { reviewId: 'quality_review_1', decidedAt: 'not-a-date' } }
  }, { enabled: true }), /no valid approved Ollama review or persisted human approval/);

  process.stdout.write('Script quality gate tests passed\\n');
}

try { run(); } catch (error) {
  process.stderr.write(`Script quality gate tests failed: ${error.stack || error.message}\\n`);
  process.exitCode = 1;
}
