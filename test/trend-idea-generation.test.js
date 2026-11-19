const assert = require('node:assert/strict');
const { Database } = require('../database/db');
const { ContentStrategyAgent } = require('../agents/content-strategy-agent');
const { scoreTrendIdeas } = require('../utils/trend-idea-ranker');

async function run() {
  const db = new Database();
  await db.initialize();
  const ideaIds = [];
  const snapshotIds = [];
  const originalFetch = global.fetch;
  const originalModel = process.env.OLLAMA_MODEL;
  const originalUrl = process.env.OLLAMA_BASE_URL;

  try {
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
        format: 'tutorial'
      }
    ], snapshot.topics, {
      objective: 'Help video creators improve their workflow',
      audience: 'beginner video creators',
      contentPillars: ['AI video tools', 'editing tutorials']
    }, [{
      simulated: false,
      contentAttributes: { topic: 'AI video editing' },
      metrics: { performanceScore: 86, ctr: 6, retention: 55 }
    }]);
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0].scoreBreakdown.historicalPerformance, 86);
    assert.equal(ranked[0].scoreBreakdown.historicalSampleSize, 1);

    process.env.OLLAMA_MODEL = 'qwen3.5:4b';
    process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
    global.fetch = async (url, options) => {
      assert.match(url, /\/api\/chat$/);
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'qwen3.5:4b');
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

    const strategy = new ContentStrategyAgent(db, {});
    const result = await strategy.generateTrendIdeasFromSnapshot({ snapshot });
    assert.equal(result.status, 'success');
    assert.equal(result.createdCount, 1);
    assert.equal(result.ideas[0].topic, 'A beginner workflow for AI video editing');

    const savedIdeas = await db.listContentIdeas();
    const created = savedIdeas.find(item => item.topic === result.ideas[0].topic);
    assert.ok(created, 'generated idea should be persisted in the existing content ideas table');
    ideaIds.push(created.id);
    const rationale = JSON.parse(created.rationale);
    assert.equal(rationale.generatedBy, 'ollama');
    assert.equal(rationale.snapshotId, snapshot.id);
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
    if (snapshotIds.length) {
      await db.executeQuery(`DELETE FROM trend_snapshots WHERE id IN (${snapshotIds.map(() => '?').join(',')})`, snapshotIds);
    }
    await db.close();
  }

  process.stdout.write('Trend idea generation tests passed\\n');
}

run().catch(error => {
  process.stderr.write(`Trend idea generation tests failed: ${error.stack || error.message}\\n`);
  process.exitCode = 1;
});
