const assert = require('assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { ProductionManagementAgent } = require('../agents/production-management-agent');

async function run() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agenttube-scene-retry-'));
  try {
    const agent = Object.create(ProductionManagementAgent.prototype);
    const persisted = [];
  const createImage = filePath => sharp({ create: { width: 24, height: 24, channels: 3, background: '#456789' } }).png().toFile(filePath);
    let generationCalls = 0;
    agent.logger = { info() {}, warn() {}, error() {} };
    agent.db = {
      async getChannelProfile() { return { visual_style: 'cinematic' }; },
      async updateProductionData(data) { persisted.push(JSON.parse(JSON.stringify(data.assets.video || {}))); }
    };
    agent.createVisualPromptsFromScript = () => Array.from({ length: 12 }, (_, i) => `scene prompt ${i}`);
    const priorScenes = [];
    for (let i = 0; i < 9; i++) {
      const filePath = path.join(tempDir, `scene-${i}.png`);
      await createImage(filePath);
      priorScenes.push({
        sceneIndex: i,
        promptHash: require('crypto').createHash('sha256')
          .update(JSON.stringify({ prompt: `scene prompt ${i}`, visualStyle: 'cinematic' })).digest('hex'),
        path: filePath,
        status: 'ready'
      });
    }
    agent.aiVideoGenerator = {
      async generateVisualAssets(prompt) {
        generationCalls++;
        const index = Number(prompt.match(/(\d+)$/)[1]);
        const filePath = path.join(tempDir, `generated-${index}.png`);
        await createImage(filePath);
        return [filePath];
      }
    };
    const production = {
      id: 'prod-test',
      script: { title: 'Test' },
      strategy: {},
      estimatedDuration: 60,
      assets: { video: { visualSceneAssets: priorScenes, visualAssets: priorScenes.map(scene => scene.path) } },
      timeline: {}
    };

    const assets = await agent.generateVideoContent(production);
    assert.strictEqual(generationCalls, 3, 'only the 3 missing scenes should be generated');
    assert.strictEqual(assets.length, 12);
    assert.strictEqual(production.assets.video.visualSceneAssets.length, 12);
    assert.strictEqual(persisted.length >= 4, true, 'each generated scene and final state should be persisted');

    // Changing one prompt invalidates only that scene's prompt hash.
    agent.createVisualPromptsFromScript = () => Array.from({ length: 12 }, (_, i) => i === 4 ? 'changed scene prompt 4' : `scene prompt ${i}`);
    const callsBefore = generationCalls;
    const secondAssets = await agent.generateVideoContent(production);
    assert.strictEqual(generationCalls - callsBefore, 1, 'only the changed scene should be regenerated');
    assert.strictEqual(secondAssets.length, 12);

    // Missing files are treated as incomplete and regenerated rather than reused.
    const missingIndex = 2;
    await fs.unlink(production.assets.video.visualSceneAssets[missingIndex].path);
    const callsBeforeMissing = generationCalls;
    await agent.generateVideoContent(production);
    assert.strictEqual(generationCalls - callsBeforeMissing, 1, 'a missing image should be regenerated');

    // Non-empty but corrupt image files must not be treated as reusable scenes.
    const corruptIndex = 3;
    await fs.writeFile(production.assets.video.visualSceneAssets[corruptIndex].path, Buffer.from('corrupt-image'));
    const callsBeforeCorrupt = generationCalls;
    await agent.generateVideoContent(production);
    assert.strictEqual(generationCalls - callsBeforeCorrupt, 1, 'a corrupt image should be regenerated');
    console.log('Production scene asset retry tests passed.');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
