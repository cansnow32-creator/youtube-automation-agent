const crypto = require('crypto');
const { Logger } = require('./logger');
const { SceneRetentionEngine } = require('./scene-retention-engine');

class ChannelLearningEngine {
  constructor(db) {
    this.db = db;
    this.logger = new Logger('ChannelLearning');
    this.sceneRetention = new SceneRetentionEngine(db);
  }

  async capture(performanceReport, context = {}, measurementWindow = 'rolling') {
    const metrics = this.normalizeMetrics(performanceReport, context);
    const attributes = this.extractAttributes(performanceReport, context);
    const prior = (await this.db.listPerformanceSnapshots({
      measurementWindow,
      reliableOnly: true,
      excludeVideoId: performanceReport.videoId
    })).filter(snapshot => (snapshot.contentAttributes?.surface || 'long_form') === attributes.surface);
    const baseline = this.calculateBaseline(prior);
    const simulated = Boolean(performanceReport.analytics?.simulated);
    const confidence = simulated ? 'unverified' : this.confidenceFor(metrics);
    const snapshot = await this.db.savePerformanceSnapshot({
      videoId: performanceReport.videoId,
      productionId: context.productionId || null,
      measurementWindow,
      publishedAt: performanceReport.videoDetails?.publishedAt || context.publishedAt || null,
      metrics,
      contentAttributes: attributes,
      baseline,
      deltas: this.calculateDeltas(metrics, baseline),
      confidence,
      simulated
    });

    if (simulated) {
      this.logger.warn(`Excluded simulated analytics for ${performanceReport.videoId} from channel learning`);
      return snapshot;
    }

    await this.refreshRecommendations();
    return snapshot;
  }

  normalizeMetrics(report, context = {}) {
    const analytics = report.analytics || {};
    const views = analytics.views || {};
    const watchTime = analytics.watchTime || {};
    const engagement = analytics.engagement || {};
    const outcomes = analytics.outcomes || {};
    const impressions = this.optionalNumber(views.totalImpressions ?? report.thumbnailMetrics?.impressions);
    const totalViews = this.optionalNumber(views.totalViews);
    const watchMinutes = this.optionalNumber(watchTime.totalWatchTime);
    const netSubscribers = outcomes.subscribersAvailable ? this.optionalNumber(outcomes.netSubscribers) : null;
    const estimatedRevenue = outcomes.revenueAvailable ? this.optionalNumber(outcomes.estimatedRevenue) : null;
    const cost = context.productionCost || {};
    const productionCost = this.optionalNumber(cost.amount);
    const revenueCurrency = outcomes.currency || null;
    const costCurrency = cost.currency || null;
    const currencyCompatible = productionCost === 0 || (
      revenueCurrency && costCurrency && String(revenueCurrency).toUpperCase() === String(costCurrency).toUpperCase()
    );
    return {
      views: totalViews,
      impressions,
      ctr: this.optionalNumber(report.thumbnailMetrics?.clickThroughRate ?? views.averageCTR),
      retention: this.optionalNumber(watchTime.averageViewPercentage),
      averageViewDuration: this.optionalNumber(watchTime.averageViewDuration),
      watchMinutes,
      watchHours: watchMinutes !== null ? Number((watchMinutes / 60).toFixed(3)) : null,
      engagementRate: this.optionalNumber(engagement.engagementRate),
      performanceScore: this.optionalNumber(report.performance?.score),
      subscribersGained: outcomes.subscribersAvailable ? this.optionalNumber(outcomes.subscribersGained) : null,
      subscribersLost: outcomes.subscribersAvailable ? this.optionalNumber(outcomes.subscribersLost) : null,
      netSubscribers,
      estimatedRevenue,
      revenueCurrency,
      monetizedPlaybacks: outcomes.revenueAvailable ? this.optionalNumber(outcomes.monetizedPlaybacks) : null,
      playbackBasedCpm: outcomes.revenueAvailable ? this.optionalNumber(outcomes.playbackBasedCpm) : null,
      subscribersPerThousandImpressions: netSubscribers !== null && impressions !== null && impressions > 0
        ? Number(((netSubscribers / impressions) * 1000).toFixed(3))
        : null,
      watchHoursPerThousandViews: watchMinutes !== null && totalViews !== null && totalViews > 0
        ? Number((((watchMinutes / 60) / totalViews) * 1000).toFixed(3))
        : null,
      revenuePerThousandViews: estimatedRevenue !== null && totalViews !== null && totalViews > 0
        ? Number(((estimatedRevenue / totalViews) * 1000).toFixed(3))
        : null,
      productionCost,
      costCurrency,
      costComplete: cost.complete === true,
      netRevenue: estimatedRevenue !== null && productionCost !== null && cost.complete === true && currencyCompatible
        ? Number((estimatedRevenue - productionCost).toFixed(3))
        : null,
      roi: estimatedRevenue !== null && productionCost !== null && productionCost > 0 && cost.complete === true && currencyCompatible
        ? Number((((estimatedRevenue - productionCost) / productionCost) * 100).toFixed(1))
        : null
    };
  }
  extractAttributes(report, context) {
    const strategy = context.strategy || {};
    const script = context.script || {};
    const thumbnail = context.thumbnail || {};
    const title = report.videoDetails?.title || context.title || script.title || '';
    const hook = this.text(script.hook || script.introduction || '');
    const surface = this.normalizeSurface(
      context.surface || context.contentFormat || strategy.surface || strategy.contentFormat
    );
    return {
      topic: strategy.topic || '',
      pillar: strategy.contentPillar || strategy.pillar || 'unknown',
      surface,
      format: surface === 'shorts'
        ? 'shorts'
        : surface === 'long_form'
          ? this.slug(strategy.requestedStyle || strategy.contentType || 'unknown')
          : 'unknown',
      length: this.slug(strategy.requestedLengthKey || strategy.requestedLength || 'unknown'),
      durationBucket: this.durationBucket(report.videoDetails?.duration),
      hookLength: hook ? (this.wordCount(hook) <= 40 ? 'concise' : 'extended') : 'unknown',
      titleLength: title ? (this.wordCount(title) <= 9 ? 'concise' : 'long') : 'unknown',
      thumbnailStyle: this.slug(
        thumbnail.concept?.composition || thumbnail.concept?.style || thumbnail.style || 'unknown'
      ),
      provider: context.productionCost?.providers?.length === 1 ? this.slug(context.productionCost.providers[0]) : 'mixed_or_unknown',
      source: strategy.planRationale ? 'autonomous_operator' : 'manual',
      appliedLearnings: this.extractAppliedLearnings(strategy, context.appliedLearnings),
      packagingChangeHistory: (Array.isArray(context.packagingChangeHistory) ? context.packagingChangeHistory : [])
        .slice(-20)
        .map(change => ({
          source: String(change.source || 'unknown').slice(0, 60),
          appliedAt: change.appliedAt || null,
          previousTitle: String(change.previousTitle || '').slice(0, 100),
          title: String(change.title || '').slice(0, 100)
        })),
      measurementPeriod: (() => {
        const period = report.analytics?.period || {};
        return {
          measurementWindow: period.measurementWindow || report.measurementWindow || 'rolling',
          startDate: period.startDate || null,
          endDate: period.endDate || null,
          windowDays: this.optionalNumber(period.windowDays),
          precision: period.precision || 'unknown'
        };
      })()
    };
  }

