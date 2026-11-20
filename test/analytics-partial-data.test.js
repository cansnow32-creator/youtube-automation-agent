const assert = require('node:assert/strict');
const { AnalyticsOptimizationAgent } = require('../agents/analytics-optimization-agent');

async function run() {
  const agent = new AnalyticsOptimizationAgent({}, {});
  agent.logger = { warn() {}, error() {}, info() {} };

  // One failed optional endpoint must not discard valid views/watch-time data.
  agent.getViewsAnalytics = async () => ({
    totalViews: 300,
    totalImpressions: 10000,
    averageCTR: 9.2,
    dailyData: []
  });
  agent.getWatchTimeAnalytics = async () => {
    throw new Error('watch-time permission unavailable');
  };
  agent.getDemographicsAnalytics = async () => {
    throw new Error('demographics not available');
  };
  agent.getTrafficSourcesAnalytics = async () => ({ sources: [], topSource: 'unknown', organicPercentage: 0 });
  agent.getDeviceAnalytics = async () => {
    throw new Error('device report unavailable');
  };
  agent.getOutcomeAnalytics = async () => ({
    subscribersAvailable: false,
    subscribersGained: null,
    subscribersLost: null,
    netSubscribers: null,
    revenueAvailable: false,
    estimatedRevenue: null
  });
  agent.calculateEngagementMetrics = async () => {
    throw new Error('engagement statistics unavailable');
  };

  const partial = await agent.getVideoAnalytics('partial-video');
  assert.equal(partial.simulated, false, 'real data must remain real when optional endpoints fail');
  assert.equal(partial.views.totalViews, 300);
  assert.equal(partial.watchTime.averageViewPercentage, null);
  assert.equal(partial.demographics.primaryAudience, null, 'failed demographics must not be replaced by invented data');
  assert.equal(partial.dataQuality.source, 'youtube_api');
  assert.equal(partial.dataQuality.partial, true);
  assert.ok(partial.dataQuality.unavailable.watchTime);
  assert.ok(partial.dataQuality.unavailable.demographics);
  assert.ok(partial.dataQuality.unavailable.engagement);
  const score = agent.calculatePerformanceScore(partial);
  assert.ok(Number.isFinite(score.score), 'partial data must never create a NaN score');
  assert.equal(score.breakdown.retention, null);
  assert.equal(score.breakdown.engagement, null);

  // CTR must be weighted by impressions, not averaged equally by day.
  agent.youtubeAnalytics = {
    reports: {
      query: async () => ({
        data: {
          rows: [
            ['2026-11-18', 100, 1000, 2],
            ['2026-11-19', 200, 9000, 10]
          ]
        }
      })
    }
  };
  const views = await agent.getViewsAnalytics('weighted-ctr-video', '2026-11-18', '2026-11-19');
  assert.equal(views.totalViews, 300);
  assert.equal(views.totalImpressions, 10000);
  assert.equal(views.averageCTR, 9.2, 'CTR must be impression-weighted');

  // A single demographic dimension failure must preserve the other real dimension.
  agent.youtubeAnalytics = {
    reports: {
      query: async ({ dimensions }) => {
        if (dimensions === 'gender') throw new Error('gender breakdown unavailable');
        return { data: { rows: [['25-34', 62]] } };
      }
    }
  };
  const demographics = await agent.getDemographicsAnalytics('demographic-video', '2026-11-18', '2026-11-19');
  assert.deepEqual(demographics.ageGroups, [['25-34', 62]]);
  assert.deepEqual(demographics.gender, []);
  assert.equal(demographics.dataQuality.partial, true);
  assert.ok(demographics.dataQuality.unavailable.gender);

  // If every core metric endpoint fails, the fallback is explicit and ineligible for learning.
  for (const method of [
    'getViewsAnalytics',
    'getWatchTimeAnalytics',
    'getDemographicsAnalytics',
    'getTrafficSourcesAnalytics',
    'getDeviceAnalytics',
    'getOutcomeAnalytics',
    'calculateEngagementMetrics'
  ]) {
    agent[method] = async () => { throw new Error(`${method} failed`); };
  }
  agent.getSimulatedAnalytics = () => ({
    simulated: true,
    views: { totalViews: 0, totalImpressions: 0, averageCTR: null, dailyData: [] },
    watchTime: { averageViewPercentage: null },
    engagement: { engagementRate: null },
    trafficSources: { sources: [] },
    outcomes: {}
  });
  const fallback = await agent.getVideoAnalytics('unavailable-video');
  assert.equal(fallback.simulated, true);
  assert.equal(fallback.dataQuality.source, 'simulated_fallback');
  assert.equal(fallback.dataQuality.partial, false);
  assert.ok(fallback.dataQuality.unavailable.views);
  process.stdout.write('Partial YouTube analytics tests passed\\n');
}

run().catch(error => {
  process.stderr.write(`Partial YouTube analytics tests failed: ${error.stack || error.message}\\n`);
  process.exitCode = 1;
});
