const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { SceneRepairService } = require('../utils/scene-repair-service');

async function run() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-repair-validation-'));
  try {
    const imagePath = path.join(directory, 'scene.png');
    const corruptImagePath = path.join(directory, 'corrupt.png');
    const videoPath = path.join(directory, 'scene.mp4');
    const corruptVideoPath = path.join(directory, 'corrupt.mp4');
    const audioPath = path.join(directory, 'scene.mp3');
    const corruptAudioPath = path.join(directory, 'corrupt.mp3');

    await sharp({ create: { width: 16, height: 16, channels: 3, background: '#345678' } }).png().toFile(imagePath);
    await fs.writeFile(corruptImagePath, Buffer.from('not-an-image'));
    await fs.writeFile(videoPath, Buffer.from('valid-video-fixture'));
    await fs.writeFile(corruptVideoPath, Buffer.from('invalid-video-fixture'));
    await fs.writeFile(audioPath, Buffer.from('valid-audio-fixture'));
    await fs.writeFile(corruptAudioPath, Buffer.from('invalid-audio-fixture'));

    const service = new SceneRepairService({}, {
      mediaGeneration: {
        isValidVideo: async filePath => filePath === videoPath
      },
      isUsableAudioFile: async filePath => filePath === audioPath
    }, { dataRoot: directory });

    assert.equal(await service.isUsableSceneAsset({ assetType: 'image', assetPath: imagePath }), true);
    assert.equal(await service.isUsableSceneAsset({ assetType: 'image', assetPath: corruptImagePath }), false);
    assert.equal(await service.isUsableSceneAsset({ assetType: 'video', assetPath: videoPath }), true);
    assert.equal(await service.isUsableSceneAsset({ assetType: 'video', assetPath: corruptVideoPath }), false);
    assert.equal(await service.isUsableSceneAsset({ assetType: 'video', assetPath: imagePath }), false);
    assert.equal(await service.isUsableSceneAsset({ assetType: 'unknown', assetPath: imagePath }), false);

    assert.equal(await service.isUsableNarrationSegment({ narrationStatus: 'current', audioPath }), true);
    assert.equal(await service.isUsableNarrationSegment({ narrationStatus: 'current', audioPath: corruptAudioPath }), false);
    assert.equal(await service.isUsableNarrationSegment({ narrationStatus: 'stale', audioPath }), false);
    assert.equal(await service.isUsableNarrationSegment({ narrationStatus: 'current', audioPath: null }), false);

    console.log('Scene repair media validation tests passed');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
