const assert = require('node:assert/strict');
const { Database } = require('../database/db');

async function run() {
  const db = new Database();
  await db.initialize();
  let ideaId;
  try {
    const idea = await db.createContentIdea({
      topic: 'Audience-led video idea lifecycle test',
      angle: 'Use real audience questions',
      style: 'tutorial',
      status: 'backlog',
      rationale: JSON.stringify({ source: 'weekly_trend_snapshot', score: 82 })
    });
    ideaId = idea.id;

    const linked = await db.linkContentIdeaToProduction(idea.id, 'production-lifecycle-test');
    assert.equal(linked.productionId, 'production-lifecycle-test');

    const recorded = await db.recordContentIdeaOutcome({
      productionId: 'production-lifecycle-test',
      videoId: 'youtube-lifecycle-test',
      measurementWindow: '7d',
      metrics: { views: 1200, ctr: 5.4, retention: 48, performanceScore: 78 },
      measuredAt: '2026-11-19T12:00:00.000Z',
      simulated: false
    });
    assert.equal(recorded.ideaId, idea.id);
    assert.equal(recorded.outcomeCount, 1);
    assert.equal(recorded.performanceScore, 78);

    const updated = await db.recordContentIdeaOutcome({
      productionId: 'production-lifecycle-test',
      videoId: 'youtube-lifecycle-test',
      measurementWindow: '7d',
      metrics: { views: 1500, ctr: 5.8, retention: 51, performanceScore: 83 },
      measuredAt: '2026-11-19T13:00:00.000Z',
      simulated: false
    });
    assert.equal(updated.outcomeCount, 1, 'same measurement window should update, not duplicate');

    const outcomes = await db.listContentIdeaOutcomes(idea.id);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].metrics.views, 1500);

    const saved = (await db.listContentIdeas()).find(item => item.id === idea.id);
    assert.equal(saved.status, 'performance_measured');
    const rationale = JSON.parse(saved.rationale);
    assert.equal(rationale.productionId, 'production-lifecycle-test');
    assert.equal(rationale.lifecycle.videoId, 'youtube-lifecycle-test');
    assert.equal(rationale.lifecycle.latestPerformanceScore, 83);

    const simulated = await db.recordContentIdeaOutcome({
      productionId: 'production-lifecycle-test',
      videoId: 'youtube-lifecycle-test',
      measurementWindow: '28d',
      metrics: { performanceScore: 99 },
      simulated: true
    });
    assert.equal(simulated, null, 'simulated analytics must never train idea outcomes');
  } finally {
    if (ideaId) {
      await db.executeQuery('DELETE FROM content_idea_outcomes WHERE idea_id = ?', [ideaId]);
      await db.executeQuery('DELETE FROM content_ideas WHERE id = ?', [ideaId]);
    }
    await db.close();
  }
  process.stdout.write('Content idea lifecycle tests passed\\n');
}

run().catch(error => {
  process.stderr.write(`Content idea lifecycle tests failed: ${error.stack || error.message}\\n`);
  process.exitCode = 1;
});