  normalizeSurface(value) {
    const normalized = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (['short', 'shorts', 'short_form', 'youtube_shorts'].includes(normalized)) return 'shorts';
    if (['long', 'long_form', 'video', 'standard', 'longform'].includes(normalized)) return 'long_form';
    return 'unknown';
  }

  snapshotSurface(snapshot) {
    return this.normalizeSurface(snapshot?.contentAttributes?.surface);
  }

  extractAppliedLearnings(strategy = {}, appliedLearnings = []) {
    const candidates = (Array.isArray(appliedLearnings) ? appliedLearnings : [])
      .filter(item => item?.recommendationId && item.category === 'packaging_experiment')
      .map(item => ({
        recommendationId: String(item.recommendationId),
        category: 'packaging_experiment',
        appliedTo: Array.isArray(item.appliedTo) ? item.appliedTo.filter(value => ['title', 'thumbnail'].includes(value)) : [],
        source: item.source || 'unknown'
      }))
      .filter(item => item.appliedTo.length > 0);
    for (const item of Array.isArray(strategy.approvedScriptLearnings) ? strategy.approvedScriptLearnings : []) {
      if (!item?.recommendationId) continue;
      candidates.push({
        recommendationId: String(item.recommendationId),
        category: String(item.category || 'unknown'),
        appliedTo: ['script']
      });
    }
    const unique = new Map();
    for (const item of candidates) {
      if (!unique.has(item.recommendationId)) unique.set(item.recommendationId, item);
    }
    return [...unique.values()].slice(0, 12);
  }

