const assert = require('node:assert/strict');
const { ScriptWriterAgent } = require('../agents/script-writer-agent');
const { Database } = require('../database/db');

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

  let persistedReview = null;
  agent.db.saveScriptQualityReview = async review => {
    persistedReview = review;
    return { id: 'quality_review_test_1' };
  };
  const blockedError = Object.assign(new Error('Quality review did not pass'), {
    code: 'QUALITY_REVIEW_REQUIRED',
    draft: '{"title":"Rejected draft","sections":[]}',
    qualityReport: { status: 'human_review_required', score: 61, attempts: [] }
  });
  agent.qualityPipeline.generateAndReview = async () => { throw blockedError; };
  await assert.rejects(agent.generateScriptWithAI({
    topic: 'Rejected topic', jobId: 'job_test_1', contentType: 'Explainer', angle: 'Evidence first',
    targetAudience: 'general audience', keywords: [], researchSources: []
  }, { tone: 'informative', pacing: 'steady' }), error => {
    assert.equal(error.qualityReviewId, 'quality_review_test_1');
    assert.equal(error.code, 'QUALITY_REVIEW_REQUIRED');
    return true;
  });
  assert.equal(persistedReview.topic, 'Rejected topic');
  assert.equal(persistedReview.jobId, 'job_test_1');
  assert.equal(persistedReview.draft, blockedError.draft);
  assert.equal(persistedReview.qualityReport.score, 61);

  const database = new Database();
  let inserted = null;
  database.generateId = prefix => `${prefix}_fixed`;
  database.executeQuery = async (sql, params) => { inserted = { sql, params }; return { changes: 1 }; };
  database.getRow = async () => ({
    id: 'quality_review_fixed',
    status: 'pending',
    topic: 'Persisted topic',
    strategy: '{"topic":"Persisted topic"}',
    draft: '{"title":"Persisted draft"}',
    quality_report: '{"status":"human_review_required","score":55}'
  });
  const saved = await database.saveScriptQualityReview({
    topic: 'Persisted topic',
    jobId: 'job_persisted_1',
    strategy: { topic: 'Persisted topic' },
    draft: '{"title":"Persisted draft"}',
    qualityReport: { status: 'human_review_required', score: 55 }
  });
  assert.match(inserted.sql, /INSERT INTO script_quality_reviews/);
  assert.equal(inserted.params[0], 'quality_review_fixed');
  assert.equal(inserted.params[1], 'job_persisted_1');
  assert.equal(saved.id, 'quality_review_fixed');
  assert.equal(saved.quality_report.score, 55);
  assert.equal(inserted.params.length, 6);
  assert.match(inserted.sql, /job_id/);

  let listQuery = null;
  database.getAllRows = async (sql, params) => {
    listQuery = { sql, params };
    return [{
      id: 'quality_review_fixed', status: 'revision_requested',
      strategy: '{"topic":"Persisted topic"}', quality_report: '{"score":55}'
    }];
  };
  const pendingReviews = await database.listScriptQualityReviews('pending', 25);
  assert.match(listQuery.sql, /revision_requested/);
  assert.deepEqual(listQuery.params, ['pending', 'pending', 'pending', 25]);
  assert.equal(pendingReviews[0].quality_report.score, 55);

  const revised = await database.updateScriptQualityReviewDraft(
    'quality_review_fixed',
    '{"title":"Edited draft"}',
    { status: 'awaiting_human_approval', score: 88 }
  );
  assert.match(inserted.sql, /SET status = 'pending', draft = \?/);
  assert.deepEqual(inserted.params, [
    '{"title":"Edited draft"}',
    '{"status":"awaiting_human_approval","score":88}',
    'quality_review_fixed'
  ]);
  assert.equal(revised.id, 'quality_review_fixed');

  let linkedQuery = null;
  database.getRow = async (sql, params) => {
    linkedQuery = { sql, params };
    return null;
  };
  assert.equal(await database.getScriptQualityReviewByJobId('job_persisted_1'), null);
  assert.match(linkedQuery.sql, /WHERE job_id = \?/);
  assert.deepEqual(linkedQuery.params, ['job_persisted_1']);

  await database.decideScriptQualityReview('quality_review_fixed', 'human_approved', 'Reviewed manually');
  assert.match(inserted.sql, /SET status = \?, decision_notes = \?/);
  assert.deepEqual(inserted.params, ['human_approved', 'Reviewed manually', 'quality_review_fixed']);

  process.stdout.write('Script writer quality integration tests passed\\n');
}

run().catch(error => {
  process.stderr.write(`Script writer quality integration tests failed: ${error.stack || error.message}\\n`);
  process.exitCode = 1;
});
