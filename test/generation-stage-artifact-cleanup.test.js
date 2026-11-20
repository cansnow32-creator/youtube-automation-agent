const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ContentStrategyAgent } = require('../agents/content-strategy-agent');
const { ScriptWriterAgent } = require('../agents/script-writer-agent');
const { ThumbnailDesignerAgent } = require('../agents/thumbnail-designer-agent');
const { SEOOptimizerAgent } = require('../agents/seo-optimizer-agent');

function leaseLostError() {
  return Object.assign(new Error('generation job lease lost'), {
    code: 'GENERATION_JOB_LEASE_LOST',
    status: 409
  });
}

async function testStrategyIsNotSavedAfterProviderLeaseLoss() {
  const agent = Object.create(ContentStrategyAgent.prototype);
  agent.logger = { info() {}, warn() {}, error() {} };
  let saves = 0;
  let lost = false;
  agent.db = { saveContentStrategy: async () => { saves += 1; } };
  agent.generateContentStrategyWithAI = async () => {
    lost = true;
    return { topic: 'lease test', contentType: 'Explainer' };
  };

  await assert.rejects(
    agent.generateContentStrategy('lease test', async () => {
      if (lost) throw leaseLostError();
    }),
    error => error.code === 'GENERATION_JOB_LEASE_LOST'
  );
  assert.equal(saves, 0, 'strategy is not persisted after provider work outlives the job lease');
}

async function testScriptArtifactIsNotSavedAfterProviderLeaseLoss() {
  const agent = Object.create(ScriptWriterAgent.prototype);
  agent.logger = { info() {}, warn() {}, error() {} };
  agent.templates = { explainer: { tone: 'informative', pacing: 'steady' } };
  let saves = 0;
  let lost = false;
  agent.db = { saveScript: async () => { saves += 1; } };
  agent.generateScriptWithAI = async (_strategy, _template, assertLease) => {
    await assertLease();
    lost = true;
    return { title: 'Generated script', fullScript: 'script body' };
  };
  agent.formatFullScript = script => script.fullScript;

  await assert.rejects(
    agent.generateScript(
      { topic: 'lease test', contentType: 'Explainer', keywords: [] },
      async () => { if (lost) throw leaseLostError(); }
    ),
    error => error.code === 'GENERATION_JOB_LEASE_LOST'
  );
  assert.equal(saves, 0, 'script row is not saved after the provider returns to a worker that lost its lease');
}

async function testScriptAndRejectedReviewAreNotSavedAfterLeaseLoss() {
  const agent = Object.create(ScriptWriterAgent.prototype);
  agent.logger = { info() {}, warn() {}, error() {} };
  agent.qualityPipeline = {
    enabled: true,
    lastReport: { status: 'human_review_required', score: 50 },
    generateAndReview: async () => {
      lost = true;
      throw Object.assign(new Error('quality review required'), {
        code: 'QUALITY_REVIEW_REQUIRED',
        draft: '{"title":"Rejected"}',
        qualityReport: { status: 'human_review_required', score: 50 }
      });
    }
  };
  let lost = false;
  let scriptSaves = 0;
  let reviewSaves = 0;
  agent.db = {
    saveScript: async () => { scriptSaves += 1; },
    saveScriptQualityReview: async () => { reviewSaves += 1; return { id: 'review-1' }; }
  };

  await assert.rejects(
    agent.generateScriptWithAI(
      { topic: 'lease test', contentType: 'Explainer', keywords: [] },
      { tone: 'informative', pacing: 'steady' },
      async () => { if (lost) throw leaseLostError(); }
    ),
    error => error.code === 'GENERATION_JOB_LEASE_LOST'
  );
  assert.equal(scriptSaves, 0);
  assert.equal(reviewSaves, 0, 'the quality-review catch path must not swallow a lease-loss error');
}

