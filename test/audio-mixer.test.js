const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
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
  const music = path.join(directory, 'agent-music.wav');
  const mixed = path.join(__dirname, '..', 'data', 'videos', 'audio-integration-test_music_mixed.mp4');
  const captions = path.join(directory, 'agent-captions.srt');
  const videosDirectory = path.join(__dirname, '..', 'data', 'videos');
  const finalPath = path.join(videosDirectory, 'audio-integration-test_captioned.mp4');
  await fs.mkdir(videosDirectory, { recursive: true });
  await runFFmpeg([
    '-y', '-f', 'lavfi', '-i', 'color=c=#203a5f:s=640x360:r=24:d=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source
  ]);
  await runFFmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2', music]);
  await fs.writeFile(captions, '1\n00:00:00,000 --> 00:00:02,000\nIntegration subtitle\n');
  const agent = Object.create(ProductionManagementAgent.prototype);
  agent.logger = { info() {}, warn() {}, error() {} };
  agent.aiVideoGenerator = {
    lastVideoResult: { actualProvider: 'cinecode', model: 'local-ffmpeg' },
    isUsableAudioFile: async () => true,
    generateVideo: async () => source
  };
  agent.audioMixer = mixBackgroundMusic;
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
          musicAsset: licensedMusic({
            path: music,
            title: 'Approved music',
            fadeInSeconds: 0.2,
            fadeOutSeconds: 0.3
          })
        }
      }
    }
  };
  try {
    const assembledPath = await agent.assembleVideo(production);
    assert.equal(assembledPath, finalPath);
    assert.equal(production.assets.backgroundMusic.status, 'mixed');
    assert.equal(production.assets.backgroundMusic.direction, 'subtle cinematic ambient');
    assert.equal(production.assets.backgroundMusic.licenseType, 'user_owned');
    assert.equal(production.assets.finalVideo.path, finalPath);
    assert.equal(production.assets.finalVideo.cleanPath, source);
    assert.ok(production.assets.finalVideo.cleanFileSize > 0);
    assert.notEqual(production.assets.finalVideo.cleanPath, production.assets.finalVideo.path);
    assert.ok((await fs.stat(finalPath)).size > 0);
    assert.ok((await fs.stat(production.assets.finalVideo.cleanPath)).size > 0);
    const info = await getMediaInfo(finalPath);
    const cleanInfo = await getMediaInfo(production.assets.finalVideo.cleanPath);
    assert.equal(info.hasAudio, true);
    assert.equal(cleanInfo.hasAudio, true);
    assert.equal(info.width, 640);
    assert.equal(info.height, 360);
    assert.ok(info.duration > 0);
    assert.equal(production.assets.captions.styleApplication.typographyApplied, true);
    assert.equal(production.assets.captions.styleApplication.placementApplied, true);
    await runFFmpeg(['-v', 'error', '-i', finalPath, '-f', 'null', '-']);
    await runFFmpeg(['-v', 'error', '-i', production.assets.finalVideo.cleanPath, '-f', 'null', '-']);

    // Compare matching frames: burned-in captions must create visible pixel changes.
    const finalFrame = path.join(directory, 'captioned-frame.png');
    const cleanFrame = path.join(directory, 'clean-frame.png');
    await runFFmpeg(['-y', '-ss', '1', '-i', finalPath, '-frames:v', '1', finalFrame]);
    await runFFmpeg(['-y', '-ss', '1', '-i', production.assets.finalVideo.cleanPath, '-frames:v', '1', cleanFrame]);
    const [finalPixels, cleanPixels] = await Promise.all([
      sharp(finalFrame).removeAlpha().raw().toBuffer(),
      sharp(cleanFrame).removeAlpha().raw().toBuffer()
    ]);
    assert.equal(finalPixels.length, cleanPixels.length);
    let visiblyChangedPixels = 0;
    for (let offset = 0; offset < finalPixels.length; offset += 3) {
      const delta = Math.abs(finalPixels[offset] - cleanPixels[offset]) +
        Math.abs(finalPixels[offset + 1] - cleanPixels[offset + 1]) +
        Math.abs(finalPixels[offset + 2] - cleanPixels[offset + 2]);
      if (delta > 90) visiblyChangedPixels++;
    }
    assert.ok(visiblyChangedPixels > 100, 'captioned output must visibly differ from the clean source frame');
  } finally {
    await Promise.all([source, music, mixed, captions, finalPath].map(file => fs.rm(file, { force: true })));
  }
}
async function testMusicMixCache(directory) {
  const video = path.join(directory, 'cache-source.mp4');
  const music = path.join(directory, 'cache-music.wav');
  const output = path.join(directory, 'cache-mixed.mp4');
  await fs.writeFile(video, 'video-v1');
  await fs.writeFile(music, 'music-v1');
  let encodes = 0;
  const dependencies = {
    runFFmpeg: async args => {
      if (String(args[args.length - 1]).endsWith('.mixing.mp4')) {
        encodes++;
        await fs.writeFile(args[args.length - 1], 'encoded-mix-' + encodes);
      }
    },
    getMediaInfo: async () => ({ duration: 12, hasAudio: true, width: 640, height: 360 }),
    getAudioInfo: async () => ({ duration: 8 })
  };
  const musicConfig = licensedMusic({ path: music });
  const first = await mixBackgroundMusic(video, output, musicConfig, dependencies);
  const second = await mixBackgroundMusic(video, output, musicConfig, dependencies);
  assert.equal(first.status, 'mixed');
  assert.equal(second.cached, true);
  assert.equal(encodes, 1, 'identical inputs must reuse the validated music mix');

  await fs.appendFile(music, '-changed');
  const third = await mixBackgroundMusic(video, output, musicConfig, dependencies);
  assert.equal(third.cached, undefined);
  assert.equal(encodes, 2, 'changed music must invalidate the mix cache');

  await fs.appendFile(video, '-changed');
  await mixBackgroundMusic(video, output, musicConfig, dependencies);
  assert.equal(encodes, 3, 'changed source video must invalidate the mix cache');
}

