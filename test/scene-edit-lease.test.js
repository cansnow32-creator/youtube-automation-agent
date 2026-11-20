const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SceneRepairService } = require('../utils/scene-repair-service');

function editableBundle() {
  return {
    id: 'production-1',
    schedule: null,
    review_status: 'draft',
    provenance: { sources: [], claims: [], containsSyntheticMedia: false },
    scenes: [{
      id: 'scene-1', position: 0, label: 'Opening', scriptText: 'Original narration',
      prompt: 'Original prompt', duration: 8, locked: false, revision: 1,
      narrationStatus: 'current', status: 'ready', provenanceSourceIds: []
    }]
  };
}

async function run() {
  for (const operation of ['updateScene', 'reorder']) {
    let writes = 0;
    const db = {
      acquireProductionOperationLock: async () => true,
      renewProductionOperationLock: async () => true,
      releaseProductionOperationLock: async () => true,
      updateProductionScene: async () => { writes += 1; },
      reorderProductionScenes: async () => { writes += 1; return [{ id: 'scene-1' }]; },
      saveProductionSceneRevision: async () => { writes += 1; }
    };
    const service = new SceneRepairService(db, {});
    service.getEditableBundle = async () => editableBundle();
    let assertions = 0;
    const assertLease = async () => {
      assertions += 1;
      if (assertions === 2) {
        throw Object.assign(new Error('lease lost'), { code: 'SCENE_EDIT_LEASE_LOST' });
      }
    };

    await assert.rejects(
      operation === 'updateScene'
        ? service.updateSceneUnlocked('production-1', 'scene-1', { scriptText: 'Changed narration' }, assertLease)
        : service.reorderUnlocked('production-1', ['scene-1'], assertLease),
      error => error.code === 'SCENE_EDIT_LEASE_LOST'
    );
    assert.equal(writes, 0, operation + ' must not write after lease loss');
  }

  for (const operation of ['updateScene', 'reorder']) {
    const service = new SceneRepairService({}, {});
    await assert.rejects(
      operation === 'updateScene'
        ? service.updateScene('production-1', 'scene-1', { label: 'Changed' })
        : service.reorder('production-1', ['scene-1']),
      error => error.code === 'SCENE_EDIT_LOCK_UNAVAILABLE' && error.status === 503
    );
  }

  const missingRenewal = new SceneRepairService({
    acquireProductionOperationLock: async () => true,
    releaseProductionOperationLock: async () => true
  }, {});
  await assert.rejects(
    missingRenewal.updateScene('production-1', 'scene-1', { label: 'Changed' }),
    error => error.code === 'SCENE_EDIT_LOCK_UNAVAILABLE' && error.status === 503
  );

  let operationRan = false;
  const contended = new SceneRepairService({
    acquireProductionOperationLock: async () => false,
    renewProductionOperationLock: async () => true,
    releaseProductionOperationLock: async () => true
  }, {});
  await assert.rejects(
    contended.updateScene('production-1', 'scene-1', { label: 'Changed' }),
    error => error.code === 'SCENE_EDIT_IN_PROGRESS' && error.status === 409
  );
  assert.equal(operationRan, false);

  const assetService = new SceneRepairService({}, {});
  let assetUnlockedCalled = false;
  assetService.withProductionOperationLease = async (_id, callback) => callback(async () => {});
  assetService.replaceAssetUnlocked = async (...args) => {
    assetUnlockedCalled = true;
    assert.equal(typeof args[3], 'function', 'asset replacement receives the lease assertion');
    return 'asset-replaced';
  };
  assert.equal(await assetService.replaceAsset('production-asset', 'scene-asset', {}), 'asset-replaced');
  assert.equal(assetUnlockedCalled, true, 'asset replacement enters through the shared production lease');

  const assetLeaseLost = new SceneRepairService({}, {});
  await assert.rejects(
    assetLeaseLost.replaceAssetUnlocked('production-asset', 'scene-asset', {}, async () => {
      throw Object.assign(new Error('asset lease lost'), { code: 'SCENE_EDIT_LEASE_LOST' });
    }),
    error => error.code === 'SCENE_EDIT_LEASE_LOST'
  );

  const uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-asset-lease-'));
  try {
    const uploadService = new SceneRepairService({}, {}, { dataRoot: uploadRoot });
    uploadService.getEditableBundle = async (_id, assertLease) => {
      assert.equal(typeof assertLease, 'function', 'asset replacement manifest initialization must receive the active lease');
      await assertLease();
      return editableBundle();
    };
    let uploadAssertions = 0;
    await assert.rejects(
      uploadService.replaceAssetUnlocked('production-1', 'scene-1', {
        buffer: Buffer.from('replacement bytes'),
        contentType: 'image/png',
        filename: 'replacement.png',
        rightsConfirmed: true
      }, async () => {
        uploadAssertions += 1;
        if (uploadAssertions === 5) {
          throw Object.assign(new Error('lease lost after upload write'), { code: 'SCENE_EDIT_LEASE_LOST' });
        }
      }),
      error => error.code === 'SCENE_EDIT_LEASE_LOST'
    );
    const uploadDirectory = path.join(uploadRoot, 'scene-assets', 'production-1');
    assert.deepEqual(await fs.readdir(uploadDirectory), [], 'lease loss must remove the uploaded temporary asset');
  } finally {
    await fs.rm(uploadRoot, { recursive: true, force: true });
  }


  // Nested provider work must receive the same production lease assertion.
  const nestedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-nested-lease-'));
  try {
    const nestedBundle = editableBundle();
    nestedBundle.scenes[0].narrationStatus = 'stale';
    let visualLeasePassed = false;
    let narrationLeasePassed = false;
    const nestedDb = {
      acquireProductionOperationLock: async () => true,
      renewProductionOperationLock: async () => true,
      releaseProductionOperationLock: async () => true,
      updateProductionScene: async (_productionId, _sceneId, changes) => ({ ...nestedBundle.scenes[0], ...changes }),
      saveProductionSceneRevision: async () => true
    };
    const nestedService = new SceneRepairService(nestedDb, {}, { dataRoot: nestedRoot });
    nestedService.getEditableBundle = async (_id, assertLease) => {
      assert.equal(typeof assertLease, 'function', 'bundle initialization must receive the active lease');
      await assertLease();
      return nestedBundle;
    };
    nestedService.regenerationEstimateUnlocked = async (_id, _sceneId, _input, assertLease) => {
      assert.equal(typeof assertLease, 'function', 'regeneration estimate must receive the active lease');
      await assertLease();
      return { paid: false, provider: 'image-provider', generatedSeconds: 0 };
    };
    nestedService.isUsableSceneAsset = async () => true;
    nestedService.narrationDuration = async () => 8;
    nestedService.videoGenerator = {
      lastNarrationResult: { provider: 'test-tts', model: 'test-model' },
      async generateVisualAssets(_prompt, _style, _count, assertLease) {
        assert.equal(typeof assertLease, 'function', 'visual regeneration must pass the lease into image generation');
        visualLeasePassed = true;
        await assertLease();
        return [path.join(nestedRoot, 'replacement.png')];
      },
      async generateTTSAudio(_text, outputPath, options = {}) {
        assert.equal(typeof options.assertLease, 'function', 'narration regeneration must pass the lease into TTS');
        narrationLeasePassed = true;
        await options.assertLease();
        await fs.writeFile(outputPath, 'test narration');
        return outputPath;
      },
      async isUsableAudioFile() { return true; }
    };
    await nestedService.regenerateUnlocked('production-1', 'scene-1', { regenerateNarration: true }, async () => {});
    assert.equal(visualLeasePassed, true);
    assert.equal(narrationLeasePassed, true);
  } finally {
    await fs.rm(nestedRoot, { recursive: true, force: true });
  }

  // The public estimate endpoint can initialize a missing manifest, so it must
  // execute under the same production-operation lock as other scene changes.
  let estimateLockAcquired = false;
  let estimateLockReleased = false;
  const estimateService = new SceneRepairService({
    acquireProductionOperationLock: async () => { estimateLockAcquired = true; return true; },
    renewProductionOperationLock: async () => true,
    releaseProductionOperationLock: async () => { estimateLockReleased = true; }
  }, {});
  estimateService.getEditableBundle = async (_id, assertLease) => {
    assert.equal(typeof assertLease, 'function');
    await assertLease();
    return editableBundle();
  };
  estimateService.mediaGeneration = {
    settings: async () => ({ provider: 'slideshow', order: [], clipDuration: 8 }),
    registry: { select: () => null }
  };
  const estimate = await estimateService.regenerationEstimate('production-1', 'scene-1');
  assert.equal(estimate.paid, false);
  assert.equal(estimateLockAcquired, true, 'estimate must acquire a production lease before manifest initialization');
  assert.equal(estimateLockReleased, true, 'estimate must release its production lease');

  console.log('Scene edit lease regression tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
