const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SceneRepairService } = require('../utils/scene-repair-service');

async function run() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-regeneration-lease-'));
  try {
    const db = {
      updateProductionScene: async () => ({ id: 'scene-1' }),
      saveProductionSceneRevision: async () => {}
    };
    const videoGenerator = {
      lastNarrationResult: { provider: 'test-tts' },
      generateTTSAudio: async (_text, outputPath) => {
        await fs.writeFile(outputPath, 'partial-or-complete-audio');
        return outputPath;
      },
      isUsableAudioFile: async () => true
    };
    const service = new SceneRepairService(db, videoGenerator, { dataRoot: directory });
    const scene = {
      id: 'scene-1', position: 1, revision: 4, scriptText: 'Test narration',
      narrationStatus: 'stale', status: 'needs_rebuild'
    };
    service.getEditableBundle = async () => ({ id: 'production-1', scenes: [scene] });
    let checks = 0;
    await assert.rejects(
      service.regenerateNarrationUnlocked('production-1', 'scene-1', { confirmCost: true }, async () => {
        checks += 1;
        if (checks >= 3) throw Object.assign(new Error('lease lost'), { code: 'SCENE_EDIT_LEASE_LOST' });
      }),
      error => error.code === 'SCENE_EDIT_LEASE_LOST'
    );
    const audioDirectory = path.join(directory, 'audio', 'scenes', 'production-1');
    const remaining = await fs.readdir(audioDirectory);
    assert.deepEqual(remaining, [], 'audio produced by a stale narration attempt must be removed');
    console.log('Scene regeneration lease cleanup tests passed');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
