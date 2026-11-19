const assert = require('assert');
const { YouTubeAutomationAgent } = require('../index');

async function run() {
  const agent = Object.create(YouTubeAutomationAgent.prototype);
  const learning = {
    recommendationId: 'approved-packaging-orchestration',
    title: 'Use evidence-backed curiosity',
    rationale: 'A measured improvement in click-through rate.',
    confidence: 'high',
    winningTitle: 'The Hidden Cost of Fast Fashion',
    winningThumbnailPattern: 'Centered composition',
    evidence: { liftPercent: 18, zScore: 2.4 }
  };
  const recommendation = {
    id: learning.recommendationId,
    status: 'approved',
    category: 'packaging_experiment',
    title: learning.title,
    rationale: learning.rationale,
    confidence: learning.confidence,
    proposedChange: {
      target: 'future_packaging',
      experiment: 'validated_title_thumbnail_pattern',
      winningTitle: learning.winningTitle,
      winningThumbnailPattern: learning.winningThumbnailPattern
    },
    evidence: learning.evidence
  };

  let strategySeenByWriter;
  let learningSeenByThumbnail;
  let strategySeenBySeo;
  const approvedConceptRecord = {
    id: 'approved-packaging-concept',
    status: 'approved',
    concept: {
      name: 'Approved packaging concept',
      visualDirection: { style: 'clean explainer', palette: 'warm' },
      audioDirection: { narration: 'clear', pacing: 'measured' },
      subtitleDirection: { typography: 'clean sans', placement: 'lower safe area' },
      scenePlan: [{ scene: 1, purpose: 'Hook', visual: 'Opening' }, { scene: 2, purpose: 'Payoff', visual: 'Resolution' }]
    }
  };
  agent.logger = { info() {}, warn() {}, error() {} };
  agent.updateJobStage = async () => {};
  agent.runGenerationStage = async (_jobId, _stage, _progress, producer) => producer();
  agent.db = {
    getChannelProfile: async () => ({ target_audience: 'beginner gardeners' }),
    getVideoConcept: async id => id === approvedConceptRecord.id ? approvedConceptRecord : null,
    listLearningRecommendations: async () => [recommendation],
    saveProductionData: async () => 'content-orchestration-test',
    saveProductionSnapshot: async () => {},
    getSetting: async () => 'true',
    saveContentReview: async () => {},
    updateProductionStatus: async () => {}
  };
  agent.agents = {
    strategy: {
      generateContentStrategy: async topic => ({
        topic,
        contentType: 'Explainer',
        angle: 'A practical beginner approach',
        targetAudience: 'beginner gardeners',
        keywords: ['urban gardening']
      })
    },
    scriptWriter: {
      generateScript: async strategy => {
        strategySeenByWriter = strategy;
        return {
          title: 'Urban Gardening: A Practical Guide',
          metadata: { strategy: { contentType: 'Explainer' } }
        };
      }
    },
    thumbnailDesigner: {
      generateThumbnail: async (_script, packagingLearning) => {
        learningSeenByThumbnail = packagingLearning;
        return { concept: { title: 'Urban Gardening', composition: 'centered' } };
      },
      generateABVariants: async () => ([
        { label: 'Variant A', path: 'variant-a.png', concept: {} }
      ])
    },
    seoOptimizer: {
      optimize: async (_script, strategy) => {
        strategySeenBySeo = strategy;
        return { title: 'Urban Gardening: A Practical Guide' };
      }
    },
    production: {
      processContent: async () => ({
        status: 'draft',
        assets: { thumbnail: { path: 'thumbnail.png' } }
      })
    }
  };
  agent.provenance = { initialize: async () => ({ initialized: true }) };
  agent.discoverability = null;
  agent.operator = {
    runQualityChecks: async () => ({ passed: true, score: 95, checks: [], blockingFailures: [] }),
    notify: async () => {}
  };

  await agent.generateContent('Urban Gardening', null, 'medium', { strategyContext: { approvedVideoConceptId: approvedConceptRecord.id } });
  assert.strictEqual(strategySeenByWriter.packagingLearning.recommendationId, learning.recommendationId,
    'the approved learning should be attached to the strategy passed to script generation');
  assert.strictEqual(learningSeenByThumbnail.recommendationId, learning.recommendationId,
    'the approved learning should be passed to thumbnail generation');
  assert.strictEqual(strategySeenBySeo.packagingLearning.recommendationId, learning.recommendationId,
    'the same approved learning should be passed to SEO generation');

  console.log('Packaging learning orchestration test passed.');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
