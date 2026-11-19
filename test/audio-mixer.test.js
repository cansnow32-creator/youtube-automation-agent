const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { mixBackgroundMusic, validateMusicRights } = require('../utils/audio-mixer');
const { checkFFmpeg, runFFmpeg, getMediaInfo, getAudioInfo } = require('../utils/ffmpeg');
const { ProductionManagementAgent } = require('../agents/production-management-agent');

const licensedMusic = overrides => ({
  enabled: true,
  path: '/unused/music.wav',
  title: 'Test ambient bed',
  creator: 'Test creator',
  licenseType: 'user_owned',
  rightsConfirmed: true,
  volume: 0.18,
  fadeInSeconds: 1,
  fadeOutSeconds: 1,
  ...overrides
});

async function testValidationAndArguments(directory) {
  assert.throws(() => validateMusicRights(licensedMusic({ rightsConfirmed: false })), /confirm that you own/);
  assert.throws(() => validateMusicRights(licensedMusic({ licenseType: 'cc_by', attribution: '' })), /requires its attribution/);
  assert.throws(() => validateMusicRights(licensedMusic({ licenseType: 'commercial_license' })), /requires a license name or license URL/);

  const videoPath = path.join(directory, 'source.mp4');
  const musicPath = path.join(directory, 'music.wav');
  const outputPath = path.join(directory, 'mixed.mp4');
  await fs.writeFile(videoPath, Buffer.from('source'));
  await fs.writeFile(musicPath, Buffer.from('music'));

  let capturedArgs = null;
  const result = await mixBackgroundMusic(videoPath, outputPath, licensedMusic({ path: musicPath, licenseUrl: 'https://example.com/license' }), {
    runFFmpeg: async args => {
      if (args[args.length - 1].endsWith('.mixing.mp4')) {
        capturedArgs = args;
        await fs.writeFile(args[args.length - 1], Buffer.from('mixed'));
      }
    },
    getMediaInfo: async () => ({ duration: 20, width: 1920, height: 1080, hasAudio: true }),
    getAudioInfo: async () => ({ duration: 8, codec: 'pcm_s16le' })
  });
  assert.equal(result.status, 'mixed');
  assert.equal(result.licenseType, 'user_owned');
  assert.equal(result.rightsConfirmed, true);
  assert.equal(result.trackDuration, 8);
  assert.equal(result.sourcePath, musicPath);
  assert.ok(result.sourceFileSize > 0);
  assert.ok(capturedArgs.includes('-stream_loop'));
  assert.ok(capturedArgs.some(value => String(value).includes('amix=inputs=2')));
  await fs.access(outputPath);

  await assert.rejects(() => mixBackgroundMusic(videoPath, outputPath, licensedMusic({ path: musicPath, rightsConfirmed: false }), {
    runFFmpeg: async () => { throw new Error('must not execute'); },
    getMediaInfo: async () => ({ duration: 20, hasAudio: true }),
    getAudioInfo: async () => ({ duration: 8 })
  }), /confirm that you own/);
}

async function testProductionIntegration(directory) {
  const source = path.join(directory, 'agent-source.mp4');
  const mixed = path.join(directory, 'agent-mixed.mp4');
  const captions = path.join(directory, 'agent-captions.srt');
  const videosDirectory = path.join(__dirname, '..', 'data', 'videos');
  const finalPath = path.join(videosDirectory, 'audio-integration-test_captioned.mp4');
  await fs.mkdir(videosDirectory, { recursive: true });
  await runFFmpeg([
    '-y', '-f', 'lavfi', '-i', 'color=c=#203a5f:s=640x360:r=24:d=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source
  ]);
  await fs.writeFile(captions, '1\\n00:00:00,000 --> 00:00:02,000\\nIntegration subtitle\\n');
  const agent = Object.create(ProductionManagementAgent.prototype);
  agent.logger = { info() {}, warn() {}, error() {} };
  agent.aiVideoGenerator = {
    lastVideoResult: { actualProvider: 'cinecode', model: 'local-ffmpeg' },
    isUsableAudioFile: async () => true,
    generateVideo: async () => source
  };
  agent.audioMixer = async (input, _output, music) => {
    assert.equal(music.title, 'Approved music');
    await fs.copyFile(input, mixed);
    return { status: 'mixed', path: mixed, licenseType: music.licenseType, rightsConfirmed: true };
  };
  agent.audioMixerDependencies = {};
  const production = {
    id: 'audio-integration-test',
    script: { title: 'Test' },
    estimatedDuration: 5,
    assets: {
      audio: { path: 'narration.mp3' },
      video: { visualAssets: [] },
      captions: { path: captions }
    },
    strategy: {
      approvedVideoConcept: {
        audioDirection: {
          narration: 'warm',
          music: 'subtle cinematic ambient',
          musicAsset: licensedMusic({ path: '/test/music.wav', title: 'Approved music' })
        }
      }
    }
  };
  try {
    const assembledPath = await agent.assembleVideo(production);
    assert.equal(assembledPath, finalPath);
    assert.equal(production.assets.backgroundMusic.status, 'mixed');
    assert.equal(production.assets.backgroundMusic.direction, 'subtle cinematic ambient');
    assert.equal(production.assets.finalVideo.path, finalPath);
    assert.ok((await fs.stat(finalPath)).size > 0);
    const info = await getMediaInfo(finalPath);
    assert.equal(info.hasAudio, true);
    await runFFmpeg(['-v', 'error', '-i', finalPath, '-f', 'null', '-']);
  } finally {
    await Promise.all([source, mixed, captions, finalPath].map(file => fs.rm(file, { force: true })));
  }
}

async function testRealFFmpegMix(directory) {
  if (!await checkFFmpeg()) {
    process.stdout.write('Audio mixer FFmpeg smoke test skipped: FFmpeg is unavailable\\n');
    return;
  }
  const source = path.join(directory, 'real-source.mp4');
  const music = path.join(directory, 'real-music.wav');
  const output = path.join(directory, 'real-mixed.mp4');
  await runFFmpeg([
    '-y', '-f', 'lavfi', '-i', 'color=c=#203a5f:s=640x360:r=24:d=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source
  ]);
  await runFFmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2', music]);
  const result = await mixBackgroundMusic(source, output, licensedMusic({
    path: music, title: 'Smoke-test music', loop: true, fadeInSeconds: 0.2, fadeOutSeconds: 0.3
  }));
  assert.equal(result.status, 'mixed');
  const info = await getMediaInfo(output);
  assert.equal(info.hasAudio, true);
  assert.ok(Math.abs(info.duration - 3) < 0.5);
  assert.ok((await getAudioInfo(output)).duration > 0);
  await runFFmpeg(['-v', 'error', '-i', output, '-f', 'null', '-']);
}

async function run() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agenttube-audio-mixer-'));
  try {
    await testValidationAndArguments(directory);
    await testProductionIntegration(directory);
    await testRealFFmpegMix(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
  process.stdout.write('Audio mixer tests passed\\n');
}

run().catch(error => {
  process.stderr.write('Audio mixer tests failed: ' + (error.stack || error.message) + '\\n');
  process.exitCode = 1;
});