  buildAppliedLearningFeedback(snapshots = []) {
    const mature = snapshots.filter(snapshot =>
      !snapshot.simulated &&
      snapshot.measurementWindow === '7d' &&
      Array.isArray(snapshot.contentAttributes?.appliedLearnings) &&
      this.optionalNumber(snapshot.metrics?.impressions) >= 1000
    );
    const grouped = new Map();
    for (const snapshot of mature) {
      for (const learning of snapshot.contentAttributes.appliedLearnings) {
        if (!learning?.recommendationId) continue;
        if (!grouped.has(learning.recommendationId)) grouped.set(learning.recommendationId, {
          recommendationId: learning.recommendationId,
          category: learning.category || 'unknown',
          productions: new Map()
        });
        const group = grouped.get(learning.recommendationId);
        const prior = group.productions.get(snapshot.productionId || snapshot.videoId);
        if (!prior || prior.measurementWindow !== '7d') {
          group.productions.set(snapshot.productionId || snapshot.videoId, snapshot);
        }
      }
    }

    return [...grouped.values()].map(group => {
      const metric = group.category === 'packaging_experiment'
        ? 'ctr'
        : ['hookLength', 'retention'].includes(group.category)
          ? 'retention'
          : 'watchHoursPerThousandViews';
      const samples = [...group.productions.values()];
      const deltas = samples.map(snapshot => this.optionalNumber(snapshot.deltas?.[metric])).filter(value => value !== null);
      const impressions = samples.reduce((sum, snapshot) => sum + (this.optionalNumber(snapshot.metrics?.impressions) || 0), 0);
      let status = 'insufficient_data';
      if (samples.length >= 2 && impressions >= 2000) {
        if (deltas.length < 2) status = 'inconclusive';
        else {
          const medianDelta = this.median(deltas);
          status = medianDelta >= 5 ? 'positive_signal' : medianDelta <= -5 ? 'negative_signal' : 'inconclusive';
        }
      }
      return {
        recommendationId: group.recommendationId,
        category: group.category,
        status,
        measuredProductions: samples.length,
        measuredSamples: deltas.length,
        impressions,
        metric,
        medianBaselineDeltaPercent: deltas.length ? Number(this.median(deltas).toFixed(1)) : null,
        measurementWindow: '7d',
        interpretation: 'Observational association only; this does not establish causation or approve the recommendation.'
      };
    });
  }

  calculateBaseline(snapshots) {
    const keys = [
      'views', 'impressions', 'ctr', 'retention', 'averageViewDuration', 'watchMinutes', 'watchHours',
      'engagementRate', 'performanceScore', 'netSubscribers', 'subscribersPerThousandImpressions',
      'estimatedRevenue', 'revenuePerThousandViews', 'productionCost', 'netRevenue', 'roi'
    ];
    return Object.fromEntries(keys.map(key => [key, this.median(
      snapshots.map(snapshot => this.optionalNumber(snapshot.metrics?.[key])).filter(value => value !== null)
    )]));
  }

  calculateDeltas(metrics, baseline) {
    return Object.fromEntries(Object.entries(metrics).map(([key, value]) => {
      const numericValue = this.optionalNumber(value);
      const reference = this.optionalNumber(baseline[key]);
      return [key, numericValue !== null && reference !== null && reference !== 0
        ? Number((((numericValue - reference) / Math.abs(reference)) * 100).toFixed(1))
        : null];
    }));
  }

  confidenceFor(metrics) {
    if (metrics.impressions >= 1000 && metrics.views >= 100) return 'high';
    if (metrics.impressions >= 100 && metrics.views >= 20) return 'medium';
    return 'low';
  }

  async refreshRecommendations() {
    // Recommendations compare one fixed cohort window; never mix shorter or rolling totals.
    const [weekly, strategy] = await Promise.all([
      this.db.listPerformanceSnapshots({ measurementWindow: '7d', reliableOnly: true }),
      this.db.getChannelStrategy ? this.db.getChannelStrategy() : Promise.resolve(null)
    ]);
    const snapshots = this.preferredSnapshotPerVideo(weekly, '7d');
    if (snapshots.length < 2) return [];

    // Shorts and long-form have different exposure and retention distributions.
    // Build each recommendation cohort independently instead of averaging surfaces together.
    // Unknown legacy surface labels are not assumed to be long-form and cannot steer plans.
    const surfaces = [...new Set(snapshots
      .map(snapshot => this.snapshotSurface(snapshot))
      .filter(surface => surface !== 'unknown'))];
    const candidates = surfaces.flatMap(surface => {
      const cohort = snapshots.filter(snapshot => this.snapshotSurface(snapshot) === surface);
      return [
        ...this.buildDimensionRecommendations(cohort),
        ...this.buildChannelRecommendations(cohort),
        ...this.buildOutcomeRecommendations(cohort, strategy)
      ].map(candidate => ({
        ...candidate,
        evidence: { ...(candidate.evidence || {}), surface },
        proposedChange: { ...(candidate.proposedChange || {}), surface }
      }));
    });
    const saved = [];
    for (const candidate of candidates) {
      saved.push(await this.db.saveLearningRecommendation({
        ...candidate,
        fingerprint: this.fingerprint(candidate)
      }));
    }
    return saved;
  }

  preferredSnapshotPerVideo(snapshots, measurementWindow = '7d') {
    // A missing 7d measurement is not replaced by a 24h or rolling snapshot.
    const selected = new Map();
    for (const snapshot of snapshots) {
      if (snapshot.measurementWindow !== measurementWindow) continue;
      const current = selected.get(snapshot.videoId);
      if (!current || new Date(snapshot.measuredAt || 0) > new Date(current.measuredAt || 0)) {
        selected.set(snapshot.videoId, snapshot);
      }
    }
    return [...selected.values()];
  }

