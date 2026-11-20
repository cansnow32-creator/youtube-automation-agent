const assert = require('node:assert/strict');
const { getApprovedScriptLearnings } = require('../utils/packaging-learning');

const approved = [
  {
    id: 'hook-1', status: 'approved', category: 'hookLength', title: 'Use concise hooks',
    rationale: 'Shorter hooks retained more viewers.', confidence: 'high',
    evidence: { metric: 'retention', best: { count: 5 } },
    proposedChange: { target: 'future_plans', dimension: 'hookLength', prefer: 'concise', deprioritize: 'long' }
  },
  {
    id: 'format-1', status: 'approved', category: 'format', title: 'Prefer tutorials',
    rationale: 'Tutorials performed better.', confidence: 'medium',
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

const selected = getApprovedScriptLearnings(approved);
assert.deepEqual(selected.map(item => item.recommendationId), ['hook-1', 'format-1']);
assert.equal(selected[0].proposedChange.prefer, 'concise');
assert.equal(selected[0].evidence.sampleSize, 5);
assert.deepEqual(getApprovedScriptLearnings([]), []);
assert.deepEqual(getApprovedScriptLearnings(null), []);
process.stdout.write('Approved script learning tests passed\\n');
