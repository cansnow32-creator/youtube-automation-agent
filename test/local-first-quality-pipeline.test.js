const { LocalFirstQualityPipeline, platformMetadataIssues } = require('../utils/local-first-quality-pipeline');
const { SEOOptimizerAgent } = require('../agents/seo-optimizer-agent');

async function run() {
  const completeMetadata = {
    youtube: { title: 'YouTube title', description: 'YouTube description', hashtags: ['#youtube'], tags: ['youtube tag'] },
    instagram_reels: { caption: 'Reels caption', hashtags: ['#reels'] },
    tiktok: { caption: 'TikTok caption', hashtags: ['#tiktok'] }
  };
  if (platformMetadataIssues(completeMetadata).length !== 0) {
    throw new Error('Complete platform metadata must pass validation');
  }
  if (platformMetadataIssues({ youtube: {}, instagram_reels: {}, tiktok: {} }).length !== 8) {
    throw new Error('Missing platform metadata fields must be detected');
  }

  let savedSEO = null;
  const seoAgent = new SEOOptimizerAgent({
    getKeywordHistory: async () => [],
    saveSEOData: async value => { savedSEO = value; }
  }, {});
  const seoResult = await seoAgent.optimize({
    title: 'Original script title',
    mainContent: { sections: [] },
    metadata: { qualityGate: { platformMetadata: completeMetadata } }
  }, {
    topic: 'Testing',
    angle: 'A practical test',
    contentType: 'Explainer',
    targetAudience: 'developers',
    keywords: ['testing', 'automation']
  });
  if (seoResult.title !== 'YouTube title' || seoResult.description !== 'YouTube description') {
    throw new Error('Reviewed YouTube metadata was not used by SEO optimization');
  }
  if (!seoResult.metadata?.platformMetadata?.instagram_reels?.caption || !seoResult.metadata?.platformMetadata?.tiktok?.caption) {
    throw new Error('Reviewed Reels and TikTok metadata was not preserved');
  }
  if (savedSEO !== seoResult) {
    throw new Error('Platform metadata was not persisted with SEO data');
  }

  const pipeline = new LocalFirstQualityPipeline({}, { enabled: true, maxRevisions: 1 });
  let drafts = 0;
  let reviews = 0;
  pipeline.requestOllama = async () => (++drafts === 1 ? '{"title":"Draft"}' : '{"title":"Revised"}');
  pipeline.reviewDraft = async () => {
    reviews++;
    const score = reviews === 1 ? 76 : 91;
    const approved = score >= 80;
    const reviewer = () => ({ score, approved, blockers: [], findings: [], revision_instructions: approved ? [] : ['Strengthen the opening hook'] });
    return { gemini: reviewer(), groq: reviewer() };
  };
  pipeline.reviseDraft = async () => '{"title":"Revised"}';
  const result = await pipeline.generateAndReview('Write a script as JSON');
  if (!result.includes('Revised') || drafts !== 1 || reviews !== 2) {
    throw new Error('The pipeline did not revise and re-review exactly once');
  }
  if (pipeline.lastReport.status !== 'approved' || pipeline.lastReport.score !== 91 || pipeline.lastReport.revisions !== 1) {
    throw new Error('The successful quality report is incorrect');
  }

  const blocked = new LocalFirstQualityPipeline({}, { enabled: true, maxRevisions: 0 });
  blocked.requestOllama = async () => '{"title":"Below threshold"}';
  blocked.reviewDraft = async () => {
    const reviewer = () => ({ score: 79, approved: false, blockers: [], findings: ['Weak hook'], revision_instructions: ['Improve hook'] });
    return { gemini: reviewer(), groq: reviewer() };
  };
  let rejected = false;
  try { await blocked.generateAndReview('Write a script'); } catch (error) {
    rejected = /human review/i.test(error.message);
  }
  if (!rejected || blocked.lastReport.status !== 'human_review_required') {
    throw new Error('A draft below 80 was not held for human review');
  }

  const localOnly = new LocalFirstQualityPipeline({}, { enabled: true });
  let remoteCalls = 0;
  localOnly.requestOllama = async () => JSON.stringify({
    score: 88, approved: true, blockers: [], findings: [],
    revision_instructions: [], platform_metadata: completeMetadata
  });
  localOnly.requestGemini = async () => { remoteCalls++; throw new Error('Remote reviewer must remain disabled by default'); };
  localOnly.requestGroq = async () => { remoteCalls++; throw new Error('Remote reviewer must remain disabled by default'); };
  const localReview = await localOnly.reviewDraft('Local draft');
  if (!localReview.ollama || localReview.gemini || localReview.groq || remoteCalls !== 0) {
    throw new Error('Default quality review must use local Ollama only');
  }
  if (localOnly.allowRemoteReview !== false) throw new Error('Remote review must be opt-in');

  const localEndToEnd = new LocalFirstQualityPipeline({}, { enabled: true, maxRevisions: 0 });
  let localRequests = 0;
  localEndToEnd.requestOllama = async () => {
    localRequests++;
    if (localRequests === 1) return '{"title":"Local draft"}';
    return JSON.stringify({
      score: 89, approved: true, blockers: [], findings: [],
      revision_instructions: [], platform_metadata: completeMetadata
    });
  };
  localEndToEnd.requestGemini = async () => { throw new Error('Gemini must not be called'); };
  localEndToEnd.requestGroq = async () => { throw new Error('Groq must not be called'); };
  const localDraft = await localEndToEnd.generateAndReview('Write a complete script');
  if (localDraft !== '{"title":"Local draft"}' || localRequests !== 2) {
    throw new Error('Local generation and review did not complete through Ollama');
  }
  if (localEndToEnd.lastReport.status !== 'approved' ||
      localEndToEnd.lastReport.reviewers.join(',') !== 'ollama' ||
      localEndToEnd.lastReport.remoteReviewEnabled !== false) {
    throw new Error('Local-only quality report is incomplete or incorrectly identifies its reviewer');
  }

  const order = [];
  const ordered = new LocalFirstQualityPipeline({}, { enabled: true, allowRemoteReview: true });
  ordered.requestOllama = async () => {
    order.push('Ollama');
    return JSON.stringify({ score: 90, approved: true, blockers: [], revision_instructions: [], platform_metadata: completeMetadata });
  };
  ordered.requestGemini = async () => { order.push('Gemini'); return { score: 90, approved: true, blockers: [], revision_instructions: [], platform_metadata: completeMetadata }; };
  ordered.requestGroq = async () => { order.push('Groq'); return { score: 90, approved: true, blockers: [], revision_instructions: [], platform_metadata: completeMetadata }; };
  await ordered.reviewDraft('draft');
  if (order.join(',') !== 'Ollama,Gemini,Groq') throw new Error('Opt-in reviewers did not run in local-first order');

  console.log('Local-first quality pipeline tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
