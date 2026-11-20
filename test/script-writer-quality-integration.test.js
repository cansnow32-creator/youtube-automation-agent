const assert = require('node:assert/strict');
const { ScriptWriterAgent } = require('../agents/script-writer-agent');

async function run() {
  const agent = new ScriptWriterAgent({ saveScript: async () => 'script-id' }, {});
  agent.qualityPipeline.enabled = true;
  agent.qualityPipeline.ollamaModel = 'qwen3.5:4b';
  agent.qualityPipeline.lastReport = {
    status: 'approved', score: 90, minimumScore: 80, reviewers: ['ollama'],
    attempts: [{ revision: 0, score: 90 }]
  };
  const payload = {
    title: 'Evidence-led guide',
    hook: 'Here is the central question.',
    introduction: {
      greeting: 'Welcome.',
      topicIntro: 'Today we examine the topic.',
      valueProposition: 'You will learn the key evidence.',
      credibility: 'We will distinguish verified facts from interpretation.'
    },
    sections: [{ title: 'Evidence', content: ['A sourced point.'], duration: 60 }],
    conclusion: { recap: ['The evidence has limits.'], finalThought: 'Check the sources before deciding.' },
    cta: 'Read the cited sources.'
  };
  agent.qualityPipeline.generateAndReview = async () => JSON.stringify(payload);
  agent.generateIntroduction = async () => { throw new Error('Unreviewed template introduction must not be appended'); };
  agent.generateConclusion = async () => { throw new Error('Unreviewed template conclusion must not be appended'); };
  const script = await agent.generateScriptWithAI({
    topic: 'Evidence', contentType: 'Explainer', angle: 'A practical guide',
    targetAudience: 'general audience', keywords: [], researchSources: []
  }, { tone: 'informative', pacing: 'steady' });
  assert.equal(script.introduction.credibility, payload.introduction.credibility);
  assert.equal(script.conclusion.finalThought, payload.conclusion.finalThought);
  assert.equal(script.metadata.generationSource, 'ollama_local_first_quality_gated');
  assert.equal(script.metadata.qualityGate.status, 'approved');

  agent.qualityPipeline.generateAndReview = async () => JSON.stringify({
    title: 'Incomplete', hook: 'Hook', sections: [{ title: 'Body', content: ['Body'], duration: 30 }]
  });
  await assert.rejects(agent.generateScriptWithAI({
    topic: 'Evidence', contentType: 'Explainer', angle: 'Guide',
    targetAudience: 'general audience', keywords: [], researchSources: []
  }, { tone: 'informative', pacing: 'steady' }), /missing its introduction or conclusion/);

  process.stdout.write('Script writer quality integration tests passed\\n');
}

run().catch(error => {
  process.stderr.write(`Script writer quality integration tests failed: ${error.stack || error.message}\\n`);
  process.exitCode = 1;
});
