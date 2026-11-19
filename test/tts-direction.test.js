const assert = require('node:assert/strict');
const { AIVideoGenerator } = require('../utils/ai-video-generator');

async function run() {
  let capturedDirection = null;
  const generator = {
    logger: { info() {}, error() {} },
    openai: {},
    generateOpenAITTS: async (_text, _path, direction) => {
      capturedDirection = direction;
      return 'narration.mp3';
    },
    isUsableAudioFile: async () => true
  };

  await AIVideoGenerator.prototype.generateTTSAudio.call(generator, 'A spoken script', 'narration.mp3', {
    direction: { narration: 'energetic and expressive', pacing: 'brisk' }
  });
  assert.deepEqual(capturedDirection, { narration: 'energetic and expressive', pacing: 'brisk' });
  assert.equal(generator.lastNarrationResult.directionApplied, true);
  assert.deepEqual(generator.lastNarrationResult.directionApplication.appliedFields, ['narration', 'pacing']);
  assert.deepEqual(generator.lastNarrationResult.directionApplication.unsupportedFields, ['music']);

  const calls = [];
  const openAIStub = {
    audio: { speech: { create: async options => {
      calls.push(options);
      return { arrayBuffer: async () => Buffer.from('audio-bytes') };
    } } }
  };
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tts-direction-'));
  try {
    await AIVideoGenerator.prototype.generateOpenAITTS.call({
      openai: openAIStub,
      logger: { info() {} }
    }, 'A spoken script', path.join(directory, 'voice.mp3'), {
      narration: 'warm documentary delivery',
      pacing: 'measured'
    });
    assert.match(calls[0].instructions, /warm documentary delivery/);
    assert.match(calls[0].instructions, /measured/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
  process.stdout.write('TTS direction tests passed\\n');
}

run().catch(error => {
  process.stderr.write('TTS direction tests failed: ' + (error.stack || error.message) + '\\n');
  process.exitCode = 1;
});
