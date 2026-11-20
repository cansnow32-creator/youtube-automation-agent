const assert = require('node:assert/strict');
const { YouTubeAutomationAgent } = require('../index');

async function run() {
  const agent = Object.create(YouTubeAutomationAgent.prototype);
  const review = {
    id: 'review_1',
    job_id: 'job_1',
    status: 'human_approved',
    decided_at: '2026-11-20 10:00:00',
    decision_notes: 'Reviewed and approved',
    topic: 'Evidence-led topic',
    strategy: { topic: 'Evidence-led topic', contentType: 'Explainer', keywords: [], researchSources: [] },
    draft: JSON.stringify({
      title: 'Approved saved script',
      hook: 'A clear opening hook.',
      introduction: { greeting: 'Welcome.', topicIntro: 'Today we explore this.', valueProposition: 'You will learn the evidence.', credibility: 'We separate facts from interpretation.' },
      sections: [{ title: 'The evidence', content: ['First supported point.'], duration: 60 }],
      conclusion: { recap: ['The key point.'], finalThought: 'Check the evidence.' },
      cta: 'Subscribe for more.'
    }),
    quality_report: { status: 'human_review_required', score: 62, minimumScore: 80, reviewers: ['ollama'], attempts: [{ revision: 1 }] }
  };
  let savedScript = null;
  let savedCheckpoint = null;
  let jobDetails = null;
  agent.activeJobs = new Map();
  agent.setupRequired = false;
  agent.agents = {
    strategy: {},
    scriptWriter: {
      parseAIJsonResponse: JSON.parse,
      normalizeAISections: sections => sections.map(section => ({ type: 'ai_generated', title: section.title, content: section.content, duration: section.duration })),
      normalizeAIHook: hook => ({ type: 'ai', text: hook, duration: '0:00-0:05' }),
      normalizeAIIntroduction: value => ({ ...value, duration: '0:05-0:20' }),
      normalizeAIConclusion: value => ({ ...value, duration: '30 seconds' }),
      normalizeAICTA: value => ({ subscribe: value, like: '', comment: '', nextVideo: '', duration: '15 seconds' }),
      normalizeAIClaims: () => [],
      calculateSectionsDuration: sections => sections.reduce((sum, section) => sum + section.duration, 0),
      estimateDuration: () => '1 minute',
      formatFullScript: script => 'TITLE: ' + script.title + '\\n' + script.mainContent.sections[0].content.join(' ') + ' supporting approved narration'.repeat(5)
    }
  };
  agent.db = {
    getScriptQualityReview: async () => review,
    getGenerationJob: async () => ({ id: 'job_1', status: 'failed', stage: 'script', details: { qualityReviewId: 'review_1' } }),
    getGenerationCheckpoint: async (_jobId, stage) => stage === 'strategy'
      ? { status: 'completed', artifact: { topic: 'Evidence-led topic', contentType: 'Explainer', keywords: [], researchSources: [] } }
      : null,
    saveScript: async script => { savedScript = script; return 'script_id'; },
    saveGenerationCheckpoint: async (_jobId, stage, changes) => { savedCheckpoint = { stage, ...changes }; },
    updateGenerationJob: async (_jobId, changes) => { jobDetails = changes.details; }
  };
  agent.resumeGenerationJob = async (_jobId, options) => ({ resumed: true, options });
  const result = await agent.continueApprovedScriptReview('review_1');
  assert.equal(result.resumed, true);
  assert.equal(result.options.forceHumanApproval, true);
  assert.equal(savedScript.title, 'Approved saved script');
  assert.equal(savedScript.metadata.generationSource, 'human_approved_saved_draft');
  assert.equal(savedScript.metadata.humanApproval.reviewId, 'review_1');
  assert.equal(savedCheckpoint.stage, 'script');
  assert.equal(savedCheckpoint.status, 'completed');
  assert.equal(savedCheckpoint.artifact.fullScript.includes('First supported point.'), true);
  assert.equal(jobDetails.approvedDraftReviewId, 'review_1');
  process.stdout.write('Approved script continuation tests passed\\n');
}

run().catch(error => {
  process.stderr.write(`Approved script continuation tests failed: ${error.stack || error.message}\\n`);
  process.exitCode = 1;
});
