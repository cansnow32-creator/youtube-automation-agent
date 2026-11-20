const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { AIVideoGenerator } = require('../utils/ai-video-generator');

function createGenerator() {
  const generator = Object.create(AIVideoGenerator.prototype);
  generator.logger = { info() {}, warn() {}, error() {} };
  generator.openai = {};
  generator.gemini = {};
  generator.geminiImageModel = () => 'test-image-model';
  return generator;
}

async function testPartialProviderOutputIsNotPublished() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agenttube-image-provider-'));
  const outputPath = path.join(directory, 'scene.png');
  const validImage = await sharp({
    create: { width: 3, height: 2, channels: 3, background: { r: 20, g: 80, b: 140 } }
  }).png().toBuffer();
  const generator = createGenerator();

  generator.generateOpenAIImage = async (_prompt, attemptPath) => {
    await fs.writeFile(attemptPath, 'partial OpenAI image response');
    throw new Error('OpenAI stream interrupted');
  };
  generator.generateGeminiImage = async (_prompt, attemptPath) => {
    await fs.writeFile(attemptPath, validImage);
    return attemptPath;
  };

  try {
    const result = await generator.generateImage('test prompt', outputPath);
    assert.equal(result, outputPath);
    const metadata = await sharp(outputPath).metadata();
    assert.equal(metadata.width, 3);
    assert.equal(metadata.height, 2);
    assert.deepEqual(await fs.readdir(directory), ['scene.png']);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function testAllFailedProviderAttemptsAreRemoved() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agenttube-image-provider-fail-'));
  const outputPath = path.join(directory, 'scene.png');
  const generator = createGenerator();

  generator.generateOpenAIImage = async (_prompt, attemptPath) => {
    await fs.writeFile(attemptPath, 'partial OpenAI image response');
    throw new Error('OpenAI failed');
  };
  generator.generateGeminiImage = async (_prompt, attemptPath) => {
    await fs.writeFile(attemptPath, 'partial Gemini image response');
    throw new Error('Gemini failed');
  };

  try {
    await assert.rejects(generator.generateImage('test prompt', outputPath), /OpenAI image generation .* failed/);
    assert.deepEqual(await fs.readdir(directory), []);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function run() {
  await testPartialProviderOutputIsNotPublished();
  await testAllFailedProviderAttemptsAreRemoved();
  console.log('Image provider atomic-output tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
