const assert = require('assert');
const { ScriptWriterAgent } = require('../agents/script-writer-agent');
const { SEOOptimizerAgent } = require('../agents/seo-optimizer-agent');
const { ThumbnailDesignerAgent } = require('../agents/thumbnail-designer-agent');

async function run() {
  const learning = {
    recommendationId: 'approved-packaging-42',
    title: 'Use curiosity-led promises',
    rationale: 'This structure improved qualified click-through rate.',
    winningTitle: 'The Hidden Cost of Fast Fashion',
    winningThumbnailPattern: 'Centered composition',
    evidence: { liftPercent: 18, zScore: 2.4 }
  };

  let scriptPrompt = '';
  const writer = Object.create(ScriptWriterAgent.prototype);
  writer.logger = { info() {}, warn() {}, error() {} };
  writer.aiTextService = {
    providerName: 'test',
    isAvailable: () => true,
    generateText: async prompt => {
      scriptPrompt = prompt;
      return JSON.stringify({
        title: 'A New Topic Explained Clearly',
        hook: 'Here is the key question.',
        sections: [{ title: 'Context', content: ['Useful context.'], duration: 60 }],
        cta: 'Subscribe for more.',
        claims: []
      });
    }
  };
  writer.qualityPipeline = { enabled: false, lastReport: null };
  writer.generateIntroduction = async () => ({});
  writer.generateConclusion = async () => ({});
  const strategy = {
    topic: 'Urban Gardening',
    contentType: 'Explainer',
    angle: 'A practical beginner approach',
    targetAudience: 'new gardeners',
    keywords: ['urban gardening'],
    packagingLearning: learning,
    researchSources: []
  };
  const generated = await writer.generateScriptWithAI(strategy, { tone: 'informative', pacing: 'steady' });
  assert(generated, 'script generation should return a result');
  assert(scriptPrompt.includes('approved-packaging-42'), 'script prompt should include the approved recommendation');
  assert(scriptPrompt.includes('The Hidden Cost of Fast Fashion'), 'script prompt should include the proven title as guidance');
  assert(scriptPrompt.includes('never copy the winning title verbatim'), 'script prompt should prohibit copying the old title');
  assert(scriptPrompt.includes('never') && scriptPrompt.includes("override this video's topic"), 'script prompt should preserve the current topic');

  let seoPrompt = '';
  const seo = Object.create(SEOOptimizerAgent.prototype);
  seo.logger = { info() {}, warn() {}, error() {} };
  seo.aiTextService = {
    providerName: 'test',
    isAvailable: () => true,
    generateText: async prompt => {
      seoPrompt = prompt;
      return JSON.stringify({ title: 'Urban Gardening: A Practical Guide', description: 'A useful guide.', tags: ['urban gardening'] });
    }
  };
  seo.normalizeAITags = tags => tags;
  const seoResult = await seo.generateSEOWithAI({ title: 'Urban Gardening Basics' }, strategy);
  assert(seoResult, 'SEO generation should return a result');
  assert(seoPrompt.includes('approved-packaging-42'), 'SEO prompt should include the approved recommendation');
  assert(seoPrompt.includes('The Hidden Cost of Fast Fashion'), 'SEO prompt should include the proven title as guidance');
  assert(seoPrompt.includes('never copy the old title verbatim'), 'SEO prompt should prohibit copying the old title');
  assert(seoPrompt.includes("never let it override this video's topic"), 'SEO prompt should preserve the current topic');

  const thumbnail = Object.create(ThumbnailDesignerAgent.prototype);
  thumbnail.selectComposition = () => 'balanced';
  thumbnail.selectEffects = () => [];
  const centered = await thumbnail.generateConcept({
    title: 'Urban Gardening Basics',
    metadata: { strategy: { contentType: 'Explainer' } }
  }, learning);
  assert.strictEqual(centered.composition, 'centered', 'approved centered-composition learning should affect the next thumbnail concept');

  const contrast = await thumbnail.generateConcept({
    title: 'Urban Gardening Basics',
    metadata: { strategy: { contentType: 'Explainer' } }
  }, { ...learning, winningThumbnailPattern: 'Color contrast' });
  assert.strictEqual(contrast.colors.primary, 'yellow', 'approved color-contrast learning should swap the base palette');
  assert.strictEqual(contrast.colors.secondary, 'purple', 'approved color-contrast learning should swap the base palette');

  console.log('Packaging learning consumption tests passed.');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
