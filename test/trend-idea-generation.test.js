const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Database } = require('../database/db');
const { ContentStrategyAgent } = require('../agents/content-strategy-agent');
const { scoreTrendIdeas, buildAudienceDemand, filterTrendIdeasForApproval } = require('../utils/trend-idea-ranker');
const { rankTemplatesForNiche } = require('../utils/viral-template-analyzer');

async function run() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trend-idea-generation-'));
  const db = new Database();
  db.dbPath = path.join(tempDir, 'test.db');
  await db.initialize();
  assert.equal(require('../utils/trend-idea-ranker').overlapScore('öğrenme alışkanlıkları', 'öğrenme alışkanlıkları geliştirme'), 67,
    'Turkish characters must remain valid tokens during niche matching');
  const qualityGate = filterTrendIdeasForApproval([
    { topic: 'Ancient Roman battle tactics explained', sourceTopic: 'AI editing', score: 81,
      scoreBreakdown: { channelFit: 4, trendEvidenceCount: 2 } },
    { topic: 'A practical AI editing workflow guide', sourceTopic: 'AI editing', score: 75,
      scoreBreakdown: { channelFit: 70, trendEvidenceCount: 2 } },
    { topic: 'A weakly supported editing idea', sourceTopic: 'AI editing', score: 32,
      scoreBreakdown: { channelFit: 60, trendEvidenceCount: 1 } },
    { topic: 'A fresh editing concept with no sources', sourceTopic: 'AI editing', score: 90,
      scoreBreakdown: { channelFit: 70, trendEvidenceCount: 0 } }
  ], ['A practical AI editing workflow'], {
    channelStrategy: { objective: 'Teach AI video editing', audience: 'beginner video creators', contentPillars: ['editing tutorials'] }
  });
  assert.equal(qualityGate.ideas.length, 0,
    'near-duplicates, off-audience, low-score and unsupported ideas must not enter the approval backlog');
  assert.deepEqual(qualityGate.rejected, {
    lowScore: 1, offAudience: 1, duplicate: 1, missingEvidence: 1, invalid: 0
  });

  const angleGate = filterTrendIdeasForApproval([
    { topic: 'A beginner guide to AI video editing', angle: 'Build a repeatable editing workflow from raw clips', pillar: 'editing', sourceTopic: 'AI editing', score: 70, scoreBreakdown: { channelFit: 65, trendEvidenceCount: 2 } },
    { topic: 'How to edit videos with AI tools', angle: 'Build a repeatable editing workflow from raw clips', pillar: 'editing', sourceTopic: 'AI editing', score: 72, scoreBreakdown: { channelFit: 65, trendEvidenceCount: 2 } },
    { topic: 'A lighting setup for home video creators', angle: 'Choose a simple desk lighting arrangement', pillar: 'production', sourceTopic: 'Lighting', score: 68, scoreBreakdown: { channelFit: 60, trendEvidenceCount: 1 } }
  ], [], {});
  assert.equal(angleGate.ideas.length, 2,
    'ideas with different titles but the same editorial angle should be deduplicated');
  assert.equal(angleGate.rejected.duplicate, 1);
  const savedAngleGate = filterTrendIdeasForApproval([
    { topic: 'A fresh title for editing beginners', angle: 'Build a repeatable editing workflow from raw clips', pillar: 'editing', sourceTopic: 'AI editing', score: 70, scoreBreakdown: { channelFit: 65, trendEvidenceCount: 2 } }
  ], [
    { topic: 'The existing editing workflow guide', angle: 'Build a repeatable editing workflow from raw clips', pillar: 'editing' }
  ]);
  assert.equal(savedAngleGate.ideas.length, 0,
    'new titles must be rejected when their editorial angle already exists in saved ideas');
  assert.equal(savedAngleGate.rejected.duplicate, 1);

  const profileFreeGate = filterTrendIdeasForApproval([
    { topic: 'A useful general editing explainer', sourceTopic: 'Editing', score: 55,
      scoreBreakdown: { channelFit: 0, trendEvidenceCount: 1 } }
  ], [], {});
  assert.equal(profileFreeGate.ideas.length, 1,
    'missing channel profile must not invent an audience mismatch');

  const keywordAgent = new ContentStrategyAgent(db, {});
  assert.deepEqual(keywordAgent.extractKeywords('İçerik üretimi ve yapay zekâ video araçları'), [
    'içerik', 'üretimi', 'yapay', 'zekâ', 'video', 'araçları'
  ], 'competitor niche keywords must preserve Turkish letters, including dotted capital İ');

  const deduplicatedTopics = keywordAgent.mergeTrendData([
    { videoId: 'duplicate-video', url: 'https://youtube.com/watch?v=duplicate-video', title: 'AI Editing Workflow', viewCount: 200000 },
    { videoId: 'duplicate-video', url: 'https://youtube.com/watch?v=duplicate-video', title: 'AI Editing Workflow', viewCount: 200000 },
    { videoId: 'unique-video', url: 'https://youtube.com/watch?v=unique-video', title: 'AI Editing Workflow', viewCount: 100000 }
  ], [
    { channelId: 'UC-one', topPerformingTopics: [
      { topic: 'Editing', avgViews: 200000, evidence: [{ url: 'https://youtube.com/watch?v=competitor-one' }] },
      { topic: ' editing ', avgViews: 200000, evidence: [{ url: 'https://youtube.com/watch?v=competitor-one' }] }
    ] },
    { channelId: 'UC-two', topPerformingTopics: [
      { topic: 'EDITING', avgViews: 100000, evidence: [{ url: 'https://youtube.com/watch?v=competitor-two' }] }
    ] }
  ]);
  const editingTopic = deduplicatedTopics.find(item => item.topic.toLowerCase() === 'editing');
  assert.ok(editingTopic, 'case and whitespace variants should merge into one topic');
  assert.equal(editingTopic.score, 3.3,
    'duplicate trending videos and duplicate same-channel topic rows must not inflate score, while distinct videos and channels still contribute');
  assert.deepEqual(editingTopic.sources.sort(), ['competitor', 'trending']);
  assert.equal(editingTopic.evidence.length, 4,
    'evidence URLs should remain unique across trending and competitor sources');
  const ideaIds = [];
  const snapshotIds = [];
  const originalFetch = global.fetch;
  const originalModel = process.env.OLLAMA_MODEL;
  const originalUrl = process.env.OLLAMA_BASE_URL;

  try {
    let competitorSearchOrder = null;
    const competitorAgent = new ContentStrategyAgent(db, {
      getYouTubeClient: () => ({
        search: { list: async params => {
          competitorSearchOrder = params.order;
          return { data: { items: [{ id: { videoId: 'top-video-1' } }] } };
        } },
        videos: { list: async () => ({ data: { items: [{
          id: 'top-video-1',
          snippet: { title: 'A proven niche video', channelTitle: 'Example channel', publishedAt: '2026-11-19T00:00:00Z' },
          statistics: { viewCount: '250000' }
        }] } }) }
      })
    });
    const competitorVideos = await competitorAgent.getChannelVideos('UC-example');
    assert.equal(competitorSearchOrder, 'viewCount',
      'competitor discovery should inspect the channel highest-view videos, not only newest uploads');
    assert.equal(competitorVideos[0].id, 'top-video-1');

    const originalCompetitorChannels = process.env.COMPETITOR_CHANNELS;
    try {
      process.env.COMPETITOR_CHANNELS = 'UC-good,UC-empty,UC-failed';
      competitorAgent.getChannelVideos = async channelId => {
        if (channelId === 'UC-empty') return [];
        if (channelId === 'UC-failed') throw new Error('simulated competitor outage');
        return [{
          id: 'usable-competitor-video',
          snippet: { title: '7 AI Editing Tips for Beginners', description: 'A practical tutorial' },
          statistics: { viewCount: '120000' }
        }];
      };
      const resilientCompetitors = await competitorAgent.analyzeCompetitors();
      assert.deepEqual(resilientCompetitors.map(item => item.channelId), ['UC-good'],
        'empty or failed competitor channels must be skipped without discarding usable channel analysis');
      assert.ok(resilientCompetitors[0].topPerformingTemplates.length > 0,
        'usable competitor template evidence should remain available when another channel fails');
    } finally {
      if (originalCompetitorChannels === undefined) delete process.env.COMPETITOR_CHANNELS;
      else process.env.COMPETITOR_CHANNELS = originalCompetitorChannels;
    }

    const { analyzeVideoTemplates } = require('../utils/viral-template-analyzer');
    const templateAnalysis = analyzeVideoTemplates([
      { id: 'template-list', snippet: { title: '7 Ways to Improve Your Workflow', description: 'A practical workflow' }, statistics: { viewCount: '90000' } },
      { id: 'template-list-2', snippet: { title: 'Top 5 Editing Mistakes', description: 'Avoid these mistakes' }, statistics: { viewCount: '110000' } },
      { id: 'template-question', snippet: { title: 'Why Does Editing Take So Long?', description: 'Explained simply' }, statistics: { viewCount: '50000' } }
    ]);
    assert.equal(templateAnalysis[0].patternId, 'numbered_list');
    assert.equal(templateAnalysis[0].sampleCount, 2);
    assert.equal(templateAnalysis[0].averageViews, 100000);
    assert.equal(templateAnalysis[0].relativeToChannelAverage, 1.2);
    assert.equal(templateAnalysis[0].evidence.length, 2);
    assert.ok(templateAnalysis.some(item => item.patternId === 'question'));

    const nicheRankedTemplates = rankTemplatesForNiche([
      {
        patternId: 'numbered_list',
        format: 'tutorial',
        averageViews: 100000,
        relativeToChannelAverage: 1,
        evidence: [{ title: 'AI video editing workflow for beginners' }]
      },
      {
        patternId: 'curiosity_reveal',
        format: 'story',
        averageViews: 300000,
        relativeToChannelAverage: 2,
        evidence: [{ title: 'The hidden history of ancient Rome' }]
      }
    ], {
      objective: 'Teach AI video editing',
      audience: 'beginner video creators',
      contentPillars: ['AI video tools', 'editing tutorials']
    });
    assert.equal(nicheRankedTemplates[0].patternId, 'numbered_list',
      'strong niche relevance should outrank a higher-view unrelated template');
    assert.ok(nicheRankedTemplates[0].nicheFitScore > nicheRankedTemplates[1].nicheFitScore);
    assert.equal(nicheRankedTemplates[0].rankingBasis, 'niche_fit_and_performance');
    const performanceOnlyTemplates = rankTemplatesForNiche([
      { averageViews: 100, relativeToChannelAverage: 1, evidence: [{ title: 'Generic video' }] },
      { averageViews: 200, relativeToChannelAverage: 2, evidence: [{ title: 'Another video' }] }
    ], {});
    assert.equal(performanceOnlyTemplates[0].rankingBasis, 'performance_only',
      'missing channel profile must preserve performance-only ranking without inventing niche fit');

    const snapshot = await db.saveTrendSnapshot({
      regionCode: 'US',
      topics: [{
        topic: 'AI video editing',
        score: 18,
        sources: ['trending', 'competitor'],
        evidence: [{ url: 'https://www.youtube.com/watch?v=trend-idea-test', title: 'AI video editing tools' }]
      }]
    });
    snapshotIds.push(snapshot.id);

    const ranked = scoreTrendIdeas([
      {
        sourceTopic: 'AI video editing',
        topic: 'AI video editing workflow for beginner creators',
        angle: 'A practical workflow',
        pillar: 'editing tutorials',
        format: 'tutorial'
      }
    ], snapshot.topics, {
      objective: 'Help video creators improve their workflow',
      audience: 'beginner video creators',
      contentPillars: ['AI video tools', 'editing tutorials']
    }, [{
      videoId: 'performance-video-1',
      measuredAt: '2026-11-18T12:00:00.000Z',
      simulated: false,
      contentAttributes: { topic: 'AI video editing', pillar: 'editing tutorials', format: 'tutorial' },
      metrics: { performanceScore: 86, ctr: 6, retention: 55 }
    }, {
      videoId: 'performance-video-1',
      measuredAt: '2026-11-17T12:00:00.000Z',
      simulated: false,
      contentAttributes: { topic: 'AI video editing', pillar: 'editing tutorials', format: 'tutorial' },
      metrics: { performanceScore: 10, ctr: 1, retention: 10 }
    }, {
      videoId: 'performance-video-2',
      measuredAt: '2026-11-18T12:00:00.000Z',
      simulated: false,
      contentAttributes: { topic: 'camera lighting basics', pillar: 'editing tutorials', format: 'tutorial' },
      metrics: { performanceScore: 80, ctr: 5, retention: 50 }
    }, {
      videoId: 'simulated-video',
      simulated: true,
      contentAttributes: { topic: 'AI video editing', pillar: 'editing tutorials', format: 'tutorial' },
      metrics: { performanceScore: 100, ctr: 10, retention: 100 }
    }]);
    assert.equal(ranked.length, 1);
    assert.ok(ranked[0].scoreBreakdown.viewerValue >= 70,
      'clear practical angles should receive a stronger viewer-value score');
    assert.equal(ranked[0].scoreBreakdown.productionFit, 100,
      'ideas matching the channel preferred format should receive full production-fit score');
    const { scoreProductionFit, scoreViewerValue } = require('../utils/trend-idea-ranker');
    assert.equal(scoreProductionFit({ format: 'story' }, { default_format: 'tutorial' }), 65);
    assert.equal(scoreProductionFit({ format: 'tutorial' }, {}), 75,
      'missing production preferences should remain neutral rather than invent constraints');
    const { scoreProductionEffort } = require('../utils/trend-idea-ranker');
    assert.ok(scoreProductionEffort({ topic: 'A simple beginner checklist' }) >
      scoreProductionEffort({ topic: 'A documentary investigation with interviews and original animation' }),
      'ideas with heavier research, interview and animation requirements should carry a higher effort penalty');
    assert.ok(scoreProductionEffort(
      { topic: 'A documentary investigation with interviews' },
      { productionCapabilities: ['research'] }
    ) < scoreProductionEffort(
      { topic: 'A documentary investigation with interviews' },
      {}
    ), 'explicitly missing production capabilities should reduce production fit');
    assert.equal(scoreProductionEffort({ topic: 'A general topic' }, {}), 90,
      'simple topics should not be penalized by missing capability metadata');
    const { scoreProductionRequirements } = require('../utils/trend-idea-ranker');
    const complexRequirements = scoreProductionRequirements({
      topic: 'A documentary investigation with interviews, original animation and archival footage'
    });
    assert.ok(complexRequirements.research < 90, 'research workload should be scored separately');
    assert.ok(complexRequirements.visuals < 90, 'visual asset and animation workload should be scored separately');
    assert.ok(complexRequirements.narration < 90, 'interview and narration workload should be scored separately');
    assert.ok(complexRequirements.editing < 90, 'complex editing workload should be scored separately');
    const { buildProductionPlan } = require('../utils/trend-idea-ranker');
    const productionPlan = buildProductionPlan(complexRequirements);
    assert.deepEqual(productionPlan.stages.map(stage => stage.key),
      ['research', 'visuals', 'narration', 'editing'],
      'production plan should provide a stable, actionable stage order');
    assert.ok(productionPlan.stages.every(stage =>
      ['low', 'medium', 'high'].includes(stage.effort) &&
      Number.isFinite(stage.readinessScore)),
    'each production stage should expose a bounded effort label and score');
    assert.ok(productionPlan.highestEffortStage,
      'production plan should identify the stage that needs the most attention');
    assert.ok(scoreProductionEffort({
      topic: 'A documentary investigation with interviews, original animation and archival footage'
    }) < scoreProductionEffort({ topic: 'A simple beginner checklist' }),
    'combined production effort should rank complex concepts as harder to produce');
    assert.ok(scoreViewerValue({ angle: 'Compare three editing workflows step by step', rationale: 'A practical checklist for beginners' }) >
      scoreViewerValue({ angle: 'A general look at editing', rationale: 'An overview' }),
      'specific, actionable angles should rank above vague descriptions');
    assert.ok(ranked[0].scoreBreakdown.viewerValue >= 70,
      'clear practical angles should receive a stronger viewer-value score');
    assert.equal(ranked[0].scoreBreakdown.productionFit, 100,
      'ideas matching the channel preferred format should receive full production-fit score');
    const { scoreProductionFit, scoreViewerValue } = require('../utils/trend-idea-ranker');
    assert.equal(scoreProductionFit({ format: 'story' }, { default_format: 'tutorial' }), 65);
    assert.equal(scoreProductionFit({ format: 'tutorial' }, {}), 75,
      'missing production preferences should remain neutral rather than invent constraints');
    assert.ok(scoreViewerValue({ angle: 'Compare three editing workflows step by step', rationale: 'A practical checklist for beginners' }) >
      scoreViewerValue({ angle: 'A general look at editing', rationale: 'An overview' }),
      'specific, actionable angles should rank above vague descriptions');
    assert.equal(ranked[0].scoreBreakdown.historicalSampleSize, 2,
      'multiple measurement windows for one video count as one independent sample');

    const evidenceRanked = scoreTrendIdeas([
      { sourceTopic: 'Low evidence trend', topic: 'Low evidence trend video idea', format: 'explainer' },
      { sourceTopic: 'Well supported trend', topic: 'Well supported trend video idea', format: 'explainer' }
    ], [
      { topic: 'Low evidence trend', score: 100, sources: ['trending'], evidence: [{ url: 'https://example.com/one' }] },
      { topic: 'Well supported trend', score: 60, sources: ['trending', 'competitor'], evidence: [
        { url: 'https://example.com/two' },
        { url: 'https://example.com/three' },
        { url: 'https://example.com/four' }
      ] }
    ], {}, [], []);
    const lowEvidence = evidenceRanked.find(item => item.sourceTopic === 'Low evidence trend');
    const wellSupported = evidenceRanked.find(item => item.sourceTopic === 'Well supported trend');
    assert.ok(wellSupported.score > lowEvidence.score,
      'a moderate trend with independent source and evidence support should outrank a high score backed by one item');
    assert.equal(lowEvidence.scoreBreakdown.trendSourceCount, 1);
    assert.equal(lowEvidence.scoreBreakdown.trendEvidenceCount, 1);
    assert.equal(lowEvidence.scoreBreakdown.trendEvidenceConfidence, 0.6);
    assert.equal(wellSupported.scoreBreakdown.trendEvidenceConfidence, 0.95);
    assert.equal(lowEvidence.scoreBreakdown.rawTrend, 100);
    assert.ok(lowEvidence.scoreBreakdown.trend < lowEvidence.scoreBreakdown.rawTrend,
      'weak evidence must pull the effective trend score toward neutral');
    assert.equal(ranked[0].scoreBreakdown.historicalConfidence, 0.5,
      'two independent videos receive a 50% confidence weight');
    assert.equal(ranked[0].scoreBreakdown.historicalPillarMatches, 2,
      'successful videos in the same content pillar can inform new ideas');
    assert.ok(ranked[0].scoreBreakdown.historicalPerformance < ranked[0].scoreBreakdown.historicalRawPerformance,
      'small samples are pulled toward a neutral score');

    const audienceDemand = buildAudienceDemand([
      {
        videoId: 'audience-video-1',
        analysisMethod: 'ai',
        themes: [
          { kind: 'request', title: 'AI video editing tutorials', count: 12, summary: 'Show a beginner workflow' },
          { kind: 'question', title: 'AI video editing tools', count: 4, summary: 'Compare tools' },
          { kind: 'praise', title: 'Great editing', count: 50, summary: 'Positive feedback only' }
        ]
      },
      {
        videoId: 'fallback-video',
        analysisMethod: 'fallback',
        themes: [{ kind: 'request', title: 'AI video editing', count: 40 }]
      }
    ]);
    assert.equal(audienceDemand.length, 2, 'only AI-analyzed request/question themes with at least three asks should count');
    const demandRanked = scoreTrendIdeas([
      { sourceTopic: 'AI video editing', topic: 'AI video editing workflow for beginner creators', format: 'tutorial' }
    ], snapshot.topics, {
      objective: 'Help video creators improve their workflow',
      audience: 'beginner video creators',
      contentPillars: ['AI video tools', 'editing tutorials']
    }, [], audienceDemand);
    assert.ok(demandRanked[0].scoreBreakdown.audienceDemand > 0);
    assert.equal(demandRanked[0].scoreBreakdown.audienceAskCount, 16);
    assert.equal(demandRanked[0].scoreBreakdown.weights.audienceDemand, 0.35);

    process.env.OLLAMA_MODEL = 'qwen3.5:4b';
    process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
    global.fetch = async (url, options) => {
      assert.match(url, /\/api\/chat$/);
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'qwen3.5:4b');
      assert.match(body.messages[0].content, /Niche-ranked competitor title\/format patterns/,
        'local idea generation should receive niche-ranked competitor format evidence');
      assert.match(body.messages[0].content, /numbered_list/,
        'competitor template guidance should include the ranked pattern metadata');
      assert.ok(body.messages[0].content.indexOf('numbered_list') < body.messages[0].content.indexOf('question'),
        'template guidance should be globally sorted by niche ranking across competitor channels');
      assert.doesNotMatch(body.messages[0].content, /unranked_noise/,
        'incomplete competitor records must not be presented as ranked evidence');
      assert.doesNotMatch(body.messages[0].content, /stale_noise|Old competitor pattern/,
        'stale competitor analysis must not be presented as current creative guidance');
      return {
        ok: true,
        json: async () => ({
          message: {
            content: JSON.stringify({
              ideas: [{
                sourceTopic: 'AI video editing',
                topic: 'A beginner workflow for AI video editing',
                angle: 'Build a repeatable editing workflow',
                pillar: 'editing tutorials',
                format: 'tutorial',
                rationale: 'Turns a verified trend into a practical tutorial'
              }]
            })
          }
        })
      };
    };

    const backlogIdea = await db.createContentIdea({
      topic: 'Beginner AI video editing workflow checklist',
      angle: 'Practical steps for beginners',
      style: 'tutorial',
      status: 'backlog',
      rationale: JSON.stringify({
        source: 'weekly_trend_snapshot',
        sourceTopic: 'AI video editing',
        pillar: 'editing tutorials',
        explanation: 'Existing saved idea to re-rank'
      })
    });
    ideaIds.push(backlogIdea.id);
    await db.savePerformanceSnapshot({
      videoId: 'backlog-ranking-performance-video',
      productionId: 'backlog-ranking-production',
      measurementWindow: '7d',
      publishedAt: '2026-11-10T00:00:00.000Z',
      metrics: { views: 1400, impressions: 12000, ctr: 6, retention: 55, performanceScore: 86 },
      contentAttributes: { topic: 'AI video editing', pillar: 'editing tutorials', format: 'tutorial', surface: 'long_form' },
      baseline: {},
      deltas: {},
      confidence: 'high',
      simulated: false
    });

    const strategy = new ContentStrategyAgent(db, {});
    const freshCompetitorAnalysisAt = new Date().toISOString();
    strategy.competitorData = [{
      channelId: 'UC-lower-ranked',
      analyzedAt: freshCompetitorAnalysisAt,
      topPerformingTemplates: [{
        patternId: 'question',
        format: 'explainer',
        sampleCount: 3,
        nicheFitScore: 35,
        rankingScore: 42,
        rankingBasis: 'niche_fit_and_performance',
        evidence: [{ title: 'Why does editing take so long?' }]
      }]
    }, {
      channelId: 'UC-higher-ranked',
      analyzedAt: freshCompetitorAnalysisAt,
      topPerformingTemplates: [{
        patternId: 'numbered_list',
        format: 'tutorial',
        sampleCount: 2,
        nicheFitScore: 82,
        rankingScore: 86,
        rankingBasis: 'niche_fit_and_performance',
        evidence: [{ title: '7 AI video editing steps for beginners' }]
      }]
    }, {
      channelId: 'UC-incomplete',
      analyzedAt: freshCompetitorAnalysisAt,
      topPerformingTemplates: [{
        patternId: 'unranked_noise',
        format: 'story',
        sampleCount: 4,
        evidence: [{ title: 'Incomplete ranking metadata' }]
      }]
    }, {
      channelId: 'UC-stale',
      analyzedAt: '2020-01-01T00:00:00.000Z',
      topPerformingTemplates: [{
        patternId: 'stale_noise',
        format: 'story',
        sampleCount: 99,
        rankingScore: 99,
        evidence: [{ title: 'Old competitor pattern must not be used' }]
      }]
    }];
    const result = await strategy.generateTrendIdeasFromSnapshot({ snapshot });
    assert.equal(result.status, 'success');
    assert.equal(result.createdCount, 1);
    assert.equal(result.rerankedBacklogCount, 1, 'existing backlog ideas should be rescored');
    const refreshedBacklog = (await db.listContentIdeas()).find(item => item.id === backlogIdea.id);
    const refreshedRationale = JSON.parse(refreshedBacklog.rationale);
    assert.equal(refreshedRationale.scoreBreakdown.historicalSampleSize, 1);
    assert.ok(refreshedRationale.rankingUpdatedAt);
    assert.equal(result.ideas[0].topic, 'A beginner workflow for AI video editing');

    strategy.analyzeTrends = async () => {};
    strategy.trendingTopics = snapshot.topics;
    strategy.competitorData = [];
    const autonomousPlan = await strategy.researchAndPlanChannel({
      videos_per_run: 1,
      objective: 'Help video creators improve their workflow',
      audience: 'beginner video creators',
      value_proposition: 'Practical editing education',
      contentPillars: ['editing tutorials'],
      default_format: 'tutorial',
      default_length: 'medium',
      primary_kpi: 'views'
    });
    assert.equal(autonomousPlan.plan[0].topic, backlogIdea.topic,
      'highest-scoring eligible backlog idea should be prioritized for production');
    assert.equal(autonomousPlan.research.prioritizedBacklogIdeas[0].topic, backlogIdea.topic);

    const savedIdeas = await db.listContentIdeas();
    const created = savedIdeas.find(item => item.topic === result.ideas[0].topic);
    assert.ok(created, 'generated idea should be persisted in the existing content ideas table');
    ideaIds.push(created.id);
    const rationale = JSON.parse(created.rationale);
    assert.equal(rationale.generatedBy, 'ollama');
    assert.equal(rationale.snapshotId, snapshot.id);
    assert.deepEqual(rationale.sourceTypes, ['trending', 'competitor'],
      'saved ideas must retain the verified source types of their originating trend topic');
    assert.ok(rationale.evidence.some(item => item.url === 'https://www.youtube.com/watch?v=trend-idea-test'),
      'saved ideas must retain source evidence links');
    assert.ok(rationale.scoreBreakdown);

    global.fetch = async () => { throw new Error('Ollama is offline'); };
    const skipped = await strategy.generateTrendIdeasFromSnapshot({ snapshot });
    assert.equal(skipped.status, 'skipped');
    assert.match(skipped.reason, /Ollama is offline/);
  } finally {
    global.fetch = originalFetch;
    if (originalModel === undefined) delete process.env.OLLAMA_MODEL;
    else process.env.OLLAMA_MODEL = originalModel;
    if (originalUrl === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = originalUrl;
    if (ideaIds.length) {
      await db.executeQuery(`DELETE FROM content_ideas WHERE id IN (${ideaIds.map(() => '?').join(',')})`, ideaIds);
    }
    await db.executeQuery(
      "DELETE FROM performance_snapshots WHERE video_id = 'backlog-ranking-performance-video'"
    );
    if (snapshotIds.length) {
      await db.executeQuery(`DELETE FROM trend_snapshots WHERE id IN (${snapshotIds.map(() => '?').join(',')})`, snapshotIds);
    }
    await db.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  process.stdout.write('Trend idea generation tests passed\\n');
}

run().catch(error => {
  process.stderr.write(`Trend idea generation tests failed: ${error.stack || error.message}\\n`);
  process.exitCode = 1;
});
