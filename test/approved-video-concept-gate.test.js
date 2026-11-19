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

  // The scheduled queue passes approvedVideoConceptId at the top level.
  // startGenerationJob must recognize it and persist the verified concept
  // inside strategyContext for the later pipeline and recovery paths.
  const { YouTubeAutomationAgent } = require('../index');
  const agent = Object.create(YouTubeAutomationAgent.prototype);
  let createdJob = null;
  agent.setupRequired = false;
  agent.agents = { strategy: {} };
  agent.activeJobs = new Map();
  agent.readiness = { async assertReady() {} };
  agent.db = {
    async getVideoConcept(id) { return productionRecords.get(id) || null; },
    async createGenerationJob(input) {
      createdJob = { id: 'scheduled-job', ...input };
      return createdJob;
    }
  };
  agent.runGenerationJob = async () => {};
  const queuedJob = await agent.startGenerationJob({
    topic: 'Scheduled concept test',
    source: 'scheduler',
    approvedVideoConceptId: 'approved-id'
  });
  assert.equal(queuedJob.id, 'scheduled-job');
  assert.equal(createdJob.strategyContext.approvedVideoConceptId, 'approved-id');
  assert.deepEqual(createdJob.strategyContext.approvedVideoConcept, { name: 'Approved concept' });

  // Recovery must re-check the persisted concept before restarting a failed
  // job. A concept that is no longer approved must not resume generation.
  const recoveryAgent = Object.create(YouTubeAutomationAgent.prototype);
  let recoveryStarted = false;
  let recoveryPersisted = false;
  recoveryAgent.setupRequired = false;
  recoveryAgent.agents = { strategy: {} };
  recoveryAgent.activeJobs = new Map();
  recoveryAgent.db = {
    async getGenerationJob() {
      return {
        id: 'failed-job',
        status: 'failed',
        source: 'manual',
        details: { strategyContext: { approvedVideoConceptId: 'pending-id' } }
      };
    },
    async getVideoConcept(id) { return productionRecords.get(id) || null; },
    async updateGenerationJob() { recoveryPersisted = true; }
  };
  recoveryAgent.runGenerationJob = async () => { recoveryStarted = true; };
  await assert.rejects(
    () => recoveryAgent.resumeGenerationJob('failed-job'),
    error => error.status === 409 && error.code === 'APPROVED_CONCEPT_REQUIRED'
  );
  assert.equal(recoveryStarted, false, 'Recovery must not start when concept approval is absent');
  assert.equal(recoveryPersisted, false, 'Blocked recovery must not change the saved job state');

  process.stdout.write('Approved video concept gate tests passed\n');
}

run().catch(error => {
  process.stderr.write('Approved video concept gate tests failed: ' + (error.stack || error.message) + '\n');
  process.exitCode = 1;
});