  buildDimensionRecommendations(snapshots) {
    const dimensions = [
      { key: 'format', metric: 'performanceScore', label: 'format', minimumDifference: 10 },
      { key: 'length', metric: 'retention', label: 'video length', minimumDifference: 8 },
      { key: 'hookLength', metric: 'retention', label: 'hook style', minimumDifference: 8 },
      { key: 'titleLength', metric: 'ctr', label: 'title style', minimumDifference: 1.25 }
    ];
    const recommendations = [];

    for (const dimension of dimensions) {
      const groups = new Map();
      for (const snapshot of snapshots) {
        const value = snapshot.contentAttributes?.[dimension.key];
        const metric = this.optionalNumber(snapshot.metrics?.[dimension.metric]);
        if (!value || value === 'unknown' || !Number.isFinite(metric)) continue;
        if (!groups.has(value)) groups.set(value, []);
        groups.get(value).push(metric);
      }
      const ranked = [...groups.entries()]
        .filter(([, values]) => values.length >= 3)
        .map(([value, values]) => ({ value, count: values.length, average: this.average(values) }))
        .sort((a, b) => b.average - a.average);
      if (ranked.length < 2 || ranked[0].average - ranked.at(-1).average < dimension.minimumDifference) continue;

      const best = ranked[0];
      const weakest = ranked.at(-1);
      const metricLabel = dimension.metric === 'ctr' ? 'CTR' : dimension.metric === 'retention' ? 'retention' : 'performance score';
      recommendations.push({
        category: dimension.key,
        title: `Favor ${this.readable(best.value)} over ${this.readable(weakest.value)} ${dimension.label}`,
        rationale: `${this.readable(best.value)} ${dimension.label} averaged ${this.metric(best.average, dimension.metric)} ${metricLabel} across ${best.count} videos versus ${this.metric(weakest.average, dimension.metric)} across ${weakest.count}.`,
        evidence: { dimension: dimension.key, metric: dimension.metric, best, weakest },
        proposedChange: { target: 'future_plans', dimension: dimension.key, prefer: best.value, deprioritize: weakest.value },
        confidence: best.count >= 5 && weakest.count >= 5 ? 'high' : 'moderate'
      });
    }
    return recommendations;
  }

  buildChannelRecommendations(snapshots) {
    const sufficientlyExposed = snapshots.filter(snapshot => {
      const impressions = this.optionalNumber(snapshot.metrics?.impressions);
      return impressions !== null && impressions >= 100;
    });
    if (sufficientlyExposed.length < 2) return [];

    const measuredCTR = sufficientlyExposed
      .map(item => this.optionalNumber(item.metrics?.ctr))
      .filter(value => value !== null);
    const measuredRetention = sufficientlyExposed
      .map(item => this.optionalNumber(item.metrics?.retention))
      .filter(value => value !== null);
    const recommendations = [];

    if (measuredCTR.length >= 3) {
      const averageCTR = this.average(measuredCTR);
      if (averageCTR < 4) {
        recommendations.push({
          category: 'packaging',
          title: 'Test new title and thumbnail packaging',
          rationale: `Channel CTR averaged ${averageCTR.toFixed(1)}% across ${measuredCTR.length} videos with measured CTR.`,
          evidence: { metric: 'ctr', average: averageCTR, sampleSize: measuredCTR.length, minimumImpressions: 100 },
          proposedChange: { target: 'review', experiment: 'title_thumbnail_variant' },
          confidence: measuredCTR.length >= 5 ? 'high' : 'medium'
        });
      }
    }
    if (measuredRetention.length >= 3) {
      const averageRetention = this.average(measuredRetention);
      if (averageRetention < 35) {
        recommendations.push({
          category: 'retention',
          title: 'Tighten hooks and early pacing',
          rationale: `Average view percentage was ${averageRetention.toFixed(1)}% across ${measuredRetention.length} videos with measured retention.`,
          evidence: { metric: 'retention', average: averageRetention, sampleSize: measuredRetention.length },
          proposedChange: { target: 'future_scripts', prefer: 'concise_hook_and_faster_opening' },
          confidence: measuredRetention.length >= 5 ? 'high' : 'medium'
        });
      }
    }
    return recommendations;
  }

  buildOutcomeRecommendations(snapshots, strategy = {}) {
    const goal = this.outcomeGoal(strategy);
    if (!goal || snapshots.length < 6) return [];
    const eligible = snapshots.filter(snapshot => this.outcomeMetricValue(snapshot, goal) !== null);
    if (eligible.length < 6) return [];
    const candidates = [];
    for (const dimension of ['pillar', 'format']) {
      const groups = new Map();
      for (const snapshot of eligible) {
        const value = snapshot.contentAttributes?.[dimension];
        const metric = this.outcomeMetricValue(snapshot, goal);
        if (!value || value === 'unknown' || value === 'mixed_or_unknown' || metric === null) continue;
        if (!groups.has(value)) groups.set(value, []);
        groups.get(value).push(metric);
      }
      const ranked = [...groups.entries()]
        .filter(([, values]) => values.length >= 3)
        .map(([value, values]) => ({ value, count: values.length, average: this.average(values) }))
        .sort((a, b) => b.average - a.average);
      if (ranked.length < 2) continue;
      const best = ranked[0];
      const weakest = ranked.at(-1);
      const meaningfulDifference = best.average - weakest.average;
      const relativeDifference = Math.abs(weakest.average) > 0
        ? meaningfulDifference / Math.abs(weakest.average)
        : best.average > 0 ? 1 : 0;
      if (meaningfulDifference <= 0 || relativeDifference < 0.2) continue;
      candidates.push({
        category: 'outcome_alignment',
        title: `Allocate more ${dimension} capacity to ${this.readable(best.value)}`,
        rationale: `${this.readable(best.value)} averaged ${this.formatOutcome(best.average, goal)} across ${best.count} videos versus ${this.formatOutcome(weakest.average, goal)} for ${this.readable(weakest.value)}, aligned to the configured ${goal.label.toLowerCase()} goal.`,
        evidence: { primaryKpi: goal.id, metric: goal.metric, dimension, best, weakest, minimumSamplesPerGroup: 2 },
        proposedChange: {
          target: 'future_plans', dimension, prefer: best.value, deprioritize: weakest.value,
          primaryKpi: goal.id, autoApply: false
        },
        confidence: best.count >= 4 && weakest.count >= 4 ? 'high' : 'medium'
      });
    }
    return candidates;
  }

