const fs = require('fs').promises;
const { Logger } = require('./logger');

const ACTIVE_STATUSES = new Set(['draft', 'approved', 'running', 'awaiting_winner', 'action_required']);

class GrowthExperimentService {
  constructor(db, analytics, publishing, options = {}) {
    this.db = db;
    this.analytics = analytics;
    this.publishing = publishing;
    this.logger = options.logger || new Logger('GrowthExperiments');
    this.now = options.now || (() => new Date());
    this.activeRefreshes = new Set();
  }

  error(message, status = 400, code = 'EXPERIMENT_INVALID') {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    return error;
  }

  async create(_input = {}) {
    throw this.error(
      'Automated packaging experiments are paused. The current integration cannot randomize viewers or verify per-variant exposure; use YouTube Studio native Test & Compare manually until a supported results integration exists.',
      409,
      'EXPERIMENT_RANDOMIZATION_UNAVAILABLE'
    );
  }

  async approve(id, input = {}) {
    const experiment = await this.requireExperiment(id);
    if (experiment.status !== 'draft') throw this.error('Only a draft experiment can be approved', 409);
    if (input.confirmed !== true) throw this.error('Confirm the complete experiment plan before approval', 409, 'EXPERIMENT_CONFIRMATION_REQUIRED');
    return this.db.updateGrowthExperiment(id, { status: 'approved', approvedAt: this.isoNow() });
  }

  async start(id, _input = {}) {
    await this.requireExperiment(id);
    throw this.error(
      'This legacy sequential experiment cannot be started because it changes live packaging without randomized viewer assignment.',
      409,
      'EXPERIMENT_RANDOMIZATION_UNAVAILABLE'
    );
  }

  async refresh(id, options = {}) {
    if (this.activeRefreshes.has(id)) {
      throw this.error('This experiment is already refreshing', 409, 'EXPERIMENT_BUSY');
    }
    this.activeRefreshes.add(id);
    try {
      return await this.refreshUnlocked(id, options);
    } finally {
      this.activeRefreshes.delete(id);
    }
  }

  async refreshUnlocked(id, options = {}) {
    const experiment = await this.requireExperiment(id);
    if (experiment.status !== 'running') throw this.error('Only a running experiment can collect evidence', 409);
    const arm = experiment.arms.find(candidate => candidate.id === experiment.currentArmId);
    const control = experiment.arms.find(candidate => candidate.isControl);
    if (!control) {
      throw this.error('The running legacy experiment has no control package; manual operator recovery is required.', 409, 'EXPERIMENT_CONTROL_MISSING');
    }
    // Stop legacy sequential rotations and restore the original package once.
    // Do not collect or compare video-level metrics as if they were arm-level.
    try {
      await this.applyArm(experiment, control, arm || control);
    } catch (error) {
      await this.failRestore(experiment, error, {
        comparisonMethod: 'sequential_same_video_observational',
        exposureAttribution: 'unavailable_from_youtube_analytics',
        winnerArmId: null,
        reason: 'Legacy experiment was stopped, but restoring the control package failed.'
      });
      throw error;
    }
    const result = {
      primaryMetric: 'ctr',
      comparisonMethod: 'sequential_same_video_observational',
      exposureAttribution: 'unavailable_from_youtube_analytics',
      winnerArmId: null,
      confidence: 'unverified',
      reason: 'Automatically stopped: sequential live package rotations cannot provide randomized arm-level exposure. The original control package was restored.',
      guardrails: { passed: false, evaluated: false },
      arms: []
    };
    return this.db.updateGrowthExperiment(id, {
      status: 'inconclusive',
      currentArmId: null,
      winningArmId: null,
      result,
      completedAt: this.isoNow()
    });
    if (!arm) throw this.error('The running experiment has no active arm', 409, 'EXPERIMENT_STATE_INVALID');
    const capturedAt = this.isoNow();
    const evidence = await this.captureMetrics(experiment.videoId);
    await this.db.saveExperimentSample({
      experimentId: experiment.id, armId: arm.id,
      metrics: evidence.metrics, trafficSources: evidence.trafficSources, capturedAt
    });

    const elapsedHours = (this.now().getTime() - new Date(arm.startedAt).getTime()) / 3600000;
    if (!options.forceAdvance && elapsedHours < experiment.armDurationHours) {
      return this.db.getGrowthExperiment(id);
    }

    const armResult = {
      observationOnly: true,
      latestVideoMetrics: evidence.metrics,
      measurementPeriod: evidence.measurementPeriod || null,
      interpretation: 'Video-level snapshot during this sequential arm; not attributable to this arm.'
    };
    await this.db.updateExperimentArm(arm.id, {
      status: 'completed', finalMetrics: evidence.metrics, result: armResult, endedAt: capturedAt
    });
    const next = experiment.arms.find(candidate => candidate.index === arm.index + 1);
    if (next) {
      await this.db.updateExperimentArm(next.id, {
        status: 'running', baselineMetrics: evidence.metrics, startedAt: capturedAt
      });
      await this.db.saveExperimentSample({
        experimentId: experiment.id, armId: next.id,
        metrics: evidence.metrics, trafficSources: evidence.trafficSources, capturedAt
      });
      await this.db.updateGrowthExperiment(id, { currentArmId: next.id });
      try {
        await this.applyArm(experiment, next, arm);
      } catch (error) {
        await this.failRestore(experiment, error);
        throw error;
      }
      return this.db.getGrowthExperiment(id);
    }

    const completed = await this.db.getGrowthExperiment(id);
    const result = await this.evaluate(completed);
    const control = completed.arms.find(candidate => candidate.isControl);
    try {
      await this.applyArm(completed, control, arm);
    } catch (error) {
      await this.failRestore(completed, error, result);
      throw error;
    }
    return this.db.updateGrowthExperiment(id, {
      status: result.winnerArmId ? 'awaiting_winner' : 'inconclusive',
      currentArmId: null,
      winningArmId: result.winnerArmId || null,
      result,
      completedAt: capturedAt
    });
  }