async function testSeoIsNotPersistedAfterProviderLeaseLoss() {
  const agent = Object.create(SEOOptimizerAgent.prototype);
  agent.logger = { info() {}, warn() {}, error() {} };
  let saves = 0;
  let lost = false;
  agent.db = { saveSEOData: async () => { saves += 1; } };
  agent.generateSEOWithAI = async () => {
    lost = true;
    return { title: 'SEO title', description: 'Description', tags: ['test'] };
  };

  await assert.rejects(
    agent.optimize(
      { title: 'Lease test' },
      { keywords: ['test'], contentType: 'Explainer' },
      async () => { if (lost) throw leaseLostError(); }
    ),
    error => error.code === 'GENERATION_JOB_LEASE_LOST'
  );
  assert.equal(saves, 0, 'SEO data is not persisted after provider work outlives the generation lease');
}

async function testThumbnailFilesAreRemovedWhenLeaseIsLost() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agenttube-thumbnail-lease-'));
  const agent = Object.create(ThumbnailDesignerAgent.prototype);
  agent.logger = { info() {}, warn() {}, error() {} };
  let saves = 0;
  agent.db = { saveThumbnail: async () => { saves += 1; } };
  agent.generateConcept = async () => ({ colors: { primary: 'blue' } });
  agent.createPrompt = async () => 'test prompt';
  agent.createThumbnail = async (_concept, suffix) => {
    const file = path.join(directory, 'base-' + suffix + '.png');
    await fs.writeFile(file, 'base thumbnail');
    return file;
  };
  agent.addTextOverlay = async (file, _concept, suffix) => {
    const output = path.join(directory, 'overlay-' + suffix + '.png');
    await fs.copyFile(file, output);
    return output;
  };
  agent.optimizeForYouTube = async (file, suffix) => {
    const output = path.join(directory, 'optimized-' + suffix + '.jpg');
    await fs.copyFile(file, output);
    return output;
  };
  agent.getFileSize = async file => (await fs.stat(file)).size;

  let checks = 0;
  try {
    await assert.rejects(
      agent.generateThumbnail({ title: 'lease test' }, null, async () => {
        checks += 1;
        if (checks >= 4) throw leaseLostError();
      }),
      error => error.code === 'GENERATION_JOB_LEASE_LOST'
    );
    assert.equal(saves, 0, 'thumbnail DB row is not written after lease loss');
    assert.deepEqual(await fs.readdir(directory), [], 'all generated thumbnail files are removed');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function testAbVariantFilesAreRemovedWhenLeaseIsLost() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agenttube-ab-thumbnail-lease-'));
  const agent = Object.create(ThumbnailDesignerAgent.prototype);
  agent.createThumbnail = async (_concept, suffix) => {
    const file = path.join(directory, 'base-' + suffix + '.png');
    await fs.writeFile(file, 'base');
    return file;
  };
  agent.addTextOverlay = async (file, _concept, suffix) => {
    const output = path.join(directory, 'overlay-' + suffix + '.png');
    await fs.copyFile(file, output);
    return output;
  };
  agent.optimizeForYouTube = async (file, suffix) => {
    const output = path.join(directory, 'optimized-' + suffix + '.jpg');
    await fs.copyFile(file, output);
    return output;
  };
  agent.generateAlternativeText = value => value + '!';

  let checks = 0;
  try {
    await assert.rejects(
      agent.generateABVariants({
        colors: { primary: 'blue', secondary: 'yellow', accent: 'white' },
        primaryText: 'GUIDE'
      }, async () => {
        checks += 1;
        if (checks >= 2) throw leaseLostError();
      }),
      error => error.code === 'GENERATION_JOB_LEASE_LOST'
    );
    assert.deepEqual(await fs.readdir(directory), [], 'partial A/B variant files are removed');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function run() {
  await testStrategyIsNotSavedAfterProviderLeaseLoss();
  await testScriptArtifactIsNotSavedAfterProviderLeaseLoss();
  await testScriptAndRejectedReviewAreNotSavedAfterLeaseLoss();
  await testSeoIsNotPersistedAfterProviderLeaseLoss();
  await testThumbnailFilesAreRemovedWhenLeaseIsLost();
  await testAbVariantFilesAreRemovedWhenLeaseIsLost();
  console.log('Generation stage artifact cleanup tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
