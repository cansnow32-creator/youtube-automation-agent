const assert = require('node:assert/strict');
const { ContentStrategyAgent } = require('../agents/content-strategy-agent');

function snapshot(videoId, pillar, format, durationBucket, score, views, window = '7d') {
  return {
    videoId,
    measurementWindow: window,
    measuredAt: window === '7d' ? '2026-11-19T00:00:00.000Z' : '2026-11-18T00:00:00.000Z',
    contentAttributes: { pillar, format, durationBucket },
    metrics: { views, performanceScore: score, ctr: 5, retention: 45, engagementRate: 3 },
    simulated: false
  };
}

function makeSnapshots() {
  const rows = [];
  for (let index = 1; index <= 3; index++) {
    rows.push(snapshot(`edu-${index}`, 'Education', 'tutorial', '3_to_8m', 90 + index, 1000 + index * 100));
    rows.push(snapshot(`news-${index}`, 'News', 'review', '8_to_15m', 60 + index, 500 + index * 50));
  }
  // A second window for one video must not increase the independent sample count.
  rows.push(snapshot('edu-1', 'Education', 'tutorial', '3_to_8m', 10, 5, '24h'));
  return rows;
}

function strategy() {
  return {
    objective: 'Publish useful educational videos',
    audience: 'People learning practical skills',
    value_proposition: 'Clear, actionable explanations',
    contentPillars: ['Education', 'News', 'Other'],
    default_format: 'explainer',
    default_length: 'medium',
    videos_per_run: 3,
    primary_kpi: 'views'
  };
}

function makeAgent(rows, recommendations = [], ideas = []) {
  const calls = { snapshotOptions: null, recommendationOptions: null, promptResearch: null };
  const db = {
    listPerformanceSnapshots: async options => {
      calls.snapshotOptions = options;
      return rows;
    },
    listLearningRecommendations: async options => {
      calls.recommendationOptions = options;
      return recommendations;
    },
    getAllRows: async () => [],
    listContentIdeas: async () => ideas
  };
  const agent = new ContentStrategyAgent(db, {});
  agent.analyzeTrends = async () => {
    agent.trendingTopics = [];
    agent.competitorData = [];
  };
  agent.generateAutonomousPlanWithAI = async (_channelStrategy, research, count) => {
    calls.promptResearch = research;
    return [
      { topic: 'News review', pillar: 'News', format: 'review', length: 'long', rationale: 'Candidate from the weaker cohort.' },
      { topic: 'Neutral story', pillar: 'Other', format: 'story', length: 'short', rationale: 'Candidate without a measured cohort.' },
      { topic: 'Education tutorial', pillar: 'Education', format: 'tutorial', length: 'medium', rationale: 'Candidate matching the stronger cohort.' }
    ].slice(0, count);
  };
  return { agent, calls };
}

async function run() {
  const approved = [
    { category: 'format', title: 'Use tutorials', rationale: 'Approved by the operator.', confidence: 'high', proposedChange: 'Prefer tutorials' }
  ];
  const { agent, calls } = makeAgent(makeSnapshots(), approved);
  const result = await agent.researchAndPlanChannel(strategy());

  assert.deepEqual(calls.snapshotOptions, { reliableOnly: true },
    'planning must request reliable, non-simulated performance data');
  assert.deepEqual(calls.recommendationOptions, { status: 'approved', limit: 10 },
    'only operator-approved recommendations may enter the planning prompt');
  assert.equal(result.research.performanceGuidance.status, 'evidence_backed');
  assert.equal(result.research.performanceGuidance.independentVideoCount, 6,
    'duplicate measurement windows must not inflate independent video count');
  assert.ok(result.research.sources.includes('Evidence-backed performance cohort comparisons'));
  assert.equal(result.research.approvedLearnings.length, 1);
  assert.equal(result.plan[0].topic, 'Education tutorial',
    'the evidence-backed winning cohort should rank first in the actual planning flow');
  assert.equal(result.plan[1].topic, 'Neutral story',
    'neutral candidates should retain priority over clearly weaker cohorts');
  assert.equal(result.plan[2].topic, 'News review',
    'weaker cohorts should be deprioritized, never removed');
  assert.match(result.plan[0].rationale, /Performance evidence \(advisory\):/);
  assert.equal(calls.promptResearch.performanceGuidance.status, 'evidence_backed',
    'the same evidence guidance must be passed into AI plan generation');


  const backlogIdeas = [
    { topic: 'News backlog idea', angle: 'Review angle', style: 'review', status: 'backlog',
      rationale: JSON.stringify({ source: 'weekly_trend_snapshot', score: 92, pillar: 'News', explanation: 'Strong trend signal.' }) },
    { topic: 'Neutral backlog idea', angle: 'Story angle', style: 'story', status: 'backlog',
      rationale: JSON.stringify({ source: 'weekly_trend_snapshot', score: 85, pillar: 'Other', explanation: 'Broad audience fit.' }) },
    { topic: 'Education backlog idea', angle: 'Tutorial angle', style: 'tutorial', status: 'backlog',
      rationale: JSON.stringify({ source: 'weekly_trend_snapshot', score: 80, pillar: 'Education', explanation: 'Useful learning topic.' }) }
  ];
  const backlog = makeAgent(makeSnapshots(), [], backlogIdeas);
  const backlogResult = await backlog.agent.researchAndPlanChannel(strategy());
  assert.equal(backlog.calls.promptResearch, null,
    'a full scored backlog should not trigger unnecessary AI plan generation');
  assert.deepEqual(backlogResult.plan.map(item => item.topic),
    ['Education backlog idea', 'Neutral backlog idea', 'News backlog idea'],
    'performance evidence must re-rank scored backlog ideas too, without discarding them');
  assert.equal(backlogResult.research.prioritizedBacklogIdeas.length, 3,
    'the original trend-scored backlog evidence must remain visible after re-ranking');

  const sparseRows = [
    snapshot('edu-1', 'Education', 'tutorial', '3_to_8m', 90, 1000),
    snapshot('edu-2', 'Education', 'tutorial', '3_to_8m', 88, 950),
    snapshot('news-1', 'News', 'review', '8_to_15m', 60, 500),
    snapshot('news-2', 'News', 'review', '8_to_15m', 62, 520)
  ];
  const sparse = makeAgent(sparseRows);
  const sparseResult = await sparse.agent.researchAndPlanChannel(strategy());
  assert.equal(sparseResult.research.performanceGuidance.status, 'insufficient_evidence');
  assert.deepEqual(sparseResult.research.performanceGuidance.preferences, []);
  assert.deepEqual(sparseResult.plan.map(item => item.topic),
    ['News review', 'Neutral story', 'Education tutorial'],
    'insufficient samples must leave the AI plan order unchanged');
  assert.ok(!sparseResult.research.sources.includes('Evidence-backed performance cohort comparisons'));

  process.stdout.write('Performance plan integration tests passed\\n');
}

run().catch(error => {
  process.stderr.write(`Performance plan integration tests failed: ${error.stack || error.message}\\n`);
  process.exitCode = 1;
});
