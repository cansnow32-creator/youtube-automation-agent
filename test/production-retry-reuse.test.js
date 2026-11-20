const assert = require('node:assert/strict');
const { ProductionManagementAgent } = require('../agents/production-management-agent');
const { Database } = require('../database/db');

async function run() {
  const agent = Object.create(ProductionManagementAgent.prototype);
  const existing = {
    id: 'production_existing',
    script: { title: 'Previously approved script' },
    timeline: { jobId: 'job_existing' }
  };
  let resumedId = null;
  let generatedId = false;
  agent.logger = { info() {}, error() {}, warn() {} };
  agent.db = {
    getVideoConcept: async id => ({ id, status: 'approved', concept: { title: 'Approved concept' } }),
    getProductionBundleByJobId: async id => id === 'job_existing' ? existing : null
  };
  agent.generateProductionId = () => { generatedId = true; return 'duplicate'; };
  agent.resumeProduction = async id => { resumedId = id; return { id, status: 'ready', resumed: true }; };

  const result = await agent.processContent({
    jobId: 'job_existing',
    strategy: { approvedVideoConceptId: 'concept_1' },
    script: { title: 'Previously approved script' },
    thumbnail: {},
    seo: {}
  });
  assert.equal(result.id, 'production_existing');
  assert.equal(result.resumed, true);
  assert.equal(resumedId, 'production_existing');
  assert.equal(generatedId, false, 'retry must not create a duplicate production record');

  await assert.rejects(
    agent.processContent({
      jobId: 'job_existing',
      strategy: { approvedVideoConceptId: 'concept_1' },
      script: { title: 'Different script' },
      thumbnail: {},
      seo: {}
    }),
    /script\/job identity does not match/
  );
  const database = Object.create(Database.prototype);
  let queriedJobId = null;
  let fetchedProductionId = null;
  database.getRow = async (sql, params) => {
    assert.match(sql, /json_extract\(timeline, '\$\.jobId'\)/);
    queriedJobId = params[0];
    return { id: 'production_from_db' };
  };
  database.getProductionBundle = async id => {
    fetchedProductionId = id;
    return { id };
  };
  const bundle = await database.getProductionBundleByJobId('job_lookup');
  assert.equal(queriedJobId, 'job_lookup');
  assert.equal(fetchedProductionId, 'production_from_db');
  assert.equal(bundle.id, 'production_from_db');
  assert.equal(await database.getProductionBundleByJobId(null), null);

  process.stdout.write('Persisted production reuse tests passed\\n');
}

run().catch(error => {
  process.stderr.write(`Persisted production reuse tests failed: ${error.stack || error.message}\\n`);
  process.exitCode = 1;
});
