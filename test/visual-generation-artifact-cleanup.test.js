const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AIVideoGenerator } = require('../utils/ai-video-generator');

async function run() {
  const partialPath = path.join(os.tmpdir(), `agenttube-partial-visual-${process.pid}-${Date.now()}.png`);
  const simulatedPath = path.join(os.tmpdir(), `agenttube-visual-fallback-${process.pid}-${Date.now()}.info`);
  const generator = Object.create(AIVideoGenerator.prototype);
  generator.logger = { info() {}, warn() {}, error() {} };
  generator.openai = {};
  generator.gemini = null;
  generator.enhanceVisualPrompt = prompt => prompt;
  generator.generateImage = async (_prompt, _imagePath) => {
    await fs.writeFile(partialPath, 'partial image bytes');
    throw new Error('provider failed after partial write');
  };
  generator.simulateVisualAssets = async () => {
    await fs.writeFile(simulatedPath, 'fallback metadata');
    return [simulatedPath];
  };

  try {
    const result = await generator.generateVisualAssets('test scene', 'test', 1);
    assert.deepEqual(result, [simulatedPath]);
    await assert.rejects(fs.access(partialPath), { code: 'ENOENT' });
  } finally {
    await fs.unlink(partialPath).catch(() => {});
    await fs.unlink(simulatedPath).catch(() => {});
  }

  let leasePartialPath = null;
  let fallbackCalled = false;
  generator.generateImage = async (_prompt, imagePath) => {
    leasePartialPath = imagePath;
    await fs.writeFile(imagePath, 'late provider output');
    return imagePath;
  };
  generator.simulateVisualAssets = async () => {
    fallbackCalled = true;
    throw new Error('fallback must not run after lease loss');
  };
  let leaseChecks = 0;

  try {
    await assert.rejects(
      generator.generateVisualAssets('lease-lost scene', 'test', 1, async () => {
        leaseChecks += 1;
        if (leaseChecks === 3) {
          throw Object.assign(new Error('generation lease lost'), { code: 'GENERATION_JOB_LEASE_LOST' });
        }
      }),
      error => error.code === 'GENERATION_JOB_LEASE_LOST'
    );
    assert.equal(fallbackCalled, false, 'lease loss must not trigger simulated fallback generation');
    await assert.rejects(fs.access(leasePartialPath), { code: 'ENOENT' });
  } finally {
    if (leasePartialPath) await fs.unlink(leasePartialPath).catch(() => {});
  }

  console.log('Visual generation artifact cleanup tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
