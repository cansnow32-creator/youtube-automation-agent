const assert = require('node:assert/strict');
const { buildContentReviewAfterEdit } = require('../utils/content-review-edit');

const approved = {
  review_status: 'approved',
  editorData: { title: 'Approved title', factChecked: true },
  qualityChecks: [{ id: 'quality-1', passed: true }],
  review_notes: 'Approved by operator',
  reviewed_at: '2026-11-20T12:00:00.000Z'
};

const edited = buildContentReviewAfterEdit(
  approved,
  { title: 'Changed title', factChecked: true },
  undefined
);
assert.equal(edited.status, 'needs_review');
assert.equal(edited.reviewedAt, null);
assert.deepEqual(edited.qualityChecks, []);
assert.match(edited.reviewNotes, /fresh review is required/i);

const unchanged = buildContentReviewAfterEdit(
  approved,
  { title: 'Approved title', factChecked: true },
  undefined
);
assert.equal(unchanged.status, 'approved');
assert.equal(unchanged.reviewedAt, approved.reviewed_at);
assert.deepEqual(unchanged.qualityChecks, approved.qualityChecks);

const reordered = buildContentReviewAfterEdit(
  approved,
  { factChecked: true, title: 'Approved title' },
  undefined
);
assert.equal(reordered.status, 'approved', 'object key order alone is not a content edit');

const pending = buildContentReviewAfterEdit(
  { ...approved, review_status: 'needs_review' },
  { title: 'Changed title', factChecked: true },
  'Operator note'
);
assert.equal(pending.status, 'needs_review');
assert.equal(pending.reviewNotes, 'Operator note');

process.stdout.write('Content review edit invalidation tests passed\\n');