  async adoptWinner(id, input = {}) {
    const experiment = await this.requireExperiment(id);
    if (experiment.status !== 'awaiting_winner' || !experiment.winningArmId) {
      throw this.error('This experiment has no evidence-backed winner to adopt', 409);
    }
    if (experiment.result?.comparisonMethod !== 'randomized_arm_level' ||
        experiment.result?.exposureAttribution !== 'verified_randomized') {
      throw this.error(
        'This experiment has no verified randomized arm-level exposure data; sequential observations cannot be adopted as a winner.',
        409,
        'EXPERIMENT_CAUSAL_EVIDENCE_REQUIRED'
      );
    }
    if (input.confirmed !== true) throw this.error('Confirm the winner before changing live YouTube packaging', 409, 'EXPERIMENT_CONFIRMATION_REQUIRED');
    const winner = experiment.arms.find(arm => arm.id === experiment.winningArmId);
    const control = experiment.arms.find(arm => arm.isControl);
    await this.applyArm(experiment, winner, control);
    const sourceBundle = await this.db.getProductionBundle(experiment.productionId);
    const sourcePackaging = sourceBundle?.editorData?.packagingExperiment;
    const winningTitleIndex = (sourcePackaging?.titleVariants || [])
      .findIndex(variant => variant.title === winner.title);
    const winningThumbnailPattern = winningTitleIndex >= 0
      ? sourcePackaging.thumbnailVariants?.[winningTitleIndex]?.label || null
      : null;
    const recommendation = await this.db.saveLearningRecommendation({
      fingerprint: `growth-experiment:${experiment.id}:winner`,
      category: 'packaging_experiment',
      title: `Reuse the ${winner.label} packaging pattern`,
      rationale: `${winner.label} produced ${winner.result.ctr.toFixed(2)}% CTR across ${winner.result.impressions} qualified impressions in a controlled test.`,
      evidence: {
        experimentId: experiment.id,
        videoId: experiment.videoId,
        winnerArmId: winner.id,
        liftPercent: experiment.result.liftPercent,
        zScore: experiment.result.zScore,
        guardrails: experiment.result.guardrails
      },
      proposedChange: {
        target: 'future_packaging',
        experiment: 'validated_title_thumbnail_pattern',
        winningTitle: winner.title,
        winningThumbnailPattern,
        winningArmLabel: winner.label,
        hypothesis: experiment.hypothesis,
        autoApply: false
      },
      confidence: experiment.result.confidence || 'medium'
    });
    await this.db.reviewLearningRecommendation(recommendation.id, 'approved');
    return this.db.updateGrowthExperiment(id, {
      status: 'adopted', adoptedAt: this.isoNow(), currentArmId: winner.id
    });
  }

