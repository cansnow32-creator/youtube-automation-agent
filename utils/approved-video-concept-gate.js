function conceptGateError(message) {
  const error = new Error(message);
  error.status = 409;
  error.code = 'APPROVED_CONCEPT_REQUIRED';
  return error;
}

async function requireApprovedVideoConcept(db, conceptId) {
  if (!conceptId || typeof conceptId !== 'string') {
    throw conceptGateError('Approve a video concept in Video Concept Studio before starting production.');
  }
  const record = await db.getVideoConcept(conceptId);
  if (!record || record.status !== 'approved') {
    throw conceptGateError('The selected video concept is missing or not approved. Approve the latest concept before production.');
  }
  return {
    id: record.id,
    concept: record.concept
  };
}

module.exports = { requireApprovedVideoConcept, conceptGateError };
