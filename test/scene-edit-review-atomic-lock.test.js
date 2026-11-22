const assert = require('node:assert/strict');
const { YouTubeAutomationAgent } = require('../index');

async function run() {
  const agent = Object.create(YouTubeAutomationAgent.prototype);
  const events = [];
  let lockActive = false;
  let lockAcquisitions = 0;

  agent.scenes = {
    async withProductionOperationLease(productionId, operation, label) {
      assert.equal(productionId, 'production-1');
      assert.equal(lockActive, false, 'a second production lock must not be nested');
      lockActive = true;
      lockAcquisitions += 1;
      events.push(`lock:${label}`);
      try {
        return await operation(async () => {
          assert.equal(lockActive, true, 'lease assertion must run while lock is held');
        });
      } finally {
        lockActive = false;
        events.push('released');
      }
    }
  };

  agent.refreshContentReviewUnlocked = async (productionId, notes, assertLease) => {
    assert.equal(productionId, 'production-1');
    assert.equal(notes, 'Scene changes require review');
    await assertLease();
    assert.equal(lockActive, true, 'review invalidation must happen before releasing the edit lock');
    events.push('review-invalidated');
  };

  const result = await agent.runSceneEditWithReview(
    'production-1',
    async assertLease => {
      await assertLease();
      assert.equal(lockActive, true, 'scene edit must run while lock is held');
      events.push('scene-edited');
      return { sceneId: 'scene-1' };
    },
    'Scene changes require review',
    'scene edit and review invalidation'
  );

  assert.deepEqual(result, { sceneId: 'scene-1' });
  assert.equal(lockAcquisitions, 1, 'edit and review invalidation must share exactly one lease');
  assert.deepEqual(events, [
    'lock:scene edit and review invalidation',
    'scene-edited',
    'review-invalidated',
    'released'
  ]);
  assert.equal(lockActive, false);

  let reviewCalled = false;
  await assert.rejects(() => agent.runSceneEditWithReview(
    'production-1',
    async () => { throw new Error('edit failed'); },
    'Scene changes require review'
  ), /edit failed/);
  assert.equal(reviewCalled, false, 'review invalidation must not run after a failed edit');
  console.log('Scene edit and review invalidation lease tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
