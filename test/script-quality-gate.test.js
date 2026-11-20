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
        attempts: [{ revision: 0, score: 88 }]
      }
    }
  };
  const result = assertScriptQualityGate(approved, { enabled: true });
  assert.equal(result.status, 'approved');
  assert.equal(result.score, 88);
  assert.throws(() => assertScriptQualityGate({}, { enabled: true }), error => error.code === 'SCRIPT_QUALITY_GATE_BLOCKED' && error.status === 409);
  assert.throws(() => assertScriptQualityGate({
    metadata: { qualityGate: { status: 'human_review_required', score: 60, minimumScore: 80, reviewers: ['ollama'], attempts: [{}] } }
  }, { enabled: true }), /no valid approved Ollama review/);
  assert.throws(() => assertScriptQualityGate({
    metadata: { qualityGate: { status: 'approved', score: 99, minimumScore: 80, reviewers: ['gemini'], attempts: [{}] } }
  }, { enabled: true }), /no valid approved Ollama review/);
  process.stdout.write('Script quality gate tests passed\\n');
}

try { run(); } catch (error) {
  process.stderr.write(`Script quality gate tests failed: ${error.stack || error.message}\\n`);
  process.exitCode = 1;
}