  durationBucket(duration) {
    if (!duration || typeof duration !== 'string') return 'unknown';
    const match = duration.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
    if (!match) return 'unknown';
    const seconds = (Number(match[1] || 0) * 3600) + (Number(match[2] || 0) * 60) + Number(match[3] || 0);
    if (!seconds) return 'unknown';
    if (seconds < 60) return 'under_1m';
    if (seconds < 180) return '1_to_3m';
    if (seconds < 480) return '3_to_8m';
    if (seconds < 900) return '8_to_15m';
    return '15m_plus';
  }

  buildPerformanceInsights(snapshots, minimumSamples = 3, measurementWindow = '7d', options = {}) {
    const comparableSnapshots = this.preferredSnapshotPerVideo(snapshots, measurementWindow);
    const dimensions = [
      { key: 'pillar', label: 'content pillar' },
      { key: 'format', label: 'format' },
      { key: 'durationBucket', label: 'actual video duration' }
    ];
    const metricKeys = ['views', 'performanceScore', 'ctr', 'retention', 'engagementRate'];
    const recognizedSurfaces = [...new Set(comparableSnapshots
      .map(snapshot => this.snapshotSurface(snapshot))
      .filter(surface => surface !== 'unknown'))];
    const crossSurface = recognizedSurfaces.length > 1;
    const buildBreakdowns = cohortSnapshots => {
      const breakdowns = {};
      for (const dimension of dimensions) {
        const groups = new Map();
        for (const snapshot of cohortSnapshots) {
          const name = snapshot.contentAttributes?.[dimension.key];
          if (!name || ['unknown', 'mixed_or_unknown'].includes(name)) continue;
          if (!groups.has(name)) groups.set(name, []);
          groups.get(name).push(snapshot);
        }
        const cohorts = [...groups.entries()].map(([name, videos]) => {
          const metrics = {};
          for (const key of metricKeys) {
            const values = videos
              .map(video => this.optionalNumber(video.metrics?.[key]))
              .filter(value => value !== null);
            metrics[key] = {
              average: values.length ? Number(this.average(values).toFixed(2)) : null,
              median: values.length ? Number(this.median(values).toFixed(2)) : null,
              measuredVideos: values.length
            };
          }
          const sampleSize = videos.length;
          const rankable = metrics.performanceScore.average !== null || metrics.views.average !== null;
          return {
            name,
            videoCount: sampleSize,
            confidence: sampleSize >= 5 ? 'high' : sampleSize >= minimumSamples ? 'moderate' : 'exploratory',
            sufficientlySampled: sampleSize >= minimumSamples,
            rankable,
            metrics
          };
        }).sort((a, b) => {
          const scoreA = a.metrics.performanceScore.average;
          const scoreB = b.metrics.performanceScore.average;
          if (scoreA !== null && scoreB !== null) return scoreB - scoreA;
          return (b.metrics.views.average ?? -1) - (a.metrics.views.average ?? -1);
        });
        const reliable = cohorts.filter(cohort => cohort.sufficientlySampled && cohort.rankable);
        breakdowns[dimension.key] = {
          label: dimension.label,
          minimumSamples,
          cohorts,
          leader: reliable[0] || null,
          evidenceStatus: reliable.length ? 'sufficient' : 'insufficient'
        };
      }
      return breakdowns;
    };

    const surfaceBreakdowns = {};
    if (options.includeSurfaceBreakdowns !== false) {
      for (const surface of ['long_form', 'shorts']) {
        const surfaceSnapshots = comparableSnapshots.filter(snapshot => this.snapshotSurface(snapshot) === surface);
        if (surfaceSnapshots.length) {
          surfaceBreakdowns[surface] = this.buildPerformanceInsights(
            surfaceSnapshots, minimumSamples, measurementWindow, { includeSurfaceBreakdowns: false }
          ).dimensions;
        }
      }
    }
    const breakdowns = buildBreakdowns(comparableSnapshots);
    if (crossSurface) {
      for (const breakdown of Object.values(breakdowns)) {
        breakdown.leader = null;
        breakdown.evidenceStatus = 'cross_surface_not_comparable';
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      independentVideoCount: comparableSnapshots.length,
      measurementWindow,
      minimumSamplesPerCohort: minimumSamples,
      dimensions: breakdowns,
      surfaceBreakdowns,
      comparedSurfaces: recognizedSurfaces,
      rankingPolicy: crossSurface
        ? 'Combined descriptive cohorts are shown for continuity, but no pooled leader is declared across Shorts and long-form. Compare the separate surfaceBreakdowns instead.'
        : 'Cohorts are ordered by average performance score when available, otherwise by average views. A cohort without measured ranking metrics cannot be declared a leader.',
      evidencePolicy: 'Only non-simulated YouTube analytics are included. Each video counts once using the exact requested measurement window; shorter or rolling windows are not substituted. Cohorts below the minimum sample size are exploratory and are not declared winners.'
    };
  }

  async getSummary() {
    const [snapshots, recommendations, retentionSnapshots, strategy, experiments] = await Promise.all([
      this.db.listPerformanceSnapshots({ reliableOnly: true }),
      this.db.listLearningRecommendations({ limit: 50 }),
      this.db.listRetentionSnapshots ? this.db.listRetentionSnapshots({ limit: 12 }) : Promise.resolve([]),
      this.db.getChannelStrategy ? this.db.getChannelStrategy() : Promise.resolve(null),
      this.db.listGrowthExperiments ? this.db.listGrowthExperiments({ limit: 100 }) : Promise.resolve([])
    ]);
    const preferred = this.preferredSnapshotPerVideo(snapshots);
    const experimentFeedback = this.attachExperimentFeedback(recommendations, experiments);
    const appliedLearningFeedback = this.buildAppliedLearningFeedback(snapshots);
    const feedbackById = new Map(appliedLearningFeedback.map(item => [item.recommendationId, item]));
    const recommendationsWithFeedback = experimentFeedback.map(item => ({
      ...item,
      applicationFeedback: feedbackById.get(item.id) || {
        status: 'not_observed',
        measuredProductions: 0,
        interpretation: 'No mature, reliable 7-day performance evidence is linked to an application of this recommendation.'
      }
    }));
    return {
      measuredVideos: preferred.length,
      snapshotCount: snapshots.length,
      baseline: this.calculateBaseline(preferred),
      windows: snapshots.reduce((counts, snapshot) => {
        counts[snapshot.measurementWindow] = (counts[snapshot.measurementWindow] || 0) + 1;
        return counts;
      }, {}),
      recommendations: recommendationsWithFeedback,
      appliedLearningFeedback,
      approvedCount: recommendations.filter(item => item.status === 'approved').length,
      pendingCount: recommendations.filter(item => item.status === 'pending').length,
      lastMeasuredAt: snapshots[0]?.measuredAt || null,
      evidencePolicy: 'Only real YouTube analytics are eligible; simulated fallbacks are excluded. Cohort baselines, recommendations, and performance insights use the exact 7d publication-anchored daily window; 24h and 28d snapshots are reported separately and never substituted into the 7d cohort.',
      outcome: this.buildOutcomeSummary(preferred, strategy),
      performanceInsights: this.buildPerformanceInsights(preferred),
      retention: {
        snapshotCount: retentionSnapshots.length,
        longFormCount: retentionSnapshots.filter(item => item.surface === 'long_form').length,
        shortsCount: retentionSnapshots.filter(item => item.surface === 'shorts').length,
        snapshots: retentionSnapshots
      }
    };
  }

  attachExperimentFeedback(recommendations = [], experiments = []) {
    const byRecommendation = new Map();
    for (const experiment of experiments) {
      if (!experiment.recommendationId) continue;
      if (!byRecommendation.has(experiment.recommendationId)) byRecommendation.set(experiment.recommendationId, []);
      byRecommendation.get(experiment.recommendationId).push(experiment);
    }
    return recommendations.map(recommendation => {
      const linked = byRecommendation.get(recommendation.id) || [];
      const latest = linked[0] || null;
      if (!latest) return { ...recommendation, experimentFeedback: { status: 'not_tested', experimentCount: 0 } };
      const winner = (latest.arms || []).find(arm => arm.id === latest.winningArmId);
      const status = latest.status === 'adopted' ? 'validated_and_adopted'
        : latest.status === 'awaiting_winner' ? 'awaiting_operator_decision'
          : ['inconclusive', 'cancelled'].includes(latest.status) ? latest.status
            : ['running', 'approved', 'draft', 'action_required'].includes(latest.status) ? 'in_progress'
              : latest.status || 'unknown';
      return {
        ...recommendation,
        experimentFeedback: {
          status,
          experimentCount: linked.length,
          experimentId: latest.id,
          reason: latest.result?.reason || null,
          liftPercent: latest.result?.liftPercent !== null && latest.result?.liftPercent !== undefined && Number.isFinite(Number(latest.result.liftPercent))
            ? Number(latest.result.liftPercent) : null,
          winnerLabel: winner?.label || null,
          confidence: latest.result?.confidence || null,
          guardrailsPassed: latest.result?.guardrails?.passed === true,
          comparisonMethod: latest.result?.comparisonMethod || null,
          exposureAttribution: latest.result?.exposureAttribution || null,
          causalInterpretation: latest.result?.comparisonMethod === 'sequential_same_video_observational'
            ? 'observational_only_no_causal_winner'
            : null,
          armObservations: Array.isArray(latest.result?.arms) ? latest.result.arms : []
        }
      };
    });
  }

  outcomeGoal(strategy = {}) {
    if (!strategy) return null;
    const definitions = {
      views: { id: 'views', metric: 'views', label: 'Views', unit: 'count', aggregation: 'sum' },
      watch_hours: { id: 'watch_hours', metric: 'watchHours', label: 'Watch hours', unit: 'hours', aggregation: 'sum' },
      subscribers: { id: 'subscribers', metric: 'netSubscribers', label: 'Net subscribers', unit: 'count', aggregation: 'sum' },
      engagement: { id: 'engagement', metric: 'engagementRate', label: 'Engagement rate', unit: 'percent', aggregation: 'average' },
      revenue: { id: 'revenue', metric: 'estimatedRevenue', label: 'Estimated revenue', unit: 'currency', aggregation: 'sum' }
    };
    const definition = definitions[strategy.primary_kpi] || definitions.views;
    return {
      ...definition,
      targetValue: this.optionalNumber(strategy.target_value),
      windowDays: Math.max(7, Math.min(365, Number(strategy.target_window_days || 28))),
      currency: String(strategy.outcome_currency || 'USD').toUpperCase(),
      monthlyBudget: this.optionalNumber(strategy.monthly_budget),
      description: strategy.success_metric || ''
    };
  }

  buildOutcomeSummary(snapshots = [], strategy = null) {
    const goal = this.outcomeGoal(strategy);
    if (!goal) {
      return { configured: false, available: false, goal: null, evidencePolicy: 'Configure a channel strategy to activate outcome tracking.' };
    }
    const cutoff = Date.now() - goal.windowDays * 86400000;
    const recent = snapshots.filter(snapshot => {
      const measured = new Date(snapshot.measuredAt || snapshot.measured_at || 0).getTime();
      return Number.isFinite(measured) && measured >= cutoff;
    });
    const values = recent
      .map(snapshot => this.outcomeMetricValue(snapshot, goal))
      .filter(value => value !== null);
    const observed = values.length
      ? goal.aggregation === 'average' ? this.average(values) : values.reduce((sum, value) => sum + value, 0)
      : null;
    const progressPercent = observed !== null && goal.targetValue !== null && goal.targetValue > 0
      ? Number(Math.max(0, Math.min(999, (observed / goal.targetValue) * 100)).toFixed(1))
      : null;
    const sumAvailable = key => {
      const available = recent.map(snapshot => this.optionalNumber(snapshot.metrics?.[key])).filter(value => value !== null);
      return { value: available.length ? available.reduce((sum, value) => sum + value, 0) : null, count: available.length };
    };
    const subscribers = sumAvailable('netSubscribers');
    const watchHours = sumAvailable('watchHours');
    const revenueValues = recent
      .filter(snapshot => String(snapshot.metrics?.revenueCurrency || 'USD').toUpperCase() === goal.currency)
      .map(snapshot => this.optionalNumber(snapshot.metrics?.estimatedRevenue)).filter(value => value !== null);
    const revenue = { value: revenueValues.length ? revenueValues.reduce((sum, value) => sum + value, 0) : null, count: revenueValues.length };
    const costValues = recent
      .filter(snapshot => this.optionalNumber(snapshot.metrics?.productionCost) === 0 || String(snapshot.metrics?.costCurrency || '').toUpperCase() === goal.currency)
      .map(snapshot => this.optionalNumber(snapshot.metrics?.productionCost)).filter(value => value !== null);
    const cost = { value: costValues.length ? costValues.reduce((sum, value) => sum + value, 0) : null, count: costValues.length };
    const costsComplete = recent.length > 0 && cost.count === recent.length && recent.every(snapshot => snapshot.metrics?.costComplete === true);
    const roi = revenue.count === recent.length && costsComplete && cost.value > 0
      ? Number((((revenue.value - cost.value) / cost.value) * 100).toFixed(1))
      : null;
    const breakdowns = {};
    for (const dimension of ['pillar', 'format', 'provider']) {
      const groups = new Map();
      for (const snapshot of recent) {
        const name = snapshot.contentAttributes?.[dimension];
        const value = this.outcomeMetricValue(snapshot, goal);
        if (!name || name === 'unknown' || name === 'mixed_or_unknown' || value === null) continue;
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(value);
      }
      breakdowns[dimension] = [...groups.entries()]
        .map(([name, groupValues]) => ({
          name,
          count: groupValues.length,
          average: Number(this.average(groupValues).toFixed(3)),
          total: Number(groupValues.reduce((sum, value) => sum + value, 0).toFixed(3))
        }))
        .sort((a, b) => b.average - a.average);
    }
    return {
      configured: true,
      available: observed !== null,
      goal,
      observed: observed === null ? null : Number(observed.toFixed(3)),
      formattedObserved: observed === null ? 'Unavailable' : this.formatOutcome(observed, goal),
      progressPercent,
      snapshotCount: recent.length,
      measuredVideoCount: values.length,
      economics: {
        currency: goal.currency,
        netSubscribers: subscribers.value,
        watchHours: watchHours.value === null ? null : Number(watchHours.value.toFixed(3)),
        estimatedRevenue: revenue.value === null ? null : Number(revenue.value.toFixed(3)),
        knownProductionCost: cost.value === null ? null : Number(cost.value.toFixed(3)),
        costsComplete,
        roi,
        monthlyBudget: goal.monthlyBudget,
        budgetUsedPercent: goal.monthlyBudget > 0 && cost.value !== null
          ? Number(((cost.value / goal.monthlyBudget) * 100).toFixed(1))
          : null
      },
      coverage: {
        subscribers: { measured: subscribers.count, total: recent.length },
        revenue: { measured: revenue.count, total: recent.length },
        cost: { measured: cost.count, total: recent.length }
      },
      breakdowns,
      evidencePolicy: 'Only real YouTube measurements are included. Missing subscriber, revenue, or cost evidence remains unavailable and is never converted to zero.'
    };
  }

  captureRetention(retentionReport, context = {}, measurementWindow = 'rolling', exposure = {}) {
    return this.sceneRetention.capture(retentionReport, context, measurementWindow, exposure);
  }

  async getDueMeasurementWindows(video) {
    const published = new Date(video.published_at || video.publishedAt);
    if (Number.isNaN(published.getTime())) return [];
    const ageHours = (Date.now() - published.getTime()) / 3600000;
    const existing = await this.db.listPerformanceSnapshots({
      videoId: video.youtube_id || video.youtubeId,
      reliableOnly: true
    });
    const windows = new Set(existing.map(item => item.measurementWindow));
    return [
      ...(ageHours >= 24 && !windows.has('24h') ? ['24h'] : []),
      ...(ageHours >= 168 && !windows.has('7d') ? ['7d'] : []),
      ...(ageHours >= 672 && !windows.has('28d') ? ['28d'] : [])
    ];
  }

  measurementPeriod(publishedAt, measurementWindow) {
    const daysByWindow = { '24h': 1, '7d': 7, '28d': 28 };
    const days = daysByWindow[measurementWindow];
    if (!days || !publishedAt) return null;
    const start = new Date(publishedAt);
    if (Number.isNaN(start.getTime())) return null;
    const completedAt = new Date(start.getTime() + days * 86400000);
    // YouTube Analytics reports daily buckets, not exact publication-hour slices.
    // Query exactly N UTC calendar dates and wait until the full N-day age has elapsed.
    if (Date.now() < completedAt.getTime()) return null;
    const lastIncludedDay = new Date(start.getTime() + (days - 1) * 86400000);
    return {
      startDate: this.date(start),
      endDate: this.date(lastIncludedDay),
      windowDays: days,
      precision: 'utc_calendar_days'
    };
  }

  fingerprint(candidate) {
    const identity = {
      category: candidate.category,
      title: candidate.title,
      proposedChange: candidate.proposedChange
    };
    return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  }

  median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  average(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  }

  metric(value, metric) {
    return metric === 'performanceScore' ? value.toFixed(0) : `${value.toFixed(1)}%`;
  }

  number(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  optionalNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  outcomeMetricValue(snapshot, goal) {
    if (goal.id === 'revenue' && String(snapshot.metrics?.revenueCurrency || 'USD').toUpperCase() !== goal.currency) {
      return null;
    }
    return this.optionalNumber(snapshot.metrics?.[goal.metric]);
  }

  formatOutcome(value, goal) {
    if (goal.unit === 'currency') {
      try {
        return new Intl.NumberFormat('en-US', { style: 'currency', currency: goal.currency, maximumFractionDigits: 2 }).format(value);
      } catch (_error) {
        return `${goal.currency} ${Number(value).toFixed(2)}`;
      }
    }
    if (goal.unit === 'percent') return `${Number(value).toFixed(1)}%`;
    if (goal.unit === 'hours') return `${Number(value).toFixed(1)} hours`;
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value);
  }

  text(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(item => this.text(item)).join(' ');
    if (value && typeof value === 'object') return Object.values(value).map(item => this.text(item)).join(' ');
    return '';
  }

  wordCount(value) {
    return String(value).trim().split(/\s+/).filter(Boolean).length;
  }

  slug(value) {
    return String(value || 'unknown').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'unknown';
  }

  readable(value) {
    return String(value).replaceAll('_', ' ');
  }

  date(value) {
    return value.toISOString().slice(0, 10);
  }
}

module.exports = { ChannelLearningEngine };
