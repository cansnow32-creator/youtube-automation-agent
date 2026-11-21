const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ThumbnailDesignerAgent } = require('../agents/thumbnail-designer-agent');
const { ProductionManagementAgent } = require('../agents/production-management-agent');
const { YouTubeAutomationAgent } = require('../index');

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'thumbnail-reference-'));
  try {
    const basePath = path.join(directory, 'base.png');
    const overlayPath = path.join(directory, 'overlay.png');
    const optimizedPath = path.join(directory, 'optimized.jpg');
    let savedRecord = null;
    const designer = Object.create(ThumbnailDesignerAgent.prototype);
    designer.logger = { info() {}, warn() {}, error() {} };
    designer.db = {
      saveThumbnail: async thumbnail => {
        savedRecord = { ...thumbnail };
        return 'thumbnail-record-1';
      }
    };
    designer.generateConcept = async () => ({ title: 'Reference', primaryText: 'TEST' });
    designer.createPrompt = async () => 'thumbnail prompt';
    designer.createThumbnail = async () => {
      await fs.writeFile(basePath, 'base');
      return basePath;
    };
    designer.addTextOverlay = async () => {
      await fs.writeFile(overlayPath, 'overlay');
      return overlayPath;
    };
    designer.optimizeForYouTube = async () => {
      await fs.writeFile(optimizedPath, 'optimized');
      return optimizedPath;
    };
    designer.getFileSize = async () => 123;

    const thumbnail = await designer.generateThumbnail({ title: 'Test video' });
    assert.equal(thumbnail.id, 'thumbnail-record-1',
      'the returned thumbnail artifact must retain its durable database identity');
    assert.equal(savedRecord.path, thumbnail.path,
      'the database row and returned artifact must refer to the exact same optimized file');
    assert.equal(await fs.readFile(thumbnail.path, 'utf8'), 'optimized');

    const production = Object.create(ProductionManagementAgent.prototype);
    production.aiVideoGenerator = {
      generateThumbnail: async () => ({
        path: '/data/assets/ai-thumbnail.jpg',
        dimensions: { width: 1280, height: 720 },
        fileSize: 456,
        simulated: false
      })
    };
    const productionThumbnail = await production.processThumbnail(thumbnail, { title: 'Test video' });
    assert.equal(productionThumbnail.thumbnailRecordId, thumbnail.id,
      'production assets must preserve the originating thumbnail record reference');
    assert.equal(productionThumbnail.originalPath, thumbnail.path);

    const orchestrator = Object.create(YouTubeAutomationAgent.prototype);
    orchestrator.db = {
      listLearningRecommendations: async () => [{
        id: 'recommendation-1',
        status: 'approved',
        title: 'Test packaging hypothesis',
        evidence: {
          freshness: {
            sampleCount: 3,
            oldestMeasuredAt: new Date(Date.now() - 86400000).toISOString(),
            latestMeasuredAt: new Date(Date.now() - 3600000).toISOString()
          }
        },
        proposedChange: { experiment: 'title_thumbnail_variant' }
      }]
    };
    orchestrator.agents = {
      thumbnailDesigner: {
        generateABVariants: async () => [{
          label: 'Variant A',
          path: '/uploads/thumbnails/variant-a.jpg',
          concept: { primaryText: 'VARIANT' }
        }]
      }
    };
    const experiment = await orchestrator.preparePackagingExperiment(
      { concept: thumbnail.concept },
      { assets: { thumbnail: { path: productionThumbnail.path, thumbnailRecordId: thumbnail.id } } },
      { title: 'Test title' },
      { title: 'Test video' }
    );
    assert.equal(experiment.thumbnailVariants[0].path, productionThumbnail.path,
      'the A/B control must use the exact production thumbnail path');
    assert.equal(experiment.thumbnailVariants[0].thumbnailRecordId, thumbnail.id,
      'the A/B control must retain the source thumbnail record identity');
    assert.equal(experiment.thumbnailVariants[1].path, '/uploads/thumbnails/variant-a.jpg');

    process.stdout.write('Thumbnail database and A/B reference integrity tests passed\\n');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
