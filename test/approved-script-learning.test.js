const assert = require('node:assert/strict');
const { hasFreshEvidence, isApprovedPackagingLearning, getApprovedPackagingLearning, getApprovedScriptLearnings } = require('../utils/packaging-learning');

const now = new Date('2026-11-20T12:00:00.000Z');
const freshEvidence = { freshness: { status: 'fresh', oldestMeasuredAt: '2026-10-01T00:00:00.000Z', latestMeasuredAt: '2026-11-19T00:00:00.000Z', sampleCount: 4, maxAgeDays: 90 } };

const approved = [
  {
    id: 'hook-1', status: 'approved', category: 'hookLength', title: 'Use concise hooks',
    rationale: 'Shorter hooks retained more viewers.', confidence: 'high',
    evidence: { metric: 'retention', best: { count: 5 }, ...freshEvidence },
    proposedChange: { target: 'future_plans', dimension: 'hookLength', prefer: 'concise', deprioritize: 'long' }
  },
  {
    id: 'format-1', status: 'approved', category: 'format', title: 'Prefer tutorials',
    rationale: 'Tutorials performed better.', confidence: 'medium', evidence: freshEvidence,
    proposedChange: { target: 'future_scripts', dimension: 'format', prefer: 'tutorial' }
  },
  {
    id: 'pending-1', status: 'pending', category: 'hookLength',
    proposedChange: { target: 'future_scripts', prefer: 'long' }
  },
  {
    id: 'wrong-target', status: 'approved', category: 'hookLength',
    proposedChange: { target: 'current_video_only', prefer: 'long' }
  },
  {
    id: 'packaging-only', status: 'approved', category: 'packaging_experiment',
    proposedChange: { target: 'future_packaging', experiment: 'validated_title_thumbnail_pattern' }
  },
  {
    id: 'unrelated', status: 'approved', category: 'audience_demand',
    proposedChange: { target: 'future_plans', prefer: 'topic' }
  }
];

const selected = getApprovedScriptLearnings(approved, { now });
assert.deepEqual(selected.map(item => item.recommendationId), ['hook-1', 'format-1']);
assert.equal(selected[0].proposedChange.prefer, 'concise');
assert.equal(selected[0].evidence.sampleSize, 5);
assert.deepEqual(getApprovedScriptLearnings(approved, { now: new Date('2027-03-01T00:00:00.000Z') }).map(item => item.recommendationId), [], 'evidence older than 90 days must no longer steer future scripts');
assert.equal(hasFreshEvidence({ evidence: freshEvidence }, { now }), true);
assert.equal(hasFreshEvidence({ evidence: { freshness: { ...freshEvidence.freshness, oldestMeasuredAt: null } } }, { now }), false);
assert.equal(hasFreshEvidence({ evidence: { freshness: { ...freshEvidence.freshness, sampleCount: 1 } } }, { now }), false);
assert.equal(hasFreshEvidence({ evidence: { freshness: { ...freshEvidence.freshness, oldestMeasuredAt: '2026-01-01T00:00:00.000Z' } } }, { now }), false);
assert.deepEqual(getApprovedScriptLearnings([]), []);
assert.deepEqual(getApprovedScriptLearnings(null), []);
const packaging = {
  id: 'pack-1', status: 'approved', category: 'packaging_experiment',
  title: 'Use validated packaging', rationale: 'Observed pattern',
  evidence: { ...freshEvidence, liftPercent: 8 },
  proposedChange: { target: 'future_packaging', experiment: 'validated_title_thumbnail_pattern' }
};
assert.equal(isApprovedPackagingLearning(packaging, { now }), true);
assert.equal(getApprovedPackagingLearning([packaging], { now }).recommendationId, 'pack-1');
assert.equal(isApprovedPackagingLearning({ ...packaging, evidence: {} }, { now }), false,
  'legacy approved recommendations without measured evidence timestamps must fail closed');
assert.equal(getApprovedPackagingLearning([packaging], { now: new Date('2027-03-01T00:00:00.000Z') }), null,
  'stale packaging evidence must not generate variants');
process.stdout.write('Approved script learning tests passed\\n');
