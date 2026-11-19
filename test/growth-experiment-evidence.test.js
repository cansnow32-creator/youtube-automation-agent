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

function experiment({ controlCtr = 8, variantCtr = 10, controlRetention = 40, variantRetention = 38,
  controlImpressions = 5000, variantImpressions = 5000 } = {}) {
  const makeArm = (id, ctr, retention, impressions, isControl) => ({
    id, index: isControl ? 0 : 1, label: isControl ? 'Control' : 'Variant B', isControl,
    result: {
      impressions, clicks: Math.round(impressions * ctr / 100), ctr,
      averageViewPercentage: retention
    }
  });
  return {
    id: 'experiment-1',
    minImpressions: 1000,
    guardrails: { maximumRetentionDropPoints: 5, maximumTrafficSourceShiftPoints: 20 },
    arms: [
      makeArm('control', controlCtr, controlRetention, controlImpressions, true),
      makeArm('variant', variantCtr, variantRetention, variantImpressions, false)
    ]
  };
}

function samplesFor(test) {
  return test.arms.flatMap(arm => [
    { armId: arm.id, trafficSources: [{ source: 'browse', percentage: 60 }] },
    { armId: arm.id, trafficSources: [{ source: 'browse', percentage: 60 }] }
  ]);
}

async function run() {
  {
    const test = experiment({ variantImpressions: 999 });
    const { service } = makeService(samplesFor(test));
    const result = await service.evaluate(test);
    assert.equal(result.winnerArmId, null, 'an arm below minimum qualified impressions cannot win');
    assert.match(result.reason, /every arm must reach/i);
  }

  {
    const test = experiment({ controlCtr: 8, variantCtr: 8.1 });
    const { service } = makeService(samplesFor(test));
    const result = await service.evaluate(test);
    assert.equal(result.winnerArmId, null, 'a small CTR difference must not be called a winner');
    assert.match(result.reason, /95% evidence threshold/i);
  }

  {
    const test = experiment({ controlRetention: 45, variantRetention: 35 });
    const { service } = makeService(samplesFor(test));
    const result = await service.evaluate(test);
    assert.equal(result.winnerArmId, null, 'a retention guardrail regression blocks winner selection');
    assert.equal(result.guardrails.passed, false);
    assert.match(result.reason, /guardrail/i);
  }

  {
    const test = experiment();
    const { service } = makeService(samplesFor(test));
    const result = await service.evaluate(test);
    assert.equal(result.winnerArmId, 'variant');
    assert.equal(result.guardrails.passed, true);
    assert.ok(result.zScore >= 1.96, 'winner must clear the 95% evidence threshold');
    assert.equal(result.confidence, 'high');
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
    assert.equal(applied, false, 'winner adoption must not change live packaging without explicit confirmation');
  }

  {
    const test = experiment();
    test.status = 'awaiting_winner';
    test.winningArmId = 'variant';
    test.productionId = 'production-1';
    test.arms[1].title = 'A proven title pattern';
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
            { label: 'Step-by-step', title: 'A proven title pattern' }
          ],
          thumbnailVariants: [
            { label: 'Control', path: '/tmp/control.jpg' },
            { label: 'Centered composition', path: '/tmp/variant.jpg' }
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
    assert.equal(savedRecommendation.proposedChange.winningTitle, 'A proven title pattern');
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
