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
  let savedReviews = 0;
  const qualityStarted = deferred();
  const allowQualityToFinish = deferred();
  const db = {
    acquireProductionOperationLock: async (_productionId, owner) => {
      if (lockOwner) return false;
      lockOwner = owner;
      return true;
    },
    releaseProductionOperationLock: async (_productionId, owner) => {
      assert.equal(lockOwner, owner, 'only the current review lease owner can release the lock');
      lockOwner = null;
    },
    getProductionBundle: async productionId => ({
      id: productionId,
      script: { title: 'Review lock test' },
      scenes: [{ id: 'scene-1', revision: 2 }],
      editorData: {}
    }),
    getChannelProfile: async () => ({}),
    saveContentReview: async () => {
      savedReviews += 1;
      return { reviewStatus: 'needs_review' };
    }
  };
  const agent = Object.create(YouTubeAutomationAgent.prototype);
  agent.db = db;
  agent.scenes = new SceneRepairService(db, {}, { dataRoot: '/tmp' });
  agent.operator = {
    runQualityChecks: async () => {
      qualityStarted.resolve();
      await allowQualityToFinish.promise;
      return { passed: true, checks: [], blockingFailures: [] };
    }
  };

  const firstRefresh = agent.refreshContentReview('review-lock-production', 'scene changed');
  await qualityStarted.promise;

  await assert.rejects(
    agent.refreshContentReview('review-lock-production', 'another scene change'),
    error => error.code === 'SCENE_EDIT_IN_PROGRESS' && error.status === 409
  );
  assert.equal(savedReviews, 0, 'a competing review refresh cannot save while the first quality check is using the lock');

  allowQualityToFinish.resolve();
  const result = await firstRefresh;
  assert.equal(result.reviewStatus, 'needs_review');
  assert.equal(savedReviews, 1, 'the review is saved once while holding the shared production lock');
  assert.equal(lockOwner, null, 'the review refresh releases its owned lock');
  process.stdout.write('Content review lock tests passed\\n');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
