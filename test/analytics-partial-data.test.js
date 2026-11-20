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
  assert.equal(demographics.primaryAudience, 'Gender unavailable, 25-34',
    'an unavailable demographic dimension must not be replaced with a guessed default');
  assert.equal(agent.identifyPrimaryAudience([], []), null);
  assert.equal(agent.calculateOrganicPercentage([['SEARCH', 75], ['SUGGESTED_VIDEO', 15], ['EXTERNAL', 10]]), 90);
  assert.equal(agent.calculateOrganicPercentage([]), null, 'organic share is unknown when total views are zero');

  // Empty successful reports mean "not measured in this window", not zero retention or CTR.
  agent.youtubeAnalytics = {
    reports: {
      query: async () => ({ data: {} })
    }
  };
  const emptyViews = await agent.getViewsAnalytics('empty-video', '2026-11-01', '2026-11-20');
  assert.equal(emptyViews.totalViews, null);
  assert.equal(emptyViews.totalImpressions, null);
  assert.equal(emptyViews.averageCTR, null);
  assert.equal(emptyViews.available, false);

  agent.youtubeAnalytics = {
    reports: {
      query: async () => ({ data: { rows: [['2026-11-20', null, null, null]] } })
    }
  };
  const omittedDailyMetrics = await agent.getViewsAnalytics('omitted-video', '2026-11-01', '2026-11-20');
  assert.equal(omittedDailyMetrics.totalViews, null);
  assert.equal(omittedDailyMetrics.totalImpressions, null);
  assert.equal(omittedDailyMetrics.available, false);

  agent.youtubeAnalytics = {
    reports: {
      query: async () => ({ data: {} })
    }
  };
  const emptyWatchTime = await agent.getWatchTimeAnalytics('empty-video', '2026-11-01', '2026-11-20');
  assert.equal(emptyWatchTime.totalWatchTime, null);
  assert.equal(emptyWatchTime.averageViewPercentage, null);
  assert.equal(emptyWatchTime.retentionQuality, 'unknown');
  assert.equal(emptyWatchTime.available, false);

  const emptyThumbnail = await agent.analyzeThumbnailPerformance('empty-video', {
    startDate: '2026-11-01', endDate: '2026-11-20'
  });
  assert.equal(emptyThumbnail.impressions, null);
  assert.equal(emptyThumbnail.clickThroughRate, null);
  assert.equal(emptyThumbnail.available, false);
  assert.deepEqual(emptyThumbnail.recommendations, [
    'Thumbnail performance is unavailable for this measurement window'
  ]);

  agent.youtubeAnalytics = {
    reports: {
      query: async () => ({ data: { rows: [] } })
    }
  };
  const emptyOutcomes = await agent.getOutcomeAnalytics('empty-video', '2026-11-01', '2026-11-20');
  assert.equal(emptyOutcomes.subscribersAvailable, false);
  assert.equal(emptyOutcomes.netSubscribers, null);
  assert.equal(emptyOutcomes.revenueAvailable, false);
  assert.equal(emptyOutcomes.estimatedRevenue, null);
  const emptyTraffic = await agent.getTrafficSourcesAnalytics('empty-video', '2026-11-01', '2026-11-20');
  assert.equal(emptyTraffic.available, false);
  assert.equal(emptyTraffic.organicPercentage, null);
  const emptyDevices = await agent.getDeviceAnalytics('empty-video', '2026-11-01', '2026-11-20');
  assert.equal(emptyDevices.available, false);
  assert.equal(emptyDevices.mobilePercentage, null);

  const noMetricScore = agent.calculatePerformanceScore({
    views: { totalViews: null, averageCTR: null },
    watchTime: { averageViewPercentage: null },
    engagement: { engagementRate: null }
  });
  assert.equal(noMetricScore.score, null, 'no measured metrics must not be presented as a zero performance score');
  assert.equal(noMetricScore.grade, 'N/A');

  assert.equal(agent.analyzeSearchPerformance({
    sources: [{ source: 'SEARCH', percentage: null }]
  }).searchPercentage, null, 'null source shares must not be coerced into measured zero');
  assert.equal(agent.calculateMobilePercentage([]), null, 'device mix is unknown without measured views');
  // Traffic-source values preserve YouTube's canonical dimensions and never coerce missing views to zero.
  agent.youtubeAnalytics = {
    reports: {
      query: async args => {
        assert.equal(args.metrics, 'views', 'traffic-source reports must not invent source-level CTR');
        assert.equal(args.dimensions, 'insightTrafficSourceType');
        assert.equal(args.startDate, '2026-11-01');
        assert.equal(args.endDate, '2026-11-07');
        return { data: { rows: [
          ['YT_SEARCH', 40],
          ['RELATED_VIDEO', 30],
          ['VIDEO_BROWSE', 20],
          ['SHORTS', 10],
          ['EXT_URL', 5]
        ] } };
      }
    }
  };
  const traffic = await agent.getTrafficSourcesAnalytics('traffic-video', '2026-11-01', '2026-11-07');
  assert.equal(traffic.available, true);
  assert.equal(traffic.topSource, 'YT_SEARCH');
  assert.equal(traffic.sources.find(item => item.source === 'SHORTS').displayName, 'Shorts feed');
  assert.equal(traffic.sources.find(item => item.source === 'RELATED_VIDEO').displayName, 'Suggested videos');
  assert.equal(traffic.sources.reduce((sum, item) => sum + item.percentage, 0), 100);
  assert.equal(traffic.sources.find(item => item.source === 'YT_SEARCH').percentage, 38.1);
  assert.equal(traffic.sources.some(item => Object.hasOwn(item, 'clickThroughRate')), false);
  assert.equal(agent.analyzeSearchPerformance(traffic).searchPercentage, 38.1);

  agent.youtubeAnalytics = {
    reports: {
      query: async () => ({ data: { rows: [['YT_SEARCH', 50], ['OTHER', null]] } })
    }
  };
  const partialTraffic = await agent.getTrafficSourcesAnalytics('partial-traffic-video', '2026-11-01', '2026-11-07');
  assert.equal(partialTraffic.available, false);
  assert.equal(partialTraffic.totalsComplete, false);
  assert.equal(partialTraffic.sources[0].percentage, null,
    'partial source rows must not be normalized against an incomplete denominator');
  assert.equal(partialTraffic.organicPercentage, null);
  assert.equal(partialTraffic.sources[1].views, null);
  assert.equal(agent.analyzeSearchPerformance(partialTraffic).searchPercentage, null);

  agent.youtubeAnalytics = {
    reports: {
      query: async () => ({ data: { rows: [['OTHER', 100]] } })
    }
  };
  const otherOnlyTraffic = await agent.getTrafficSourcesAnalytics('other-traffic-video', '2026-11-01', '2026-11-07');
  assert.equal(otherOnlyTraffic.sources[0].known, false);
  assert.equal(agent.analyzeSearchPerformance(otherOnlyTraffic).searchQuality, 'unknown',
    'unclassified traffic must not be presented as measured search performance');
  assert.equal(agent.calculateOrganicPercentage([['YT_SEARCH', 75], ['RELATED_VIDEO', 15], ['EXT_URL', 10]]), 90);
  assert.equal(agent.calculateOrganicPercentage([['YT_SEARCH', null], ['EXT_URL', 10]]), null);


  const unknownSearch = agent.analyzeSearchPerformance({ sources: [] });
  assert.equal(unknownSearch.searchPercentage, null);
  assert.equal(unknownSearch.searchQuality, 'unknown');
  assert.equal(unknownSearch.organicDiscovery, null);

  const neutralInsights = await agent.generateInsights(
    { title: 'Video', description: '', tags: [] },
    {
      views: { totalViews: null },
      watchTime: { averageViewPercentage: null },
      engagement: { engagementRate: null }
    },
    { clickThroughRate: null },
    { overallSEOScore: 60 }
  );
  assert.equal(neutralInsights.some(item => ['views', 'retention', 'thumbnail', 'engagement'].includes(item.category)), false,
    'missing measurements must not produce low-performance warnings');

  // Engagement rates must use the same Analytics measurement window, not lifetime Data API counters.
  let engagementQuery = null;
  agent.youtubeAnalytics = {
    reports: {
      query: async args => {
        engagementQuery = args;
        return { data: { rows: [[1000, 40, 10]] } };
      }
    }
  };
  const engagement = await agent.calculateEngagementMetrics('window-video', '2026-11-01', '2026-11-20');
  assert.equal(engagementQuery.startDate, '2026-11-01');
  assert.equal(engagementQuery.endDate, '2026-11-20');
  assert.equal(engagement.engagementRate, 5);
  assert.equal(engagement.views, 1000);

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
