const assert = require('node:assert/strict');
const { YouTubeAutomationAgent } = require('../index');

const recommendation = {
  id: 'approved-packaging-1',
  status: 'approved',
  category: 'packaging',
  title: 'Test new title and thumbnail packaging',
  rationale: 'Recent channel CTR supports a controlled packaging test.',
  confidence: 'medium',
  evidence: { metric: 'ctr', average: 3.2, sampleSize: 6, freshness: { status: 'fresh', sampleCount: 6, maxAgeDays: 90, oldestMeasuredAt: '2026-11-01T00:00:00.000Z', latestMeasuredAt: '2026-11-19T00:00:00.000Z' } },
  proposedChange: { target: 'review', experiment: 'title_thumbnail_variant' }
};

async function run() {
  const agent = Object.create(YouTubeAutomationAgent.prototype);
  let generatedFrom = null;
  agent.db = {
    listLearningRecommendations: async ({ status, limit }) => {
      assert.equal(status, 'approved');
      assert.equal(limit, 25);
      return [recommendation];
    }
  };
  agent.logger = { warn: message => { throw new Error(message); } };
  agent.agents = {
    thumbnailDesigner: {
      generateABVariants: async concept => {
        generatedFrom = concept;
        return [
          { label: 'Color contrast', path: '/tmp/contrast.jpg', concept: { pattern: 'contrast' } },
          { label: 'Alternate promise', path: '/tmp/promise.jpg', concept: { pattern: 'promise' } },
          { label: 'Centered composition', path: '/tmp/centered.jpg', concept: { pattern: 'centered' } }
        ];
      }
    }
  };

  const baselineConcept = { style: 'clean', primaryText: 'BETTER HABITS' };
  const result = await agent.preparePackagingExperiment(
    { concept: baselineConcept },
    { assets: { thumbnail: { path: '/tmp/control.jpg' } } },
    { title: 'A practical guide to better habits' },
    { title: 'Original script title' }
  );

  assert.equal(generatedFrom, baselineConcept);
  assert.equal(result.sourceRecommendationId, recommendation.id);
  assert.equal(result.learning.rationale, recommendation.rationale);
  assert.equal(result.titleVariants.length, 4);
  assert.equal(result.thumbnailVariants.length, 4);
  assert.equal(result.titleVariants[0].label, 'Control');
  assert.equal(result.thumbnailVariants[0].label, 'Control');
  assert.equal(result.titleVariants[1].label, 'Step-by-step + Color contrast');
  assert.equal(result.thumbnailVariants[1].label, 'Color contrast');
  assert.equal(result.titleVariants[2].label, 'Curiosity + Alternate promise');
  assert.equal(result.thumbnailVariants[2].label, 'Alternate promise');
  assert.equal(result.titleVariants[3].label, 'Benefit + Centered composition');
  assert.equal(result.thumbnailVariants[3].label, 'Centered composition');

  agent.db.listLearningRecommendations = async () => [];
  assert.equal(await agent.preparePackagingExperiment(
    { concept: baselineConcept },
    { assets: { thumbnail: { path: '/tmp/control.jpg' } } },
    { title: 'Another title' },
    { title: 'Another script' }
  ), null);

  process.stdout.write('Packaging experiment pipeline tests passed\\n');
}

run().catch(error => {
  process.stderr.write(`Packaging experiment pipeline tests failed: ${error.stack || error.message}\\n`);
  process.exitCode = 1;
});