  async cancel(id, input = {}) {
    const experiment = await this.requireExperiment(id);
    if (!['draft', 'approved', 'running', 'action_required'].includes(experiment.status)) {
      throw this.error('This experiment can no longer be cancelled', 409);
    }
    if (input.confirmed !== true) throw this.error('Confirm cancellation before restoring the control packaging', 409, 'EXPERIMENT_CONFIRMATION_REQUIRED');
    if (['running', 'action_required'].includes(experiment.status)) {
      const control = experiment.arms.find(arm => arm.isControl);
      const current = experiment.arms.find(arm => arm.id === experiment.currentArmId) || control;
      await this.applyArm(experiment, control, current);
    }
    return this.db.updateGrowthExperiment(id, {
      status: 'cancelled', currentArmId: null, cancelledAt: this.isoNow()
    });
  }

  async refreshDue() {
    const running = await this.db.listGrowthExperiments({ status: 'running', limit: 50 });
    let refreshed = 0;
    let failed = 0;
    for (const experiment of running) {
      const samples = await this.db.listExperimentSamples(experiment.id, 250);
      const latest = samples.at(-1);
      const ageHours = latest ? (this.now().getTime() - new Date(latest.capturedAt).getTime()) / 3600000 : Infinity;
      if (ageHours < 4) continue;
      try {
        await this.refresh(experiment.id);
        refreshed++;
      } catch (error) {
        failed++;
        this.logger.error(`Growth experiment refresh failed for ${experiment.id}: ${error.message}`);
      }
    }
    return { running: running.length, refreshed, failed };
  }

  async getSummary() {
    const experiments = await this.db.listGrowthExperiments({ limit: 25 });
    const rows = await this.db.getAllRows(
      `SELECT p.id AS production_id, ps.title, ps.youtube_id, cr.editor_data
       FROM publish_schedule ps
       JOIN productions p ON p.id = ps.production_id
       JOIN content_reviews cr ON cr.production_id = p.id
       WHERE ps.status = 'published' AND ps.youtube_id IS NOT NULL
       ORDER BY ps.published_at DESC LIMIT 50`
    );
    const activeProductionIds = new Set(experiments.filter(item => ACTIVE_STATUSES.has(item.status)).map(item => item.productionId));
    const candidates = (await Promise.all(rows.map(async row => {
      const packaging = this.parseJSON(row.editor_data, {}).packagingExperiment;
      if (!packaging?.sourceRecommendationId || activeProductionIds.has(row.production_id)) return null;
      const recommendation = await this.db.getLearningRecommendation(packaging.sourceRecommendationId);
      if (recommendation?.status !== 'approved') return null;
      return { productionId: row.production_id, videoId: row.youtube_id, title: row.title };
    }))).filter(Boolean);
    return {
      experiments,
      candidates,
      activeCount: experiments.filter(item => item.status === 'running').length,
      awaitingDecisionCount: experiments.filter(item => item.status === 'awaiting_winner').length,
      evidencePolicy: 'Automated packaging experiments are paused. The current integration cannot randomize viewers or verify arm-level exposure; legacy running experiments are restored to control and marked inconclusive.'
    };
  }

  async evaluate(experiment) {
    const samples = await this.db.listExperimentSamples(experiment.id, 1000);
    const arms = experiment.arms.map(arm => {
      const armSamples = samples.filter(sample => sample.armId === arm.id);
      const first = armSamples[0];
      const last = armSamples.at(-1);
      const trafficShift = this.trafficSourceShift(first?.trafficSources, last?.trafficSources);
      const latestMetrics = last?.metrics || {};
      return {
        ...arm,
        result: {
          observationOnly: true,
          sampleCount: armSamples.length,
          latestVideoImpressions: this.optionalMetric(latestMetrics.impressions),
          latestVideoCtr: this.optionalMetric(latestMetrics.ctr),
          latestVideoClicks: this.optionalMetric(latestMetrics.clicks),
          latestVideoViews: this.optionalMetric(latestMetrics.views),
          measurementPeriod: latestMetrics.measurementPeriod || null,
          trafficSourceShiftPoints: trafficShift
        }
      };
    });
    await Promise.all(arms.map(arm => this.db.updateExperimentArm(arm.id, { result: arm.result })));

    // The current workflow rotates packages sequentially on one video. YouTube
    // Analytics reports video-level metrics, not randomized per-arm exposure.
    // A z-test over these time periods would falsely imply independent,
    // randomized samples, so no arm can be declared a causal winner here.
    const result = {
      primaryMetric: 'ctr',
      comparisonMethod: 'sequential_same_video_observational',
      exposureAttribution: 'unavailable_from_youtube_analytics',
      minImpressions: experiment.minImpressions,
      armsWithObservations: arms.filter(arm => arm.result.sampleCount > 0).length,
      totalArms: arms.length,
      winnerArmId: null,
      confidence: 'unverified',
      reason: 'Observational only: YouTube Analytics does not attribute impressions and clicks to the sequential title/thumbnail arms. A CTR difference cannot establish an A/B winner or causal lift.',
      guardrails: {
        passed: false,
        evaluated: false,
        reason: 'Retention and traffic-mix guardrails cannot correct for missing randomized arm-level exposure.'
      },
      arms: arms.map(arm => ({
        armId: arm.id,
        label: arm.label,
        isControl: arm.isControl,
        sampleCount: arm.result.sampleCount,
        observedVideoImpressions: arm.result.latestVideoImpressions,
        observedVideoCtr: arm.result.latestVideoCtr,
        observedVideoClicks: arm.result.latestVideoClicks,
        observedVideoViews: arm.result.latestVideoViews,
        measurementPeriod: arm.result.measurementPeriod,
        trafficSourceShiftPoints: this.optionalMetric(arm.result.trafficSourceShiftPoints)
      }))
    };
    return result;
  }

