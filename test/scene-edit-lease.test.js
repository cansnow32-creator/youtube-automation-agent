const assert = require('node:assert/strict');
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

  console.log('Scene edit lease regression tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
