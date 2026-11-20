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

    const exploratory = learning.buildPerformanceInsights(preferred.slice(0, 2));
    assert.equal(exploratory.dimensions.pillar.leader, null,
      'cohorts below three independent videos are not declared winners');
    assert.equal(exploratory.dimensions.pillar.cohorts[0].confidence, 'exploratory');

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
