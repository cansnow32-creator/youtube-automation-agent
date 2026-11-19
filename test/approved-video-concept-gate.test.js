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

  // The legacy production agent path must enforce the same gate before doing
  // any asset generation or persistence.
  const { ProductionManagementAgent } = require('../agents/production-management-agent');
  let generatedAssets = false;
  const productionRecords = new Map([
    ['pending-id', { id: 'pending-id', status: 'pending', concept: { name: 'Pending' } }],
    ['approved-id', { id: 'approved-id', status: 'approved', concept: { name: 'Approved concept' } }]
  ]);
  const productionAgent = Object.create(ProductionManagementAgent.prototype);
  productionAgent.db = {
    async getVideoConcept(id) { return productionRecords.get(id) || null; },
    async saveProductionData() { throw new Error('Production must not be persisted in this test'); },
    async updateProductionData() {}
  };
  productionAgent.logger = { info() {}, warn() {}, error() {} };
  productionAgent.pipeline = [];
  productionAgent.processScript = async () => { generatedAssets = true; return {}; };
  productionAgent.processThumbnail = async () => { generatedAssets = true; return {}; };

  await assert.rejects(
    () => productionAgent.processContent({ strategy: {}, script: {}, thumbnail: {}, seo: {} }),
    error => error.status === 409 && error.code === 'APPROVED_CONCEPT_REQUIRED'
  );
  await assert.rejects(
    () => productionAgent.processContent({
      strategy: { approvedVideoConceptId: 'pending-id' },
      script: {}, thumbnail: {}, seo: {}
    }),
    error => error.status === 409 && error.code === 'APPROVED_CONCEPT_REQUIRED'
  );
  assert.equal(generatedAssets, false, 'Unapproved production must be blocked before asset generation');

  let persistedStrategy = null;
  productionAgent.db.saveProductionData = async record => { persistedStrategy = record.strategy; };
  productionAgent.processScript = async () => ({});
  productionAgent.processThumbnail = async () => ({});
  productionAgent.generateVideoContent = async () => {};
  productionAgent.generateAudioNarration = async () => {};
  productionAgent.generateCaptions = async () => {};
  productionAgent.assembleVideo = async record => { record.assets.finalVideo = { simulated: true }; };
  productionAgent.sceneRepair = { async initializeProduction() {} };
  productionAgent.aiVideoGenerator = { lastVideoResult: {} };
  productionAgent.db.updateProductionData = async () => {};
  await productionAgent.processContent({
    strategy: { approvedVideoConceptId: 'approved-id' },
    script: { duration: 30 }, thumbnail: {}, seo: {}
  });
  assert.equal(persistedStrategy.approvedVideoConceptId, 'approved-id');
  assert.deepEqual(persistedStrategy.approvedVideoConcept, { name: 'Approved concept' });

  process.stdout.write('Approved video concept gate tests passed\n');
}

run().catch(error => {
  process.stderr.write('Approved video concept gate tests failed: ' + (error.stack || error.message) + '\n');
  process.exitCode = 1;
});
