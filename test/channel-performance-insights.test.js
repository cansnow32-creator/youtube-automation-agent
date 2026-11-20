const assert = require('node:assert/strict');
const { Database } = require('../database/db');
const { ChannelLearningEngine } = require('../utils/channel-learning-engine');

async function run() {
  const db = new Database();
  await db.initialize();
  const videoIds = ['cohort-video-1', 'cohort-video-2', 'cohort-video-3', 'cohort-video-simulated'];
  const learning = new ChannelLearningEngine(db);
  const feedback = learning.attachExperimentFeedback([
    { id: 'rec-tested', title: 'Improve packaging' },
    { id: 'rec-untested', title: 'Improve hooks' }
  ], [
    {
      id: 'exp-1', recommendationId: 'rec-tested', status: 'adopted', winningArmId: 'arm-b',
      result: { reason: 'Variant cleared thresholds.', liftPercent: 12.5, confidence: 'high', guardrails: { passed: true } },
      arms: [{ id: 'arm-b', label: 'Variant B' }]
    }
  ]);
  assert.equal(feedback[0].experimentFeedback.status, 'validated_and_adopted');
  assert.equal(feedback[0].experimentFeedback.winnerLabel, 'Variant B');
  assert.equal(feedback[0].experimentFeedback.liftPercent, 12.5);
  assert.equal(feedback[1].experimentFeedback.status, 'not_tested',
    'recommendations without a linked controlled experiment must not be called successful');

  try {
    const base = {
      productionId: null,
      publishedAt: '2026-11-01T00:00:00.000Z',
      baseline: {},
      deltas: {},
      confidence: 'high',
      contentAttributes: {
        pillar: 'education',
        format: 'tutorial',
        durationBucket: '3_to_8m',
        surface: 'long_form'
      }
    };
    for (let index = 0; index < 3; index++) {
      await db.savePerformanceSnapshot({
        ...base,
        videoId: videoIds[index],
        measurementWindow: '7d',
        measuredAt: `2026-11-${10 + index}T12:00:00.000Z`,
        metrics: {
          views: 1000 + (index * 100),
          performanceScore: 80 + index,
          ctr: index === 0 ? null : 5 + index,
          retention: 45 + index,
          engagementRate: null
        },
        simulated: false
      });
    }
    await db.savePerformanceSnapshot({
      ...base,
      videoId: videoIds[0],
      measurementWindow: '24h',
      measuredAt: '2026-11-10T11:00:00.000Z',
      metrics: { views: 10, performanceScore: 1, ctr: 1, retention: 1 },
      simulated: false
    });
    await db.savePerformanceSnapshot({
      ...base,
      videoId: videoIds[3],
      measurementWindow: '7d',
      metrics: { views: 999999, performanceScore: 100, ctr: 99, retention: 99 },
      simulated: true
    });

    const realSnapshots = await db.listPerformanceSnapshots({ reliableOnly: true });
    const preferred = learning.preferredSnapshotPerVideo(realSnapshots);
    assert.equal(preferred.length, 3, 'one independent sample per real video; duplicate windows are deduplicated');

    const report = learning.buildPerformanceInsights(preferred);
    assert.equal(report.independentVideoCount, 3);
    assert.equal(report.dimensions.pillar.leader.name, 'education');
    assert.equal(report.dimensions.pillar.leader.videoCount, 3);
    assert.equal(report.dimensions.format.leader.name, 'tutorial');
    assert.equal(report.dimensions.durationBucket.leader.name, '3_to_8m');
    assert.equal(report.dimensions.pillar.leader.metrics.ctr.measuredVideos, 2,
      'missing CTR values are not converted to zero');
    assert.equal(report.dimensions.pillar.leader.metrics.ctr.average, 6.5);
    assert.equal(report.dimensions.pillar.leader.metrics.engagementRate.average, null);
    assert.equal(report.dimensions.pillar.leader.confidence, 'moderate');

    // Three videos in a cohort do not make it rankable when only one has a measured score
    // and the fallback views metric is also missing for the other videos.
    const sparseMetricSnapshots = [
      { videoId: 'sparse-1', measurementWindow: '7d', metrics: { views: 100, performanceScore: 80 }, contentAttributes: { pillar: 'sparse' } },
      { videoId: 'sparse-2', measurementWindow: '7d', metrics: { views: null, performanceScore: null }, contentAttributes: { pillar: 'sparse' } },
      { videoId: 'sparse-3', measurementWindow: '7d', metrics: { views: null, performanceScore: null }, contentAttributes: { pillar: 'sparse' } }
    ];
    const sparseReport = learning.buildPerformanceInsights(sparseMetricSnapshots, 3, '7d');
    assert.equal(sparseReport.dimensions.pillar.rankingMetric, null);
    assert.equal(sparseReport.dimensions.pillar.cohorts[0].rankable, false);
    assert.equal(sparseReport.dimensions.pillar.leader, null,
      'cohort size cannot substitute for missing measured ranking metrics');

    const exploratory = learning.buildPerformanceInsights(preferred.slice(0, 2));
    assert.equal(exploratory.dimensions.pillar.leader, null,
      'cohorts below three independent videos are not declared winners');
    assert.equal(exploratory.dimensions.pillar.cohorts[0].confidence, 'exploratory');

    // A 24h-only video must not be substituted into a 7d cohort.
    const shortOnly = {
      videoId: 'short-window-only',
      measurementWindow: '24h',
      measuredAt: '2026-11-20T12:00:00.000Z',
      metrics: { views: 500000, performanceScore: 100, ctr: 99, retention: 99 },
      contentAttributes: { pillar: 'viral', format: 'shorts', durationBucket: 'under_1m' },
      simulated: false
    };
    assert.equal(learning.preferredSnapshotPerVideo([...realSnapshots, shortOnly], '7d')
      .some(item => item.videoId === 'short-window-only'), false);
    assert.equal(learning.buildPerformanceInsights([...realSnapshots, shortOnly], 3, '7d').independentVideoCount, 3,
      'shorter-window data must not inflate the 7d cohort');

    const dueEngine = new ChannelLearningEngine({
      listPerformanceSnapshots: async () => []
    });
    const twentyNineDaysAgo = new Date(Date.now() - 29 * 86400000).toISOString();
    assert.deepEqual(
      await dueEngine.getDueMeasurementWindows({ youtube_id: 'mature-video', published_at: twentyNineDaysAgo }),
      ['24h', '7d', '28d']
    );
    const tenDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString();
    assert.deepEqual(
      await dueEngine.getDueMeasurementWindows({ youtube_id: 'ten-day-video', published_at: tenDaysAgo }),
      ['24h', '7d']
    );
    const completed28d = dueEngine.measurementPeriod(twentyNineDaysAgo, '28d');
    assert.ok(completed28d, 'a mature 28d period should be available');
    assert.equal(
      (new Date(completed28d.endDate) - new Date(completed28d.startDate)) / 86400000,
      27,
      '28 daily buckets span 27 date boundaries'
    );
    assert.equal(completed28d.windowDays, 28);
    assert.equal(completed28d.precision, 'utc_calendar_days');
    assert.equal(
      dueEngine.measurementPeriod(tenDaysAgo, '28d'),
      null,
      'a partial 28d period must not be labeled as complete'
    );

    const longitudinal = learning.buildLongitudinalInsights([
      { videoId: 'long-1', measurementWindow: '24h', simulated: false, metrics: { views: 120, watchHours: 12, ctr: 5, retention: 40 } },
      { videoId: 'long-1', measurementWindow: '7d', simulated: false, metrics: { views: 700, watchHours: 70, ctr: 4, retention: 35 } },
      { videoId: 'long-1', measurementWindow: '28d', simulated: false, metrics: { views: 2800, watchHours: 280, ctr: 3, retention: 30 } },
      { videoId: 'long-2', measurementWindow: '7d', simulated: false, metrics: { views: null, watchHours: null, ctr: null, retention: null } },
      { videoId: 'fake', measurementWindow: '28d', simulated: true, metrics: { views: 999999, watchHours: 999, ctr: 99, retention: 99 } }
    ]);
    assert.equal(longitudinal.windows['24h'].metrics.views.medianPerDay, 120);
    assert.equal(longitudinal.windows['7d'].metrics.views.medianPerDay, 100);
    assert.equal(longitudinal.windows['28d'].metrics.views.medianPerDay, 100);
    assert.equal(longitudinal.windows['7d'].metrics.views.measuredVideos, 1,
      'missing values must not be treated as zero or counted as measured');
    assert.equal(longitudinal.windows['28d'].videoCount, 1,
      'simulated snapshots must not enter longitudinal summaries');
    assert.equal(longitudinal.windows['28d'].rateMetrics.ctr.median, 3,
      'rate metrics are displayed independently, not normalized as additive totals');
    assert.match(longitudinal.interpretation, /nested cumulative/);

    assert.equal(learning.durationBucket('PT45S'), 'under_1m');
    assert.equal(learning.durationBucket('PT2M10S'), '1_to_3m');
    assert.equal(learning.durationBucket('PT6M'), '3_to_8m');
    assert.equal(learning.durationBucket('PT12M'), '8_to_15m');
    assert.equal(learning.durationBucket('PT20M'), '15m_plus');
    assert.equal(learning.durationBucket(null), 'unknown');

  } finally {
    for (const videoId of videoIds) {
      await db.executeQuery('DELETE FROM performance_snapshots WHERE video_id = ?', [videoId]);
    }
    await db.close();
  }
  process.stdout.write('Channel performance insight tests passed\\n');
}

run().catch(error => {
  process.stderr.write(`Channel performance insight tests failed: ${error.stack || error.message}\\n`);
  process.exitCode = 1;
});