async function testFailedMixPreservesExistingOutput(directory) {
  const source = path.join(directory, 'failure-source.mp4');
  const music = path.join(directory, 'failure-music.wav');
  const output = path.join(directory, 'existing-output.mp4');
  const temporary = `${output}.mixing.mp4`;
  await fs.writeFile(source, 'source');
  await fs.writeFile(music, 'music');
  await fs.writeFile(output, 'previous-valid-output');

  await assert.rejects(
    mixBackgroundMusic(source, output, licensedMusic({ path: music }), {
      getMediaInfo: async () => ({ duration: 3, hasAudio: true, width: 640, height: 360 }),
      getAudioInfo: async () => ({ duration: 2 }),
      runFFmpeg: async args => {
        await fs.writeFile(args[args.length - 1], 'partial-mix');
        throw new Error('simulated encoder failure');
      }
    }),
    /simulated encoder failure/
  );

  assert.equal(await fs.readFile(output, 'utf8'), 'previous-valid-output',
    'a failed mix must not destroy the previously existing output');
  await assert.rejects(fs.stat(temporary), { code: 'ENOENT' });
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

  // The 880 Hz music bed must be present in the mix, not merely an audio stream.
  async function measureMusicBand(filePath) {
    const measured = await runFFmpeg([
      '-ss', '1', '-t', '1', '-i', filePath,
      '-af', 'bandpass=f=880:width_type=h:width=100,volumedetect',
      '-f', 'null', '-'
    ]);
    const match = String(measured.stderr || '').match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i);
    assert.ok(match, 'FFmpeg must report the filtered music-band level');
    return Number(match[1]);
  }
  const sourceMusicBand = await measureMusicBand(source);
  const mixedMusicBand = await measureMusicBand(output);
  assert.ok(mixedMusicBand > sourceMusicBand + 8,
    `background music must measurably increase its frequency band (source ${sourceMusicBand} dB, mixed ${mixedMusicBand} dB)`);
  await runFFmpeg(['-v', 'error', '-i', output, '-f', 'null', '-']);
}

async function run() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agenttube-audio-mixer-'));
  try {
    await testValidationAndArguments(directory);
    await testProductionIntegration(directory);
    await testFailedMixPreservesExistingOutput(directory);
    await testMusicMixCache(directory);
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
