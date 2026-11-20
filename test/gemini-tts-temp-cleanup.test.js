const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AIVideoGenerator } = require('../utils/ai-video-generator');

function createGenerator(audioData) {
  const generator = Object.create(AIVideoGenerator.prototype);
  generator.logger = { info() {}, warn() {}, error() {} };
  generator.gemini = {
    models: {
      generateContent: async () => ({
        candidates: [{ content: { parts: [{ inlineData: { data: audioData } }] } }]
      })
    }
  };
  return generator;
}

async function testPcmSidecarIsRemovedWhenFfmpegFails() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agenttube-gemini-tts-fail-'));
  const outputPath = path.join(directory, 'narration.mp3');
  const generator = createGenerator(Buffer.from('pcm audio').toString('base64'));
  generator.runFFmpeg = async () => {
    throw new Error('simulated FFmpeg conversion failure');
  };

  try {
    await assert.rejects(generator.generateGeminiTTS('test narration', outputPath), /FFmpeg conversion failure/);
    await assert.rejects(fs.access(outputPath + '.pcm'), { code: 'ENOENT' });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function testPcmSidecarIsRemovedAfterSuccessfulConversion() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agenttube-gemini-tts-ok-'));
  const outputPath = path.join(directory, 'narration.mp3');
  const generator = createGenerator(Buffer.from('pcm audio').toString('base64'));
  generator.runFFmpeg = async args => {
    await fs.writeFile(args[args.length - 1], 'converted audio');
  };

  try {
    const result = await generator.generateGeminiTTS('test narration', outputPath);
    assert.equal(result, outputPath);
    assert.equal(await fs.readFile(outputPath, 'utf8'), 'converted audio');
    await assert.rejects(fs.access(outputPath + '.pcm'), { code: 'ENOENT' });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function run() {
  await testPcmSidecarIsRemovedWhenFfmpegFails();
  await testPcmSidecarIsRemovedAfterSuccessfulConversion();
  console.log('Gemini TTS temporary-file cleanup tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
