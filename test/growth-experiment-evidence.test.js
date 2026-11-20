const assert = require('node:assert/strict');
const { GrowthExperimentService } = require('../utils/growth-experiment-service');

function makeService(samples) {
  const updates = [];
  const db = {
    listExperimentSamples: async () => samples,
    updateExperimentArm: async (id, patch) => updates.push({ id, patch })
  };
  const service = new GrowthExperimentService(db, {}, {});
  return { service, updates };
}

function experiment({ controlCtr = 8, variantCtr = 10, controlImpressions = 5000, variantImpressions = 5000 } = {}) {
  const makeArm = (id, ctr, impressions, isControl) => ({
    id, index: isControl ? 0 : 1, label: isControl ? 'Control' : 'Variant B', isControl,
    result: { impressions, clicks: Math.round(impressions * ctr / 100), ctr }
  });
  return {
    id: 'experiment-1',
    minImpressions: 1000,
    guardrails: { maximumRetentionDropPoints: 5, maximumTrafficSourceShiftPoints: 20 },
    arms: [
      makeArm('control', controlCtr, controlImpressions, true),
      makeArm('variant', variantCtr, variantImpressions, false)
    ]
  };
}

function samplesFor(test) {
  return test.arms.flatMap(arm => [
    { armId: arm.id, metrics: { impressions: arm.result.impressions, ctr: arm.result.ctr, clicks: arm.result.clicks }, trafficSources: [{ source: 'browse', percentage: 60 }] },
    { armId: arm.id, metrics: { impressions: arm.result.impressions, ctr: arm.result.ctr, clicks: arm.result.clicks }, trafficSources: [{ source: 'browse', percentage: 60 }] }
  ]);
}

async function run() {
  {
    const test = experiment({ variantImpressions: 999 });
    const { service } = makeService(samplesFor(test));
    const result = await service.evaluate(test);
    assert.equal(result.winnerArmId, null, 'sequential observations cannot establish a winner');
    assert.equal(result.comparisonMethod, 'sequential_same_video_observational');
    assert.equal(result.exposureAttribution, 'unavailable_from_youtube_analytics');
    assert.equal(result.eligibleArms, 1);
    assert.match(result.reason, /does not attribute impressions and clicks/i);
  }

  {
    const test = experiment({ controlCtr: 8, variantCtr: 8.1 });
    const { service } = makeService(samplesFor(test));
    const result = await service.evaluate(test);
    assert.equal(result.winnerArmId, null, 'even a small difference must remain observational');
    assert.equal(result.confidence, 'unverified');
    assert.equal(result.guardrails.passed, false);
    assert.equal(result.arms.find(arm => arm.armId === 'variant').observedCtr, 8.1);
  }

  {
    const test = experiment({ controlCtr: 8, variantCtr: 15 });
    const { service } = makeService(samplesFor(test));
    const result = await service.evaluate(test);
    assert.equal(result.winnerArmId, null, 'a large sequential CTR difference is not causal A/B evidence');
    assert.match(result.reason, /cannot establish an A\/B winner or causal lift/i);
  }

  {
    const test = experiment();
    test.status = 'awaiting_winner';
    test.winningArmId = 'variant';
    const { service } = makeService([]);
    service.requireExperiment = async () => test;
    let applied = false;
    service.applyArm = async () => { applied = true; };
    await assert.rejects(
      () => service.adoptWinner(test.id, { confirmed: false }),
      error => error.code === 'EXPERIMENT_CONFIRMATION_REQUIRED'
    );
    assert.equal(applied, false, 'winner adoption must require explicit confirmation');
  }

  {
    const test = experiment();
    test.status = 'awaiting_winner';
    test.winningArmId = 'variant';
    test.productionId = 'production-1';
    test.arms[1].title = 'A centered composition title';
    test.result = { liftPercent: 25, zScore: 2.4, confidence: 'high', guardrails: { passed: true } };
    const { service } = makeService([]);
    service.requireExperiment = async () => test;
    service.applyArm = async () => {};
    let savedRecommendation = null;
    service.db.getProductionBundle = async () => ({
      editorData: {
        packagingExperiment: {
          titleVariants: [
            { label: 'Control', title: 'Original title' },
            { label: 'Step-by-step + Color contrast', title: 'A step-by-step title' },
            { label: 'Curiosity + Alternate promise', title: 'A curiosity title' },
            { label: 'Benefit + Centered composition', title: 'A centered composition title' }
          ],
          thumbnailVariants: [
            { label: 'Control', path: '/tmp/control.jpg' },
            { label: 'Color contrast', path: '/tmp/contrast.jpg' },
            { label: 'Alternate promise', path: '/tmp/alternate.jpg' },
            { label: 'Centered composition', path: '/tmp/centered.jpg' }
          ]
        }
      }
    });
    service.db.saveLearningRecommendation = async recommendation => {
      savedRecommendation = recommendation;
      return { id: 'learning-2', ...recommendation };
    };
    service.db.reviewLearningRecommendation = async (id, status) => ({ id, status });
    service.db.updateGrowthExperiment = async (_id, changes) => ({ ...test, ...changes });
    const result = await service.adoptWinner(test.id, { confirmed: true });
    assert.equal(savedRecommendation.proposedChange.winningTitle, 'A centered composition title');
    assert.equal(savedRecommendation.proposedChange.winningThumbnailPattern, 'Centered composition');
    assert.equal(savedRecommendation.proposedChange.winningArmLabel, 'Variant B');
    assert.equal(result.status, 'adopted');
  }

  process.stdout.write('Growth experiment evidence tests passed\\n');
}

run().catch(error => {
  process.stderr.write(`Growth experiment evidence tests failed: ${error.stack || error.message}\\n`);
  process.exitCode = 1;
});
