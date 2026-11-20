const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SceneRepairService } = require('../utils/scene-repair-service');

async function run() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-repair-cache-'));
  try {
    const visualPath = path.join(directory, 'visual.png');
    const audioPath = path.join(directory, 'narration.mp3');
    await fs.writeFile(visualPath, Buffer.from('same-size-image-A'));
    await fs.writeFile(audioPath, Buffer.from('same-size-audio-A'));

    const service = new SceneRepairService({}, {}, { dataRoot: directory });
    service.activeRebuilds.add('locked-production');
    await assert.rejects(
      service.rebuild('locked-production'),
      error => error.code === 'SCENE_REBUILD_IN_PROGRESS' && error.status === 409
    );
    service.activeRebuilds.delete('locked-production');

    const scenes = [{
      id: 'scene-1', revision: 2, assetType: 'image', assetPath: visualPath,
      duration: 12, narrationStatus: 'current', audioPath, scriptText: 'Narration text'
    }];

    const first = await service.buildRebuildFingerprint(scenes, null);
    const repeated = await service.buildRebuildFingerprint(scenes, null);
    assert.equal(repeated, first, 'unchanged inputs should keep the same repair fingerprint');

    const visualStat = await fs.stat(visualPath);
    await fs.writeFile(visualPath, Buffer.from('same-size-image-B'));
    await fs.utimes(visualPath, visualStat.atime, visualStat.mtime);
    const changedVisual = await service.buildRebuildFingerprint(scenes, null);
    assert.notEqual(changedVisual, first, 'same-size visual content changes must invalidate repair cache');

    await fs.writeFile(visualPath, Buffer.from('same-size-image-A'));
    const restoredVisual = await service.buildRebuildFingerprint(scenes, null);
    assert.equal(restoredVisual, first, 'restoring original visual bytes should restore fingerprint');

    await fs.writeFile(audioPath, Buffer.from('same-size-audio-B'));
    const changedAudio = await service.buildRebuildFingerprint(scenes, null);
    assert.notEqual(changedAudio, first, 'narration changes must invalidate repair cache');

    const changedDuration = await service.buildRebuildFingerprint([{ ...scenes[0], duration: 13 }], null);
    assert.notEqual(changedDuration, first, 'duration changes must invalidate repair cache');

    const fallbackPath = path.join(directory, 'full-narration.mp3');
    await fs.writeFile(fallbackPath, Buffer.from('fallback-audio'));
    const fallbackOne = await service.buildRebuildFingerprint([{ ...scenes[0], audioPath: null }], fallbackPath);
    await fs.writeFile(fallbackPath, Buffer.from('fallback-audio-2'));
    const fallbackTwo = await service.buildRebuildFingerprint([{ ...scenes[0], audioPath: null }], fallbackPath);
    assert.notEqual(fallbackTwo, fallbackOne, 'fallback narration changes must invalidate repair cache');

    console.log('Scene repair cache fingerprint tests passed');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
