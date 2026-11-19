const assert = require('node:assert/strict');
const { requireApprovedVideoConcept } = require('../utils/approved-video-concept-gate');

async function run() {
  const records = new Map([
    ['pending-id', { id: 'pending-id', status: 'pending', concept: { name: 'Pending' } }],
    ['approved-id', { id: 'approved-id', status: 'approved', concept: { name: 'Approved' } }]
  ]);
  const db = { async getVideoConcept(id) { return records.get(id) || null; } };

  await assert.rejects(
    () => requireApprovedVideoConcept(db, null),
    error => error.status === 409 && error.code === 'APPROVED_CONCEPT_REQUIRED'
  );
  await assert.rejects(
    () => requireApprovedVideoConcept(db, 'missing-id'),
    error => error.status === 409 && error.code === 'APPROVED_CONCEPT_REQUIRED'
  );
  await assert.rejects(
    () => requireApprovedVideoConcept(db, 'pending-id'),
    error => error.status === 409 && error.code === 'APPROVED_CONCEPT_REQUIRED'
  );

  const approved = await requireApprovedVideoConcept(db, 'approved-id');
  assert.equal(approved.id, 'approved-id');
  assert.deepEqual(approved.concept, { name: 'Approved' });
  process.stdout.write('Approved video concept gate tests passed\\n');
}

run().catch(error => {
  process.stderr.write('Approved video concept gate tests failed: ' + (error.stack || error.message) + '\\n');
  process.exitCode = 1;
});
