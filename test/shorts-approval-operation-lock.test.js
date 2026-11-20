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
  const approvalStarted = deferred();
  const allowApprovalToFinish = deferred();
  let approvalCalls = 0;
  let receivedLease = false;
  const db = {
    acquireProductionOperationLock: async (_productionId, owner) => {
      if (lockOwner) return false;
      lockOwner = owner;
      return true;
    },
    renewProductionOperationLock: async (_productionId, owner) => lockOwner === owner,
    releaseProductionOperationLock: async (_productionId, owner) => {
      assert.equal(lockOwner, owner);
      lockOwner = null;
    }
  };
  const agent = Object.create(YouTubeAutomationAgent.prototype);
  agent.db = db;
  agent.scenes = new SceneRepairService(db, {}, { dataRoot: '/tmp' });
  agent.shorts = {
    approve: async (productionId, clipId, input, options = {}) => {
      approvalCalls += 1;
      assert.equal(productionId, 'shorts-approval-production');
      assert.equal(clipId, 'short-1');
      assert.equal(input.confirmed, true);
      assert.equal(typeof options.assertLease, 'function');
      await options.assertLease();
      receivedLease = true;
      approvalStarted.resolve();
      await allowApprovalToFinish.promise;
      await options.assertLease();
      return { id: clipId, status: 'scheduled' };
    }
  };

  const firstApproval = agent.approveShortClip('shorts-approval-production', 'short-1', { confirmed: true });
  await approvalStarted.promise;
  await assert.rejects(
    agent.approveShortClip('shorts-approval-production', 'short-1', { confirmed: true }),
    error => error.code === 'SCENE_EDIT_IN_PROGRESS' && error.status === 409
  );
  assert.equal(approvalCalls, 1, 'a competing approval must not create another schedule');
  assert.notEqual(lockOwner, null, 'the production lock remains held during approval');
  allowApprovalToFinish.resolve();

  const result = await firstApproval;
  assert.equal(result.status, 'scheduled');
  assert.equal(receivedLease, true);
  assert.equal(lockOwner, null, 'the production lock is released after approval');

  const unavailable = Object.create(YouTubeAutomationAgent.prototype);
  unavailable.shorts = { approve: async () => assert.fail('approval must not run without a lock') };
  unavailable.scenes = new SceneRepairService({}, {}, { dataRoot: '/tmp' });
  await assert.rejects(
    unavailable.approveShortClip('shorts-approval-production', 'short-1', { confirmed: true }),
    error => error.code === 'SCENE_EDIT_LOCK_UNAVAILABLE' && error.status === 503
  );

  process.stdout.write('Shorts approval operation lock tests passed\\n');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
