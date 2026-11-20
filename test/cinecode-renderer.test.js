const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { CineCodeRenderer } = require('../utils/cinecode-renderer');
const { AIVideoGenerator } = require('../utils/ai-video-generator');
const { checkFFmpeg, runFFmpeg, getMediaDuration } = require('../utils/ffmpeg');

async function testCineCodeLeaseLossCleansPublishedScene() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cinecode-lease-loss-'));
  const imagePath = path.join(directory, 'source.png');
  await sharp({ create: { width: 32, height: 32, channels: 3, background: '#345678' } }).png().toFile(imagePath);
  const renderer = new CineCodeRenderer({
    runFFmpeg: async args => {
      await fs.writeFile(args.at(-1), Buffer.from('rendered-scene'));
    },
    logger: { info() {} }
  });
  let leaseChecks = 0;

  try {
    await assert.rejects(
      renderer.renderScenes({
        visualAssets: [imagePath],
        totalDuration: 6,
        outputDir: directory,
        outputPrefix: 'lease-attempt',
        resolution: '480p',
        aspectRatio: '16:9',
        assertLease: async () => {
          leaseChecks += 1;
          // The scene has been atomically published; loss must remove its output and manifest.
          if (leaseChecks >= 11) {
            throw Object.assign(new Error('generation lease lost during CineCode render'), {
              code: 'GENERATION_JOB_LEASE_LOST',
              status: 409
            });
          }
        }
      }),
      error => error.code === 'GENERATION_JOB_LEASE_LOST'
    );
    const files = await fs.readdir(directory);
    assert.deepEqual(files.sort(), ['source.png'],
      'CineCode must remove a just-published scene and any partial manifest after lease loss');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function run() {
  await testCineCodeLeaseLossCleansPublishedScene();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cinecode-renderer-'));
  const imageOne = path.join(directory, 'one.png');
  const imageTwo = path.join(directory, 'two.png');
  await sharp({ create: { width: 32, height: 32, channels: 3, background: '#345678' } }).png().toFile(imageOne);
  await sharp({ create: { width: 32, height: 32, channels: 3, background: '#876543' } }).png().toFile(imageTwo);
  const commands = [];
  try {
    const renderer = new CineCodeRenderer({
      runFFmpeg: async args => {
        commands.push(args);
        await fs.writeFile(args.at(-1), Buffer.from('rendered-video'));
      },
      logger: { info() {} }
    });
    const rendered = await renderer.renderScenes({
      visualAssets: [imageOne, imageTwo],
      totalDuration: 18,
      outputDir: directory,
      outputPrefix: 'test-film',
      resolution: '720p',
      aspectRatio: '16:9',
      concept: {
        visualDirection: { palette: 'warm amber sunset' },
        scenePlan: [
          { purpose: 'Opening', visual: 'Wide establishing shot' },
          { purpose: 'Payoff', visual: 'Close-up reveal' }
        ]
      }
    });
    assert.equal(rendered.clips.length, 2);
    assert.equal(rendered.totalDuration, 18);
    assert.equal(rendered.resolution, '1280x720');
    assert.match(rendered.colorGrade, /colorbalance/);
    const filter = commands[0].join(' ');
    assert.match(filter, /zoompan/);
    assert.match(filter, /vignette/);
    assert.match(filter, /fade=t=in/);
    assert.match(filter, /fade=t=out/);
    assert.equal(rendered.clips[1].label, 'Payoff');
    assert.equal(commands.length, 2, 'first pass should render both scenes');

    // A retry with unchanged source images and render settings must reuse both clips.
    await renderer.renderScenes({
      visualAssets: [imageOne, imageTwo],
      totalDuration: 18,
      outputDir: directory,
      outputPrefix: 'test-film',
      resolution: '720p',
      aspectRatio: '16:9',
      concept: {
        visualDirection: { palette: 'warm amber sunset' },
        scenePlan: [
          { purpose: 'Opening', visual: 'Wide establishing shot' },
          { purpose: 'Payoff', visual: 'Close-up reveal' }
        ]
      }
    });
    assert.equal(commands.length, 2, 'completed scenes should not render again on retry');

    // A changed render setting invalidates the cache for affected scenes.
    await renderer.renderScenes({
      visualAssets: [imageOne, imageTwo],
      totalDuration: 18,
      outputDir: directory,
      outputPrefix: 'test-film',
      resolution: '720p',
      aspectRatio: '16:9',
      concept: { visualDirection: { palette: 'cool blue' }, scenePlan: [] }
    });
    assert.equal(commands.length, 4, 'changed visual direction must invalidate cached renders');

    // Content changes must invalidate a scene even when size and mtime are preserved.
    const imageStat = await fs.stat(imageOne);
    const imageBytes = await fs.readFile(imageOne);
    const replacementImage = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#123456' } }).png().toBuffer();
    assert.equal(replacementImage.length, imageBytes.length, 'fixture images must have identical byte lengths');
    await fs.writeFile(imageOne, replacementImage);
    await fs.utimes(imageOne, imageStat.atime, imageStat.mtime);
    await renderer.renderScenes({
      visualAssets: [imageOne, imageTwo], totalDuration: 18, outputDir: directory,
      outputPrefix: 'test-film', resolution: '720p', aspectRatio: '16:9',
      concept: { visualDirection: { palette: 'cool blue' }, scenePlan: [] }
    });
    assert.equal(commands.length, 5, 'same-size content replacement must invalidate only the changed scene');

    const placeholder = new CineCodeRenderer({ runFFmpeg: async () => {}, logger: { info() {} } });
    await assert.rejects(() => placeholder.renderScenes({
      visualAssets: [path.join(directory, 'placeholder.info')],
      totalDuration: 6,
      outputDir: directory
    }), /simulated or non-image assets/);

    const corruptImage = path.join(directory, 'corrupt.png');
    await fs.writeFile(corruptImage, Buffer.from('not-an-image'));
    await assert.rejects(() => placeholder.renderScenes({
      visualAssets: [corruptImage],
      totalDuration: 6,
      outputDir: directory
    }), /not a decodable image/);

    let slideshowCalls = 0;
    const fake = {
      logger: { info() {}, error() {} },
      mediaGeneration: { settings: async () => ({ provider: 'cinecode', resolution: '720p', aspectRatio: '16:9' }) },
      filterLocalImageAssets: async assets => assets,
      cineCodeRenderer: { renderScenes: async options => {
        assert.equal(typeof options.assertLease, 'function', 'the job lease must reach CineCode rendering');
        assert.equal(options.outputPrefix, 'final');
        return {
          clips: [{ index: 1, label: 'Opening', prompt: 'Camera push', duration: 30, path: 'scene.mp4', provider: 'cinecode', model: 'local' }],
          totalDuration: 30, model: 'local', resolution: '1280x720', colorGrade: 'warm'
        };
      } },
      generateHybridVideo: async () => 'final.mp4',
      generateSlideshowVideo: async () => { slideshowCalls++; return 'fallback.mp4'; }
    };
    const output = await AIVideoGenerator.prototype.generateVideo.call(
      fake, { title: 'Test' }, [imageOne], 'voice.mp3', 'final.mp4',
      { productionId: 'production-1', estimatedDuration: 30, approvedVideoConcept: { scenePlan: [] } }
    );
    assert.equal(output, 'final.mp4');
    assert.equal(fake.lastVideoResult.actualProvider, 'cinecode');
    assert.equal(slideshowCalls, 0);

    let receivedAttemptId = null;
    let receivedLease = null;
    const leaseLostGenerator = {
      logger: { info() {}, error() {} },
      mediaGeneration: {
        settings: async () => ({ provider: 'replicate', resolution: '720p', aspectRatio: '16:9' }),
        generateClips: async options => {
          receivedAttemptId = options.attemptId;
          receivedLease = options.assertLease;
          throw Object.assign(new Error('generation lease lost while waiting for remote clip'), {
            code: 'GENERATION_JOB_LEASE_LOST',
            status: 409
          });
        }
      },
      generateSlideshowVideo: async () => {
        slideshowCalls++;
        return 'unexpected-fallback.mp4';
      }
    };
    await assert.rejects(
      () => AIVideoGenerator.prototype.generateVideo.call(
        leaseLostGenerator, { title: 'Test' }, [imageOne], 'voice.mp3', 'lease-fenced-final.mp4',
        {
          productionId: 'production-lease-fence',
          attemptId: 'attempt-lease-1',
          assertLease: async () => {}
        }
      ),
      error => error.code === 'GENERATION_JOB_LEASE_LOST'
    );
    assert.equal(receivedAttemptId, 'attempt-lease-1');
    assert.equal(typeof receivedLease, 'function');
    assert.equal(slideshowCalls, 0, 'lease loss must not trigger the slideshow fallback');

    const failing = {
      ...fake,
      cineCodeRenderer: { renderScenes: async () => { throw new Error('CineCode test failure'); } }
    };
    await assert.rejects(
      () => AIVideoGenerator.prototype.generateVideo.call(
        failing, { title: 'Test' }, [imageOne], 'voice.mp3', 'final.mp4',
        { productionId: 'production-2', estimatedDuration: 30 }
      ),
      /CineCode test failure/
    );
    assert.equal(failing.lastVideoResult.actualProvider, 'failed');
    assert.equal(slideshowCalls, 0);

    const validator = Object.create(AIVideoGenerator.prototype);
    const validationPath = path.join(directory, 'validation.mp4');
    await fs.writeFile(validationPath, Buffer.from('video-container'));
    let decodeCommand = null;
    validator.getMediaDuration = async () => 4.5;
    validator.runFFmpeg = async args => { decodeCommand = args; };
    const validation = await validator.validateRenderedVideo(validationPath);
    assert.equal(validation.duration, 4.5);
    assert.equal(validation.size, Buffer.byteLength('video-container'));
    assert.deepEqual(decodeCommand, ['-v', 'error', '-i', validationPath, '-f', 'null', '-']);

    validator.getMediaDuration = async () => 0;
    await assert.rejects(() => validator.validateRenderedVideo(validationPath), /no valid media duration/);

    const ffmpegAvailable = await checkFFmpeg();
    if (!ffmpegAvailable && process.env.CI === 'true') {
      throw new Error('CI must provide FFmpeg for the real CineCode render smoke test');
    }
    if (ffmpegAvailable) {
      let leaseChecks = 0;
      const leaseLoss = Object.assign(new Error('generation lease lost during FFmpeg child process'), {
        code: 'GENERATION_JOB_LEASE_LOST'
      });
      await assert.rejects(
        runFFmpeg([
          '-re', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30',
          '-t', '20', '-f', 'null', '-'
        ], {
          leaseCheckIntervalMs: 50,
          assertLease: async () => {
            leaseChecks += 1;
            if (leaseChecks >= 2) throw leaseLoss;
          }
        }),
        error => error.code === 'GENERATION_JOB_LEASE_LOST'
      );
      assert.ok(leaseChecks >= 2, 'FFmpeg lease monitor must check ownership while the child process is running');

      const realRenderer = new CineCodeRenderer({ logger: { info() {} } });
      const realRender = await realRenderer.renderScenes({
        visualAssets: [imageOne],
        totalDuration: 3,
        outputDir: directory,
        outputPrefix: 'real-ffmpeg-smoke',
        resolution: '480p',
        aspectRatio: '16:9',
        concept: { visualDirection: { palette: 'cool blue' }, scenePlan: [{ purpose: 'FFmpeg smoke test' }] }
      });
      assert.equal(realRender.clips.length, 1);

      const audioPath = path.join(directory, 'smoke-audio.wav');
      await runFFmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'pcm_s16le', audioPath]);
      const realGenerator = new AIVideoGenerator({}, { getMediaDuration, runFFmpeg });
      const finalPath = path.join(directory, 'real-ffmpeg-final.mp4');
      await realGenerator.generateHybridVideo(
        realRender.clips, [], audioPath, finalPath, 3,
        { width: realRender.width, height: realRender.height }
      );
      const finalStats = await fs.stat(finalPath);
      assert.ok(finalStats.size > 0, 'real FFmpeg assembly must produce a final MP4');
      assert.ok((await getMediaDuration(finalPath)) > 0, 'final MP4 must have a readable duration');
      assert.equal(await fs.access(finalPath).then(() => true, () => false), true);
      assert.equal(await fs.access(path.join(directory, 'real-ffmpeg-final_hybrid_visual.mp4')).then(() => true, () => false), true,
        'successful assembly keeps the visual-only cache for a future retry');
      assert.equal(await fs.access(path.join(directory, 'real-ffmpeg-final_hybrid_visual.mp4.render.json')).then(() => true, () => false), true);
      assert.equal(await fs.access(path.join(directory, 'real-ffmpeg-final_finalizing.mp4')).then(() => true, () => false), false);

      // If audio mux fails, the completed visual timeline survives and is reused.
      const retrySource = path.join(directory, 'retry-source.mp4');
      const retryAudio = path.join(directory, 'retry-audio.mp3');
      const retryOutput = path.join(directory, 'retry-output.mp4');
      await fs.writeFile(retrySource, Buffer.from('source-video'));
      await fs.writeFile(retryAudio, Buffer.from('source-audio'));
      const retryGenerator = Object.create(AIVideoGenerator.prototype);
      retryGenerator.logger = { info() {} };
      retryGenerator.filterLocalImageAssets = async () => [];
      retryGenerator.parseDurationSeconds = value => Number(value) || 0;
      let timelineRenders = 0;
      let muxAttempts = 0;
      retryGenerator.renderMediaTimeline = async (_segments, target) => {
        timelineRenders++;
        await fs.writeFile(target, Buffer.from('visual-only-video'));
        return target;
      };
      retryGenerator.validateRenderedVideo = async target => {
        const stats = await fs.stat(target);
        assert.ok(stats.size > 0);
        return { path: target, size: stats.size, duration: 3 };
      };
      retryGenerator.addAudioToVideo = async (_visual, _audio, target) => {
        muxAttempts++;
        if (muxAttempts === 1) throw new Error('simulated audio mux failure');
        await fs.writeFile(target, Buffer.from('final-video'));
      };
      await assert.rejects(
        () => retryGenerator.generateHybridVideo(
          [{ path: retrySource, duration: 3 }], [], retryAudio, retryOutput, 3, { width: 1280, height: 720 }
        ),
        /simulated audio mux failure/
      );
      const retryVisual = path.join(directory, 'retry-output_hybrid_visual.mp4');
      assert.equal(await fs.access(retryVisual).then(() => true, () => false), true,
        'visual-only output must survive an audio mux failure');
      await retryGenerator.generateHybridVideo(
        [{ path: retrySource, duration: 3 }], [], retryAudio, retryOutput, 3, { width: 1280, height: 720 }
      );
      assert.equal(timelineRenders, 1, 'retry must reuse the completed visual timeline');
      assert.equal(muxAttempts, 2, 'audio mux should be retried');
      assert.equal(await fs.access(retryOutput).then(() => true, () => false), true);

      // An identical retry reuses both the visual timeline and the validated final mux.
      await retryGenerator.generateHybridVideo(
        [{ path: retrySource, duration: 3 }], [], retryAudio, retryOutput, 3, { width: 1280, height: 720 }
      );
      assert.equal(timelineRenders, 1);
      assert.equal(muxAttempts, 2, 'a matching final assembly should not mux again');

      // Changed narration audio remuxes the existing visual timeline only.
      await fs.appendFile(retryAudio, Buffer.from('-new-audio'));
      await retryGenerator.generateHybridVideo(
        [{ path: retrySource, duration: 3 }], [], retryAudio, retryOutput, 3, { width: 1280, height: 720 }
      );
      assert.equal(timelineRenders, 1, 'audio changes must not invalidate visual rendering');
      assert.equal(muxAttempts, 3, 'changed audio must invalidate the final assembly cache');

      // A changed visual source invalidates the visual cache and final assembly.
      await fs.appendFile(retrySource, Buffer.from('-changed'));
      await retryGenerator.generateHybridVideo(
        [{ path: retrySource, duration: 3 }], [], retryAudio, retryOutput, 3, { width: 1280, height: 720 }
      );
      assert.equal(timelineRenders, 2, 'changed visual inputs must invalidate the visual cache');
      assert.equal(muxAttempts, 4, 'changed visual inputs require a fresh final mux');

      // A same-size replacement with the original mtime must still invalidate the visual cache.
      const sourceStat = await fs.stat(retrySource);
      const sourceBytes = await fs.readFile(retrySource);
      const sameSizeReplacement = Buffer.from(sourceBytes.map((byte, index) => (byte + index + 1) % 256));
      assert.equal(sameSizeReplacement.length, sourceBytes.length);
      await fs.writeFile(retrySource, sameSizeReplacement);
      await fs.utimes(retrySource, sourceStat.atime, sourceStat.mtime);
      await retryGenerator.generateHybridVideo(
        [{ path: retrySource, duration: 3 }], [], retryAudio, retryOutput, 3, { width: 1280, height: 720 }
      );
      assert.equal(timelineRenders, 3, 'same-size source content changes must invalidate visual rendering');
      assert.equal(muxAttempts, 5, 'same-size source content changes must invalidate final assembly');
    } else {
      process.stdout.write('FFmpeg unavailable locally; real render smoke test skipped\\n');
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
  process.stdout.write('CineCode renderer tests passed\\n');
}

run().catch(error => {
  process.stderr.write('CineCode renderer tests failed: ' + (error.stack || error.message) + '\\n');
  process.exitCode = 1;
});
