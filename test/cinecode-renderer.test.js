const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CineCodeRenderer } = require('../utils/cinecode-renderer');
const { AIVideoGenerator } = require('../utils/ai-video-generator');

async function run() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cinecode-renderer-'));
  const imageOne = path.join(directory, 'one.png');
  const imageTwo = path.join(directory, 'two.png');
  await fs.writeFile(imageOne, Buffer.from('image-one'));
  await fs.writeFile(imageTwo, Buffer.from('image-two'));
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

    const placeholder = new CineCodeRenderer({ runFFmpeg: async () => {}, logger: { info() {} } });
    await assert.rejects(() => placeholder.renderScenes({
      visualAssets: [path.join(directory, 'placeholder.info')],
      totalDuration: 6,
      outputDir: directory
    }), /simulated or non-image assets/);

    let slideshowCalls = 0;
    const fake = {
      logger: { info() {}, error() {} },
      mediaGeneration: { settings: async () => ({ provider: 'cinecode', resolution: '720p', aspectRatio: '16:9' }) },
      filterLocalImageAssets: async assets => assets,
      cineCodeRenderer: { renderScenes: async () => ({
        clips: [{ index: 1, label: 'Opening', prompt: 'Camera push', duration: 30, path: 'scene.mp4', provider: 'cinecode', model: 'local' }],
        totalDuration: 30, model: 'local', resolution: '1280x720', colorGrade: 'warm'
      }) },
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
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
  process.stdout.write('CineCode renderer tests passed\\n');
}

run().catch(error => {
  process.stderr.write('CineCode renderer tests failed: ' + (error.stack || error.message) + '\\n');
  process.exitCode = 1;
});
