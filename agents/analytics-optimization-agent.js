const { google } = require('googleapis');
const { Logger } = require('../utils/logger');
const { ChannelLearningEngine } = require('../utils/channel-learning-engine');

const CHANNEL_SNAPSHOT_CACHE_MS = 3 * 60 * 1000;

// Explains a googleapis failure in operator terms. A Google Cloud project must
// enable each API separately; OAuth consent alone is not enough.
function describeGoogleApiError(error, apiName) {
  const body = error?.response?.data?.error || {};
  const message = String(body.message || error?.message || 'Unknown error');
  const reasons = (body.errors || []).map(item => item.reason).concat(body.status || []);
  const activationUrl = (message.match(/https:\/\/console\.(?:developers|cloud)\.google\.com\/[^\s"']+/) || [])[0] || null;
  if (activationUrl || reasons.some(reason => /accessNotConfigured|SERVICE_DISABLED/i.test(reason)) || /has not been used|is disabled/i.test(message)) {
    return { reason: `${apiName} is not enabled for your Google Cloud project. Enable it, wait a minute, then refresh.`, activationUrl };
  }
  if (/insufficient.*scope/i.test(message) || reasons.some(reason => /insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(reason))) {
    return { reason: `YouTube was connected without ${apiName} access. Reconnect YouTube with npm run walkthrough and approve every requested permission.`, activationUrl: null };
  }
  if (/invalid_grant/i.test(message)) {
    return { reason: 'The YouTube authorization expired or was revoked. Reconnect YouTube with npm run walkthrough.', activationUrl: null };
  }
  return { reason: `${apiName} request failed: ${message.slice(0, 240)}`, activationUrl: null };
}

class AnalyticsOptimizationAgent {
  constructor(db, credentials) {
    this.db = db;
    this.credentials = credentials;
    this.logger = new Logger('AnalyticsOptimization');
    this.youtubeAnalytics = null;
    this.youtube = null;
    this.performanceData = new Map();
    this.learning = new ChannelLearningEngine(db);
  }

  async initialize() {
    this.logger.info('Initializing Analytics & Optimization Agent...');
    await this.setupAnalyticsAPI();
    await this.loadHistoricalData();
    return true;
  }

  async setupAnalyticsAPI() {
    try {
      const auth = this.credentials.getYouTubeAuth();
      this.youtubeAnalytics = google.youtubeAnalytics({ version: 'v2', auth });
      this.youtube = google.youtube({ version: 'v3', auth });
      this.logger.info('YouTube Analytics API initialized');
    } catch (error) {
      this.logger.error('Failed to initialize Analytics API:', error);
      throw error;
    }
  }

  async loadHistoricalData() {
    try {
      const history = await this.db.getAnalyticsHistory();
      history.forEach(record => {
        const normalized = {
          ...record,
          videoId: record.videoId || record.video_id,
          analyzedAt: record.analyzedAt || record.analyzed_at,
          performance: record.performance || {
            score: record.performance_score || 0,
            grade: record.performance_grade || 'N/A'
          }
        };
        this.performanceData.set(normalized.videoId, normalized);
      });
      this.logger.info(`Loaded ${this.performanceData.size} historical records`);
    } catch (error) {
      this.logger.warn('No historical analytics data found');
    }
  }

  async analyzeVideoPerformance(videoId, options = {}) {
    try {
      this.logger.info(`Analyzing performance for video: ${videoId}`);
      
      // Get video details
      const videoDetails = await this.getVideoDetails(videoId);
      
      const measurementWindow = options.measurementWindow || 'rolling';
      const period = this.learning.measurementPeriod(videoDetails.publishedAt, measurementWindow);

      // Get analytics data
      const channelStrategy = this.db.getChannelStrategy ? await this.db.getChannelStrategy() : null;
      const analytics = await this.getVideoAnalytics(videoId, period, {
        currency: channelStrategy?.outcome_currency || 'USD'
      });
      const context = await this.db.getPublishedContentContext(videoId);

      // Fetch the granular retention curve separately so its absence never
      // converts otherwise-real channel analytics into simulated data.
      const retention = analytics.simulated
        ? { available: false, simulated: true, reason: 'base_analytics_unavailable', points: [] }
        : await this.getAudienceRetention(videoId, period, videoDetails.duration);
      
      // Analyze thumbnail performance
      const thumbnailMetrics = await this.analyzeThumbnailPerformance(videoId, period);
      
      // Analyze title and SEO performance
      const seoMetrics = await this.analyzeSEOPerformance(videoDetails, analytics);
      
      // Generate insights and recommendations
      const insights = await this.generateInsights(videoDetails, analytics, thumbnailMetrics, seoMetrics);
      
      const performanceReport = {
        videoId,
        videoDetails,
        analytics,
        retention,
        thumbnailMetrics,
        seoMetrics,
        insights,
        performance: this.calculatePerformanceScore(analytics),
        measurementWindow,
        analyzedAt: new Date().toISOString()
      };
      
      // Store in performance data
      this.performanceData.set(videoId, performanceReport);
      
      // Save to database
      await this.db.saveAnalyticsReport(performanceReport);
      performanceReport.learningSnapshot = await this.learning.capture(
        performanceReport,
        context,
        measurementWindow
      );
      if (!analytics.simulated && context.productionId && this.db.recordContentIdeaOutcome) {
        performanceReport.contentIdeaOutcome = await this.db.recordContentIdeaOutcome({
          productionId: context.productionId,
          videoId,
          measurementWindow,
          metrics: performanceReport.learningSnapshot?.metrics || {},
          measuredAt: performanceReport.learningSnapshot?.measured_at || new Date().toISOString(),
          simulated: false
        });
      }
      if (retention.available) {
        performanceReport.retentionSnapshot = await this.learning.captureRetention(
          {
            ...retention,
            videoId,
            title: videoDetails.title,
            publishedAt: videoDetails.publishedAt
          },
          context,
          measurementWindow,
          {
            views: analytics.views?.totalViews,
            impressions: analytics.views?.totalImpressions
          }
        );
      }
      
      this.logger.info(`Analysis complete. Performance score: ${performanceReport.performance.score}/100`);
      return performanceReport;
    } catch (error) {
      this.logger.error(`Failed to analyze video ${videoId}:`, error);
      throw error;
    }
  }

  async getVideoDetails(videoId) {
    const response = await this.youtube.videos.list({
      part: 'snippet,statistics,contentDetails',
      id: videoId
    });
    
    if (!response.data.items.length) {
      throw new Error(`Video not found: ${videoId}`);
    }
    
    const video = response.data.items[0];
    return {
      id: videoId,
      title: video.snippet.title,
      description: video.snippet.description,
      tags: video.snippet.tags || [],
      publishedAt: video.snippet.publishedAt,
      duration: video.contentDetails.duration,
      statistics: {
        viewCount: parseInt(video.statistics.viewCount) || 0,
        likeCount: parseInt(video.statistics.likeCount) || 0,
        commentCount: parseInt(video.statistics.commentCount) || 0
      }
    };
  }

  async getVideoAnalytics(videoId, period = null, options = {}) {
    const endDate = period?.endDate || new Date().toISOString().split('T')[0];
    const startDate = period?.startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const requests = {
      views: () => this.getViewsAnalytics(videoId, startDate, endDate),
      watchTime: () => this.getWatchTimeAnalytics(videoId, startDate, endDate),
      demographics: () => this.getDemographicsAnalytics(videoId, startDate, endDate),
      trafficSources: () => this.getTrafficSourcesAnalytics(videoId, startDate, endDate),
      devices: () => this.getDeviceAnalytics(videoId, startDate, endDate),
      outcomes: () => this.getOutcomeAnalytics(videoId, startDate, endDate, options.currency || 'USD'),
      engagement: () => this.calculateEngagementMetrics(videoId, startDate, endDate)
    };
    const entries = Object.entries(requests);
    const settled = await Promise.allSettled(entries.map(([, request]) => request()));
    const results = {};
    const unavailable = {};
    for (let index = 0; index < entries.length; index++) {
      const [name] = entries[index];
      const result = settled[index];
      if (result.status === 'fulfilled') {
        results[name] = result.value;
      } else {
        unavailable[name] = String(result.reason?.message || result.reason || 'Request failed').slice(0, 240);
        this.logger.warn(`YouTube analytics section "${name}" unavailable for ${videoId}: ${unavailable[name]}`);
      }
    }

    const hasCoreData = Boolean(results.views || results.watchTime);
    if (!hasCoreData) {
      this.logger.error(`Core YouTube analytics unavailable for ${videoId}; using explicitly marked simulated fallback`);
      return {
        ...this.getSimulatedAnalytics(videoId),
        period: { startDate, endDate },
        dataQuality: {
          source: 'simulated_fallback',
          partial: false,
          available: [],
          unavailable
        }
      };
    }

    return {
      simulated: false,
      period: { startDate, endDate },
      views: results.views || { totalViews: null, totalImpressions: null, averageCTR: null, dailyData: [] },
      watchTime: results.watchTime || {
        totalWatchTime: null, averageViewDuration: null, averageViewPercentage: null,
        retentionQuality: 'unknown'
      },
      demographics: results.demographics || { ageGroups: [], gender: [], primaryAudience: null },
      trafficSources: results.trafficSources || { sources: [], topSource: 'unknown', organicPercentage: null },
      devices: results.devices || { devices: [], mobilePercentage: null },
      outcomes: results.outcomes || {
        subscribersAvailable: false, subscribersGained: null, subscribersLost: null,
        netSubscribers: null, revenueAvailable: false, currency: null,
        estimatedRevenue: null, monetizedPlaybacks: null, playbackBasedCpm: null
      },
      engagement: results.engagement || { engagementRate: null, likeRatio: null, commentsPerView: null, engagementQuality: 'unknown' },
      dataQuality: {
        source: 'youtube_api',
        partial: Object.keys(unavailable).length > 0 ||
          Object.values(results).some(result => result?.dataQuality?.partial),
        available: Object.keys(results),
        unavailable,
        sections: Object.fromEntries(Object.entries(results)
          .filter(([, result]) => result?.dataQuality)
          .map(([name, result]) => [name, result.dataQuality]))
      }
    };
  }

  async getViewsAnalytics(videoId, startDate, endDate) {
    const response = await this.youtubeAnalytics.reports.query({
      ids: 'channel==MINE',
      startDate,
      endDate,
      metrics: 'views,impressions,impressionClickThroughRate',
      dimensions: 'day',
      filters: `video==${videoId}`
    });
    
    const rows = response.data.rows || [];
    const numeric = value => value === null || value === undefined || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
    const totalViews = rows.reduce((sum, row) => sum + (numeric(row[1]) ?? 0), 0);
    const totalImpressions = rows.reduce((sum, row) => sum + (numeric(row[2]) ?? 0), 0);
    const ctrRows = rows.map(row => ({ impressions: numeric(row[2]), ctr: numeric(row[3]) }))
      .filter(row => row.impressions !== null && row.impressions > 0 && row.ctr !== null);
    const ctrImpressions = ctrRows.reduce((sum, row) => sum + row.impressions, 0);
    const weightedCTR = ctrImpressions > 0
      ? ctrRows.reduce((sum, row) => sum + (row.impressions * row.ctr), 0) / ctrImpressions
      : null;

    return {
      totalViews,
      totalImpressions,
      averageCTR: weightedCTR,
      ctrAvailable: weightedCTR !== null,
      dailyData: rows
    };
  }

  async getWatchTimeAnalytics(videoId, startDate, endDate) {
    const response = await this.youtubeAnalytics.reports.query({
      ids: 'channel==MINE',
      startDate,
      endDate,
      metrics: 'estimatedMinutesWatched,averageViewDuration,averageViewPercentage',
      filters: `video==${videoId}`
    });
    
    const data = response.data.rows?.[0];
    if (!data) {
      return {
        totalWatchTime: null,
        averageViewDuration: null,
        averageViewPercentage: null,
        retentionQuality: 'unknown',
        available: false
      };
    }
    const numeric = value => value === null || value === undefined || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
    const totalWatchTime = numeric(data[0]);
    const averageViewDuration = numeric(data[1]);
    const averageViewPercentage = numeric(data[2]);
    return {
      totalWatchTime,
      averageViewDuration,
      averageViewPercentage,
      retentionQuality: averageViewPercentage === null ? 'unknown' : this.assessRetentionQuality(averageViewPercentage),
      available: [totalWatchTime, averageViewDuration, averageViewPercentage].some(value => value !== null)
    };
  }

  async getDemographicsAnalytics(videoId, startDate, endDate) {
    const queries = [
      ['ageGroups', 'ageGroup'],
      ['gender', 'gender']
    ];
    const settled = await Promise.allSettled(queries.map(([, dimension]) =>
      this.youtubeAnalytics.reports.query({
        ids: 'channel==MINE',
        startDate,
        endDate,
        metrics: 'viewerPercentage',
        dimensions: dimension,
        filters: `video==${videoId}`
      })
    ));
    const result = { ageGroups: [], gender: [] };
    const unavailable = {};
    settled.forEach((item, index) => {
      const [name] = queries[index];
      if (item.status === 'fulfilled') result[name] = item.value.data.rows || [];
      else unavailable[name] = String(item.reason?.message || item.reason || 'Request failed').slice(0, 240);
    });
    if (Object.keys(unavailable).length === queries.length) {
      throw new Error(`Demographics unavailable: ${Object.values(unavailable).join('; ')}`);
    }
    return {
      ...result,
      primaryAudience: result.ageGroups.length || result.gender.length
        ? this.identifyPrimaryAudience(result.ageGroups, result.gender)
        : null,
      dataQuality: {
        partial: Object.keys(unavailable).length > 0,
        unavailable
      }
    };
  }

  async getTrafficSourcesAnalytics(videoId, startDate, endDate) {
    const response = await this.youtubeAnalytics.reports.query({
      ids: 'channel==MINE',
      startDate,
      endDate,
      metrics: 'views',
      dimensions: 'insightTrafficSourceType',
      filters: `video==${videoId}`
    });
    
    const sources = response.data.rows || [];
    const totalViews = sources.reduce((sum, row) => sum + row[1], 0);
    
    return {
      sources: sources.map(row => ({
        source: row[0],
        views: row[1],
        percentage: totalViews > 0 ? ((row[1] / totalViews) * 100).toFixed(1) : '0.0'
      })),
      topSource: sources.length > 0 ? sources[0][0] : 'unknown',
      organicPercentage: this.calculateOrganicPercentage(sources)
    };
  }

  async getDeviceAnalytics(videoId, startDate, endDate) {
    const response = await this.youtubeAnalytics.reports.query({
      ids: 'channel==MINE',
      startDate,
      endDate,
      metrics: 'views',
      dimensions: 'deviceType',
      filters: `video==${videoId}`
    });
    
    const devices = response.data.rows || [];
    const totalViews = devices.reduce((sum, row) => sum + row[1], 0);
    
    return {
      devices: devices.map(row => ({
        device: row[0],
        views: row[1],
        percentage: ((row[1] / totalViews) * 100).toFixed(1)
      })),
      mobilePercentage: this.calculateMobilePercentage(devices)
    };
  }

  async getOutcomeAnalytics(videoId, startDate, endDate, currency = 'USD') {
    const query = (metrics, includeCurrency = false) => this.youtubeAnalytics.reports.query({
      ids: 'channel==MINE',
      startDate,
      endDate,
      metrics,
      filters: `video==${videoId}`,
      ...(includeCurrency ? { currency } : {})
    });
    const [subscriberResult, revenueResult] = await Promise.allSettled([
      query('subscribersGained,subscribersLost'),
      query('estimatedRevenue,monetizedPlaybacks,playbackBasedCpm', true)
    ]);
    const subscribers = subscriberResult.status === 'fulfilled'
      ? subscriberResult.value.data.rows?.[0] || [0, 0]
      : null;
    const revenue = revenueResult.status === 'fulfilled'
      ? revenueResult.value.data.rows?.[0] || [0, 0, 0]
      : null;
    if (!subscribers) this.logger.warn(`Subscriber outcomes unavailable for ${videoId}: ${subscriberResult.reason?.message || 'unknown error'}`);
    if (!revenue) this.logger.info(`Revenue outcomes unavailable for ${videoId}; monetization data will remain unavailable`);
    return {
      subscribersAvailable: Boolean(subscribers),
      subscribersGained: subscribers ? Number(subscribers[0] || 0) : null,
      subscribersLost: subscribers ? Number(subscribers[1] || 0) : null,
      netSubscribers: subscribers ? Number(subscribers[0] || 0) - Number(subscribers[1] || 0) : null,
      revenueAvailable: Boolean(revenue),
      currency: revenue ? currency : null,
      estimatedRevenue: revenue ? Number(revenue[0] || 0) : null,
      monetizedPlaybacks: revenue ? Number(revenue[1] || 0) : null,
      playbackBasedCpm: revenue ? Number(revenue[2] || 0) : null
    };
  }

  async calculateEngagementMetrics(videoId, startDate = null, endDate = null) {
    const response = await this.youtubeAnalytics.reports.query({
      ids: 'channel==MINE',
      startDate: startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      endDate: endDate || new Date().toISOString().split('T')[0],
      metrics: 'views,likes,comments',
      filters: `video==${videoId}`
    });
    const data = response.data.rows?.[0];
    if (!data) {
      return {
        views: null, likes: null, comments: null,
        engagementRate: null, likeRatio: null, commentsPerView: null,
        engagementQuality: 'unknown', available: false
      };
    }
    const numeric = value => value === null || value === undefined || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
    const views = numeric(data[0]);
    const likes = numeric(data[1]);
    const comments = numeric(data[2]);
    const interactions = likes === null || comments === null ? null : likes + comments;
    const engagementRate = views > 0 && interactions !== null ? (interactions / views) * 100 : null;
    const likeRatio = interactions > 0 && likes !== null ? (likes / interactions) * 100 : null;
    const commentsPerView = views > 0 && comments !== null ? (comments / views) * 100 : null;
    return {
      views, likes, comments,
      engagementRate: engagementRate === null ? null : Number(engagementRate.toFixed(2)),
      likeRatio: likeRatio === null ? null : Number(likeRatio.toFixed(2)),
      commentsPerView: commentsPerView === null ? null : Number(commentsPerView.toFixed(4)),
      engagementQuality: engagementRate === null ? 'unknown' : this.assessEngagementQuality(engagementRate),
      available: [views, likes, comments].some(value => value !== null)
    };
  }

  async analyzeThumbnailPerformance(videoId, period = null) {
    // Analyze thumbnail click-through rate and impressions
    try {
      const response = await this.youtubeAnalytics.reports.query({
        ids: 'channel==MINE',
        startDate: period?.startDate || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        endDate: period?.endDate || new Date().toISOString().split('T')[0],
        metrics: 'impressions,impressionClickThroughRate',
        filters: `video==${videoId}`
      });
      
      const data = response.data.rows?.[0];
      if (!data) {
        return {
          impressions: null, clickThroughRate: null, ctrQuality: 'unknown',
          available: false, dataQuality: { status: 'no_rows', reason: 'No thumbnail metrics returned for the requested period.' },
          recommendations: ['Thumbnail performance is unavailable for this measurement window']
        };
      }
      const impressions = data[0] === null || data[0] === undefined ? null : Number(data[0]);
      const ctr = data[1] === null || data[1] === undefined ? null : Number(data[1]);
      const validImpressions = Number.isFinite(impressions) ? impressions : null;
      const validCtr = Number.isFinite(ctr) ? ctr : null;
      return {
        impressions: validImpressions,
        clickThroughRate: validCtr,
        ctrQuality: validCtr === null ? 'unknown' : this.assessCTRQuality(validCtr),
        available: validImpressions !== null || validCtr !== null,
        dataQuality: { status: 'available', source: 'youtube_analytics' },
        recommendations: validCtr === null
          ? ['CTR is unavailable; do not infer thumbnail quality']
          : this.generateThumbnailRecommendations(validCtr)
      };
    } catch (error) {
      return {
        impressions: null,
        clickThroughRate: null,
        ctrQuality: 'unknown',
        available: false,
        dataQuality: { status: 'unavailable', reason: String(error.message || error).slice(0, 240) },
        recommendations: ['Unable to analyze thumbnail performance']
      };
    }
  }

  async analyzeSEOPerformance(videoDetails, analytics) {
    const title = videoDetails.title;
    const description = videoDetails.description;
    const tags = videoDetails.tags;
    
    // Analyze title effectiveness
    const titleScore = this.scoreTitleEffectiveness(title, analytics.views.totalViews);
    
    // Analyze description optimization
    const descriptionScore = this.scoreDescriptionOptimization(description);
    
    // Analyze tag relevance
    const tagScore = this.scoreTagRelevance(tags, title);
    
    // Search performance
    const searchPerformance = this.analyzeSearchPerformance(analytics.trafficSources);
    
    return {
      titleScore,
      descriptionScore,
      tagScore,
      searchPerformance,
      overallSEOScore: Math.round((titleScore + descriptionScore + tagScore) / 3),
      recommendations: this.generateSEORecommendations(titleScore, descriptionScore, tagScore, searchPerformance)
    };
  }

  async generateInsights(videoDetails, analytics, thumbnailMetrics, seoMetrics) {
    const insights = [];
    
    // Performance insights
    if (Number.isFinite(analytics.views?.totalViews) && analytics.views.totalViews > 10000) {
      insights.push({
        type: 'success',
        category: 'views',
        message: 'Video is performing above average in terms of views',
        impact: 'high'
      });
    } else if (Number.isFinite(analytics.views?.totalViews) && analytics.views.totalViews < 1000) {
      insights.push({
        type: 'warning',
        category: 'views',
        message: 'Video views are below expected threshold',
        impact: 'high',
        recommendation: 'Consider promoting the video or optimizing SEO'
      });
    }
    
    // Retention insights
    if (Number.isFinite(analytics.watchTime?.averageViewPercentage) && analytics.watchTime.averageViewPercentage > 50) {
      insights.push({
        type: 'success',
        category: 'retention',
        message: 'Excellent audience retention rate',
        impact: 'medium'
      });
    } else if (Number.isFinite(analytics.watchTime?.averageViewPercentage) && analytics.watchTime.averageViewPercentage < 30) {
      insights.push({
        type: 'critical',
        category: 'retention',
        message: 'Poor audience retention - viewers are dropping off early',
        impact: 'high',
        recommendation: 'Review content structure and pacing'
      });
    }
    
    // Thumbnail insights
    if (Number.isFinite(thumbnailMetrics?.clickThroughRate) && thumbnailMetrics.clickThroughRate > 8) {
      insights.push({
        type: 'success',
        category: 'thumbnail',
        message: 'Thumbnail is highly effective at driving clicks',
        impact: 'high'
      });
    } else if (Number.isFinite(thumbnailMetrics?.clickThroughRate) && thumbnailMetrics.clickThroughRate < 3) {
      insights.push({
        type: 'warning',
        category: 'thumbnail',
        message: 'Thumbnail may not be compelling enough',
        impact: 'high',
        recommendation: 'Consider A/B testing different thumbnail designs'
      });
    }
    
    // SEO insights
    if (seoMetrics.overallSEOScore > 80) {
      insights.push({
        type: 'success',
        category: 'seo',
        message: 'Video is well-optimized for search',
        impact: 'medium'
      });
    } else if (seoMetrics.overallSEOScore < 50) {
      insights.push({
        type: 'warning',
        category: 'seo',
        message: 'SEO optimization needs improvement',
        impact: 'medium',
        recommendation: 'Optimize title, description, and tags'
      });
    }
    
    // Engagement insights
    if (Number.isFinite(analytics.engagement?.engagementRate) && analytics.engagement.engagementRate > 5) {
      insights.push({
        type: 'success',
        category: 'engagement',
        message: 'High audience engagement',
        impact: 'medium'
      });
    } else if (Number.isFinite(analytics.engagement?.engagementRate) && analytics.engagement.engagementRate < 1) {
      insights.push({
        type: 'warning',
        category: 'engagement',
        message: 'Low audience engagement',
        impact: 'medium',
        recommendation: 'Encourage more interaction in future videos'
      });
    }
    
    return insights;
  }

  calculatePerformanceScore(analytics) {
    const components = [
      ['views', analytics.views?.totalViews, 30, value => Math.min(30, (value / 10000) * 30)],
      ['retention', analytics.watchTime?.averageViewPercentage, 25, value => (value / 100) * 25],
      ['engagement', analytics.engagement?.engagementRate, 25, value => Math.min(25, value * 5)],
      ['ctr', analytics.views?.averageCTR, 20, value => Math.min(20, value * 2)]
    ];
    let score = 0;
    let maxScore = 0;
    const breakdown = {};
    for (const [name, rawValue, weight, calculate] of components) {
      const value = rawValue === null || rawValue === undefined ? NaN : Number(rawValue);
      if (!Number.isFinite(value)) {
        breakdown[name] = null;
        continue;
      }
      const points = calculate(value);
      score += points;
      maxScore += weight;
      breakdown[name] = Math.round(points);
    }
    const finalScore = maxScore > 0 ? Math.round((score / maxScore) * 100) : null;
    return {
      score: finalScore,
      breakdown,
      availableWeight: maxScore,
      grade: finalScore === null ? 'N/A' : this.getPerformanceGrade(finalScore)
    };
  }

  getPerformanceGrade(score) {
    if (score >= 90) return 'A+';
    if (score >= 80) return 'A';
    if (score >= 70) return 'B';
    if (score >= 60) return 'C';
    if (score >= 50) return 'D';
    return 'F';
  }

  // Helper methods
  calculateAverage(values) {
    if (!values.length) return 0;
    return values.reduce((sum, val) => sum + val, 0) / values.length;
  }

  assessRetentionQuality(percentage) {
    if (percentage > 60) return 'excellent';
    if (percentage > 40) return 'good';
    if (percentage > 25) return 'average';
    return 'poor';
  }

  assessEngagementQuality(rate) {
    if (rate > 8) return 'excellent';
    if (rate > 5) return 'good';
    if (rate > 2) return 'average';
    return 'poor';
  }

  assessCTRQuality(ctr) {
    if (ctr > 10) return 'excellent';
    if (ctr > 6) return 'good';
    if (ctr > 3) return 'average';
    return 'poor';
  }

  scoreTitleEffectiveness(title, views) {
    let score = 0;
    
    // Length check
    if (title.length >= 50 && title.length <= 70) score += 20;
    else if (title.length >= 40 && title.length <= 80) score += 15;
    else score += 10;
    
    // Power words
    const powerWords = ['ultimate', 'complete', 'secret', 'amazing', 'shocking', 'incredible'];
    if (powerWords.some(word => title.toLowerCase().includes(word))) score += 15;
    
    // Numbers
    if (/\d+/.test(title)) score += 10;
    
    // Emotional triggers
    const emotionalWords = ['how', 'why', 'what', 'best', 'worst', 'never', 'always'];
    if (emotionalWords.some(word => title.toLowerCase().includes(word))) score += 15;
    
    // Performance correlation
    if (views > 10000) score += 20;
    else if (views > 1000) score += 10;
    
    return Math.min(100, score);
  }

  scoreDescriptionOptimization(description) {
    let score = 0;
    
    if (description.length > 200) score += 20;
    if (description.includes('http')) score += 15; // Has links
    if (description.includes('TIMESTAMP') || description.includes('00:')) score += 15; // Has timestamps
    if (description.split('\n').length > 5) score += 15; // Well formatted
    if (description.length > 500) score += 10; // Comprehensive
    
    // Keyword density check (simplified)
    const wordCount = description.split(' ').length;
    if (wordCount > 100) score += 15;
    
    return Math.min(100, score);
  }

  scoreTagRelevance(tags, title) {
    let score = 0;
    
    if (tags.length >= 10) score += 20;
    if (tags.length >= 5) score += 10;
    
    // Tag-title relevance
    const titleWords = title.toLowerCase().split(' ');
    const relevantTags = tags.filter(tag => 
      titleWords.some(word => tag.toLowerCase().includes(word))
    );
    
    if (relevantTags.length > 0) {
      score += (relevantTags.length / tags.length) * 30;
    }
    
    // Long-tail keywords
    const longTailTags = tags.filter(tag => tag.split(' ').length > 2);
    if (longTailTags.length > 0) score += 20;
    
    return Math.min(100, score);
  }

  analyzeSearchPerformance(trafficSources) {
    const searchSources = trafficSources.sources.filter(source => 
      ['SEARCH', 'YOUTUBE_SEARCH'].includes(source.source)
    );
    
    const searchPercentage = searchSources.reduce((sum, source) => 
      sum + parseFloat(source.percentage), 0
    );
    
    return {
      searchPercentage,
      searchQuality: searchPercentage > 20 ? 'good' : searchPercentage > 10 ? 'average' : 'poor',
      organicDiscovery: searchPercentage > 30
    };
  }

  generateThumbnailRecommendations(ctr) {
    if (ctr > 8) return ['Thumbnail is performing excellently', 'Consider using similar design elements in future thumbnails'];
    if (ctr > 5) return ['Good thumbnail performance', 'Minor optimizations may help'];
    if (ctr > 3) return ['Average performance', 'Test brighter colors or more contrasting text'];
    return ['Poor thumbnail performance', 'Consider A/B testing', 'Use more compelling imagery', 'Increase text contrast'];
  }

  generateSEORecommendations(titleScore, descriptionScore, tagScore, searchPerformance) {
    const recommendations = [];
    
    if (titleScore < 70) {
      recommendations.push('Optimize title with power words and emotional triggers');
    }
    
    if (descriptionScore < 60) {
      recommendations.push('Improve description with timestamps, links, and detailed content');
    }
    
    if (tagScore < 50) {
      recommendations.push('Use more relevant tags and long-tail keywords');
    }
    
    if (searchPerformance.searchPercentage < 15) {
      recommendations.push('Focus on search optimization to improve organic discovery');
    }
    
    return recommendations;
  }

  // Simulation methods for when API is not available
  getSimulatedAnalytics(_videoId) {
    return {
      simulated: true,
      views: { totalViews: Math.floor(Math.random() * 50000), averageCTR: Math.random() * 10 },
      watchTime: { averageViewPercentage: Math.random() * 100 },
      engagement: { engagementRate: Math.random() * 10 },
      trafficSources: { sources: [{ source: 'SEARCH', percentage: '30' }] },
      outcomes: {
        subscribersAvailable: false, subscribersGained: null, subscribersLost: null,
        netSubscribers: null, revenueAvailable: false, estimatedRevenue: null,
        monetizedPlaybacks: null, playbackBasedCpm: null
      }
    };
  }

  getSimulatedDemographics() {
    return {
      ageGroups: [['18-24', 30], ['25-34', 40], ['35-44', 20]],
      gender: [['male', 60], ['female', 40]],
      primaryAudience: 'Males 25-34'
    };
  }

  identifyPrimaryAudience(ageGroups, gender) {
    const topAge = ageGroups?.[0]?.[0] || null;
    const topGender = gender?.[0]?.[0] || null;
    if (!topAge && !topGender) return null;
    if (!topAge) return `${topGender}, age unavailable`;
    if (!topGender) return `Gender unavailable, ${topAge}`;
    return `${topGender}s ${topAge}`;
  }

  calculateOrganicPercentage(sources) {
    const organicSources = ['SEARCH', 'YOUTUBE_SEARCH', 'SUGGESTED_VIDEO'];
    const totalViews = (sources || []).reduce((sum, row) => sum + (Number(row[1]) || 0), 0);
    if (totalViews <= 0) return null;
    const organicViews = (sources || [])
      .filter(row => organicSources.includes(row[0]))
      .reduce((sum, row) => sum + (Number(row[1]) || 0), 0);
    return Number(((organicViews / totalViews) * 100).toFixed(1));
  }

  calculateMobilePercentage(devices) {
    const mobileDevices = devices.filter(row => 
      ['MOBILE', 'TABLET'].includes(row[0])
    );
    const total = devices.reduce((sum, row) => sum + row[1], 0);
    const mobile = mobileDevices.reduce((sum, row) => sum + row[1], 0);
    
    return total > 0 ? ((mobile / total) * 100).toFixed(1) : '0';
  }

  async getRecentAnalytics(days = 7) {
    const recentReports = Array.from(this.performanceData.values())
      .filter(report => {
        const reportDate = new Date(report.analyzedAt);
        const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        return reportDate > cutoffDate;
      })
      .sort((a, b) => new Date(b.analyzedAt) - new Date(a.analyzedAt));
    
    return {
      totalVideos: recentReports.length,
      averagePerformanceScore: this.calculateAverageScore(recentReports),
      topPerformers: recentReports.slice(0, 5),
      insights: this.generateChannelInsights(recentReports)
    };
  }

  // Channel-wide totals read straight from YouTube, whichever tool published
  // the videos. getRecentAnalytics only covers videos this agent analyzed, which
  // reads as "0" for an established channel. Unavailable data is reported with
  // a reason and null values, never as a zero.
  async getChannelSnapshot({ refresh = false } = {}) {
    const cached = this.channelSnapshotCache;
    if (!refresh && cached && Date.now() - cached.cachedAt < CHANNEL_SNAPSHOT_CACHE_MS) return cached.value;
    if (!this.youtube) {
      return { available: false, reason: 'Connect YouTube with npm run walkthrough to see channel statistics.' };
    }

    let channel;
    try {
      const response = await this.youtube.channels.list({ part: ['snippet', 'statistics'], mine: true });
      channel = response.data.items?.[0];
    } catch (error) {
      return { available: false, reason: describeGoogleApiError(error, 'YouTube Data API').reason };
    }
    if (!channel) {
      return { available: false, reason: 'The connected Google account does not own a YouTube channel.' };
    }

    const stats = channel.statistics || {};
    const count = value => (value === undefined || value === null ? null : Number(value));
    const value = {
      available: true,
      fetchedAt: new Date().toISOString(),
      channel: {
        id: channel.id,
        title: channel.snippet?.title || null,
        subscribers: stats.hiddenSubscriberCount ? null : count(stats.subscriberCount),
        subscribersHidden: Boolean(stats.hiddenSubscriberCount),
        views: count(stats.viewCount),
        videos: count(stats.videoCount)
      },
      recent: await this.getChannelRecentMetrics()
    };
    this.channelSnapshotCache = { cachedAt: Date.now(), value };
    return value;
  }

  async getChannelRecentMetrics() {
    // YouTube Analytics lags about two days, so the 28-day window ends two days ago.
    const day = 24 * 60 * 60 * 1000;
    const end = new Date(Date.now() - 2 * day);
    const startDate = new Date(end.getTime() - 27 * day).toISOString().split('T')[0];
    const endDate = end.toISOString().split('T')[0];
    try {
      const response = await this.youtubeAnalytics.reports.query({
        ids: 'channel==MINE',
        startDate,
        endDate,
        metrics: 'views,estimatedMinutesWatched,subscribersGained,subscribersLost'
      });
      const headers = (response.data.columnHeaders || []).map(header => header.name);
      const row = response.data.rows?.[0] || [];
      const metric = name => {
        const position = headers.indexOf(name);
        return position >= 0 ? Number(row[position] || 0) : 0;
      };
      const gained = metric('subscribersGained');
      const lost = metric('subscribersLost');
      return {
        available: true,
        startDate,
        endDate,
        views: metric('views'),
        watchHours: Math.round(metric('estimatedMinutesWatched') / 6) / 10,
        subscribersGained: gained,
        subscribersLost: lost,
        netSubscribers: gained - lost
      };
    } catch (error) {
      const { reason, activationUrl } = describeGoogleApiError(error, 'YouTube Analytics API');
      this.logger.warn(`Channel analytics unavailable: ${reason}`);
      return { available: false, startDate, endDate, reason, activationUrl };
    }
  }

  async getAudienceRetention(videoId, period = null, isoDuration = null) {
    const endDate = period?.endDate || new Date().toISOString().split('T')[0];
    const startDate = period?.startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    try {
      const response = await this.youtubeAnalytics.reports.query({
        ids: 'channel==MINE',
        startDate,
        endDate,
        metrics: 'audienceWatchRatio,relativeRetentionPerformance,startedWatching,stoppedWatching,totalSegmentImpressions',
        dimensions: 'elapsedVideoTimeRatio',
        filters: `video==${videoId}`
      });
      const headers = (response.data.columnHeaders || []).map(header => header.name);
      const index = name => headers.indexOf(name);
      const value = (row, name) => {
        const position = index(name);
        return position >= 0 ? Number(row[position] || 0) : 0;
      };
      const points = (response.data.rows || []).map(row => ({
        elapsedRatio: value(row, 'elapsedVideoTimeRatio'),
        audienceWatchRatio: value(row, 'audienceWatchRatio'),
        relativeRetentionPerformance: value(row, 'relativeRetentionPerformance'),
        startedWatching: value(row, 'startedWatching'),
        stoppedWatching: value(row, 'stoppedWatching'),
        totalSegmentImpressions: value(row, 'totalSegmentImpressions')
      })).filter(point => point.elapsedRatio > 0);
      return {
        available: points.length > 0,
        simulated: false,
        reason: points.length ? null : 'no_retention_rows',
        period: { startDate, endDate },
        durationSeconds: this.parseISODurationSeconds(isoDuration),
        points
      };
    } catch (error) {
      this.logger.warn(`Audience retention curve unavailable for ${videoId}: ${error.message}`);
      return { available: false, simulated: false, reason: 'retention_api_unavailable', points: [] };
    }
  }

  parseISODurationSeconds(value) {
    const match = String(value || '').match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
    if (!match) return 0;
    return Number(match[1] || 0) * 86400 + Number(match[2] || 0) * 3600 + Number(match[3] || 0) * 60 + Number(match[4] || 0);
  }

  getLearningSummary() {
    return this.learning.getSummary();
  }

  getDueMeasurementWindows(video) {
    return this.learning.getDueMeasurementWindows(video);
  }

  calculateAverageScore(reports) {
    if (!reports.length) return 0;
    const total = reports.reduce((sum, report) => sum + report.performance.score, 0);
    return Math.round(total / reports.length);
  }

  generateChannelInsights(reports) {
    if (!reports.length) return [];
    
    const insights = [];
    const avgScore = this.calculateAverageScore(reports);
    
    if (avgScore > 80) {
      insights.push('Channel is performing excellently across all metrics');
    } else if (avgScore < 50) {
      insights.push('Channel performance needs significant improvement');
    }
    
    // Analyze common issues
    const lowRetentionVideos = reports.filter(r => 
      r.analytics.watchTime.averageViewPercentage < 30
    ).length;
    
    if (lowRetentionVideos > reports.length * 0.5) {
      insights.push('Multiple videos showing poor retention - review content quality');
    }
    
    return insights;
  }
}

module.exports = { AnalyticsOptimizationAgent };
