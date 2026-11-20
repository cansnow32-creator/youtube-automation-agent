const assert = require('node:assert/strict');
const { Database } = require('../database/db');
const { ContentStrategyAgent } = require('../agents/content-strategy-agent');
const { DailyAutomation } = require('../schedules/daily-automation');

async function run() {
  const db = new Database();
  await db.initialize();
  const createdIds = [];

  try {
    const saved = await db.saveTrendSnapshot({
      regionCode: 'US',
      topics: [{ topic: 'AI video editing', score: 12, sources: ['trending'], evidence: [] }],
      sourceCounts: { youtubeTrendingVideos: 10, competitorChannels: 2 }
    });
    createdIds.push(saved.id);

    const latest = await db.getLatestTrendSnapshot();
    assert.equal(latest.id, saved.id, 'latest trend snapshot should be retrievable');
    assert.equal(latest.regionCode, 'US');
    assert.equal(latest.topics[0].topic, 'AI video editing');
    assert.equal(latest.sourceCounts.competitorChannels, 2);

    const history = await db.getTrendSnapshots(2);
    assert.ok(history.some(item => item.id === saved.id), 'trend history should include saved snapshot');

    await assert.rejects(
      () => db.saveTrendSnapshot({ regionCode: 'US', topics: [] }),
      /requires at least one topic/,
      'empty trend snapshots must be rejected'
    );

    const strategy = new ContentStrategyAgent(db, {});
    strategy.fetchYouTubeTrends = async () => [{
      title: 'AI video editing tools',
      viewCount: 250000,
      url: 'https://www.youtube.com/watch?v=trend-test',
      publisher: 'Test source',
      publishedAt: new Date().toISOString()
    }];
    strategy.analyzeCompetitors = async () => [{
      channelId: 'test-channel',
      frequency: 3,
      topPerformingTopics: [{
        topic: 'AI video editing',
        avgViews: 50000,
        evidence: []
      }]
    }];

    // Isolate this assertion from snapshots left by earlier test runs.
    await db.executeQuery('DELETE FROM trend_snapshots');

    const staleSnapshot = await db.saveTrendSnapshot({
      regionCode: 'US',
      topics: [{ topic: 'Obsolete trend', score: 999, sources: ['trending'], evidence: [] }],
      capturedAt: '2020-01-01T00:00:00.000Z'
    });
    createdIds.push(staleSnapshot.id);

    const staleStrategy = new ContentStrategyAgent(db, {});
    staleStrategy.fetchYouTubeTrends = async () => [];
    staleStrategy.analyzeCompetitors = async () => [];
    await staleStrategy.analyzeTrends();
    assert.equal(staleStrategy.trendingTopics.length, 0,
      'stale snapshots must not be presented as current live trend topics');
    const staleIdeas = await staleStrategy.generateTrendIdeasFromSnapshot({ snapshot: staleSnapshot });
    assert.equal(staleIdeas.status, 'skipped',
      'idea generation must reject stale trend snapshots');
    assert.match(staleIdeas.reason, /stale/);

    const refreshed = await strategy.refreshTrendSnapshot();
    createdIds.push(refreshed.id);
    assert.ok(refreshed.topicCount > 0, 'weekly trend refresh should produce topics');
    assert.ok(refreshed.trendChanges.newTopics.length > 0, 'weekly refresh should identify newly emerging topics');
    assert.equal(refreshed.sourceCounts.youtubeTrendingVideos, 1);
    assert.equal(refreshed.sourceCounts.competitorChannels, 1);

    const events = [];
    const scheduler = new DailyAutomation({}, {
      executeQuery: async (query, params) => {
        events.push({ query, params });
        return { changes: 1 };
      }
    });
    scheduler.agents.strategy = {
      refreshTrendSnapshot: async () => ({ topicCount: 4, regionCode: 'US' })
    };
    const scheduledResult = await scheduler.refreshWeeklyTrends();
    assert.equal(scheduledResult.topicCount, 4);
    assert.ok(events.some(event => event.params?.[0] === 'weekly_trend_refresh'),
      'weekly scheduler should record the trend refresh event');
  } finally {
    if (createdIds.length) {
      await db.executeQuery(
        `DELETE FROM trend_snapshots WHERE id IN (${createdIds.map(() => '?').join(',')})`,
        createdIds
      );
    }
    await db.close();
  }

  process.stdout.write('Weekly trend snapshot tests passed\\n');
}

run().catch(error => {
  process.stderr.write(`Weekly trend snapshot tests failed: ${error.stack || error.message}\\n`);
  process.exitCode = 1;
});