  optionalMetric(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  trafficSourceShift(start = [], end = []) {
    const toMap = sources => new Map((sources || []).map(source => [source.source, Number(source.percentage || 0)]));
    const a = toMap(start);
    const b = toMap(end);
    const keys = new Set([...a.keys(), ...b.keys()]);
    return Number(Math.max(0, ...[...keys].map(key => Math.abs((b.get(key) || 0) - (a.get(key) || 0)))).toFixed(2));
  }

  async captureMetrics(videoId) {
    const report = await this.analytics.analyzeVideoPerformance(videoId, { measurementWindow: 'rolling' });
    if (!report || report.analytics?.simulated) {
      throw this.error('Real YouTube analytics are unavailable; simulated evidence cannot advance an experiment', 409, 'EXPERIMENT_EVIDENCE_UNAVAILABLE');
    }
    const views = report.analytics?.views || {};
    const impressions = this.optionalMetric(views.totalImpressions);
    const ctr = this.optionalMetric(views.averageCTR);
    if (impressions === null || impressions <= 0 || ctr === null) {
      throw this.error(
        'YouTube Analytics did not return measured impressions and CTR; incomplete metrics cannot be treated as zero.',
        409,
        'EXPERIMENT_METRICS_INCOMPLETE'
      );
    }
    const clicks = impressions * ctr / 100;
    const watchTime = report.analytics?.watchTime || {};
    const outcomes = report.analytics?.outcomes || {};
    return {
      metrics: {
        impressions,
        clicks: Number(clicks.toFixed(3)),
        ctr,
        views: this.optionalMetric(views.totalViews),
        watchMinutes: this.optionalMetric(watchTime.totalWatchTime),
        averageViewPercentage: this.optionalMetric(watchTime.averageViewPercentage),
        engagementRate: this.optionalMetric(report.analytics?.engagement?.engagementRate),
        netSubscribers: this.optionalMetric(outcomes.netSubscribers),
        estimatedRevenue: this.optionalMetric(outcomes.estimatedRevenue),
        measurementPeriod: report.analytics?.period || null
      },
      trafficSources: report.analytics?.trafficSources?.sources || [],
      measurementPeriod: report.analytics?.period || null
    };
  }

  async applyArm(experiment, arm, previousArm) {
    if (!arm) throw this.error('Experiment arm is missing', 409, 'EXPERIMENT_STATE_INVALID');
    await this.publishing.applyVideoPackaging(experiment.videoId, {
      title: arm.title,
      thumbnailPath: arm.thumbnailPath
    }, previousArm ? {
      title: previousArm.title,
      thumbnailPath: previousArm.thumbnailPath
    } : null);
  }

  async failRestore(experiment, error, result = {}) {
    await this.db.updateGrowthExperiment(experiment.id, {
      status: 'action_required',
      result: { ...result, restoreError: error.message },
      completedAt: this.isoNow()
    });
  }

  async requireExperiment(id) {
    const experiment = await this.db.getGrowthExperiment(String(id || ''));
    if (!experiment) throw this.error('Growth experiment not found', 404, 'EXPERIMENT_NOT_FOUND');
    return experiment;
  }

  async requireFile(filePath, message) {
    try {
      const stats = await fs.stat(filePath);
      if (!stats.isFile() || stats.size === 0) throw new Error('empty');
    } catch (_error) {
      throw this.error(message, 409, 'EXPERIMENT_ASSET_MISSING');
    }
  }

  isoNow() {
    return this.now().toISOString();
  }

  parseJSON(value, fallback) {
    try { return JSON.parse(value || ''); } catch (_error) { return fallback; }
  }
}

module.exports = { GrowthExperimentService };
