const assert = require('node:assert/strict');
const { YouTubeAutomationAgent } = require('../index');
const { SceneRepairService } = require('../utils/scene-repair-service');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function main() {
  let lockOwner = null;
  const renderStarted = deferred();
  const allowRenderToFinish = deferred();
  let renderCalls = 0;
  let receivedLease = false;
  const db = {
    acquireProductionOperationLock: async (_productionId, owner) => {
      if (lockOwner) return false;
      lockOwner = owner;
      return true;
    },
    renewProductionOperationLock: async (_productionId, owner) => lockOwner === owner,
    releaseProductionOperationLock: async (_productionId, owner) => {
      assert.equal(lockOwner, owner, 'only the current Shorts render lease owner can release the lock');
      lockOwner = null;
    }
  };
  const agent = Object.create(YouTubeAutomationAgent.prototype);
  agent.db = db;
  agent.scenes = new SceneRepairService(db, {}, { dataRoot: '/tmp' });
  agent.shorts = {
    render: async (productionId, clipId, options = {}) => {
      renderCalls += 1;
      assert.equal(productionId, 'shorts-lock-production');
      assert.equal(clipId, 'short-1');
      assert.equal(typeof options.assertLease, 'function', 'the API caller must pass the lease assertion into the renderer');
      await options.assertLease();
      receivedLease = true;
      renderStarted.resolve();
      await allowRenderToFinish.promise;
      await options.assertLease();
      return { id: clipId, status: 'rendered' };
    }
  };

  const firstRender = agent.renderShortClip('shorts-lock-production', 'short-1');
  await renderStarted.promise;
  await assert.rejects(
    agent.renderShortClip('shorts-lock-production', 'short-1'),
    error => error.code === 'SCENE_EDIT_IN_PROGRESS' && error.status === 409
  );
  assert.equal(renderCalls, 1, 'a competing request must not start another render');
  assert.equal(lockOwner !== null, true, 'the production lock remains held while rendering');
  allowRenderToFinish.resolve();

  const result = await firstRender;
  assert.equal(result.status, 'rendered');
  assert.equal(receivedLease, true);
  assert.equal(lockOwner, null, 'the API caller releases its production lock after rendering');

  const unavailable = Object.create(YouTubeAutomationAgent.prototype);
  unavailable.shorts = { render: async () => assert.fail('render must not start without a lock') };
  unavailable.scenes = new SceneRepairService({}, {}, { dataRoot: '/tmp' });
  await assert.rejects(
    unavailable.renderShortClip('shorts-lock-production', 'short-1'),
    error => error.code === 'SCENE_EDIT_LOCK_UNAVAILABLE' && error.status === 503
  );

  process.stdout.write('Shorts render operation lock tests passed\\n');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
