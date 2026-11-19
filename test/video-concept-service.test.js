const assert = require('node:assert/strict');
const { VideoConceptService, extractJson, validateConcept } = require('../utils/video-concept-service');

const sampleConcept = (name = 'Original story') => ({
  name, premise: 'A new angle on the topic', audience: 'Curious viewers',
  emotionalObjective: 'Understand the subject', storyArc: ['hook', 'setup', 'payoff'],
  visualDirection: { style: 'cinematic', palette: 'warm', composition: 'close-up', backgrounds: 'original scenes' },
  audioDirection: { narration: 'calm', pacing: 'measured', music: 'subtle ambient mood' },
  subtitleDirection: { typography: 'clean sans', placement: 'lower safe area', animation: 'fade' },
  scenePlan: [{ scene: 1, purpose: 'Hook', visual: 'Original opening image', narrationIntent: 'Introduce the question', durationSeconds: 8 }, { scene: 2, purpose: 'Payoff', visual: 'Original resolution image', narrationIntent: 'Explain the answer', durationSeconds: 12 }]
});

async function run() {
  assert.equal(extractJson('```json\n{"ok":true}\n```').ok, true);
  assert.throws(() => validateConcept({ name: 'incomplete' }), /missing required field/);
  assert.throws(() => validateConcept({ ...sampleConcept(), scenePlan: [] }), /at least two scenes/);

  const records = new Map();
  const db = {
    async saveVideoConcept(record) { records.set(record.id, record); return record; },
    async getVideoConcept(id) { return records.get(id) || null; },
    async getChannelProfile() { return { channel_name: 'Test channel', target_audience: 'Test audience' }; },
    async approveVideoConcept(id) { const item = records.get(id); if (!item) return null; item.status = 'approved'; return item; }
  };
  let lastPrompt = '';
  const service = new VideoConceptService(db, {
    model: 'qwen3.5:4b',
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      lastPrompt = body.messages[0].content;
      const revised = lastPrompt.includes('REVISION FEEDBACK');
      return { ok: true, json: async () => ({ message: { content: JSON.stringify(sampleConcept(revised ? 'Revised story' : 'First story')) } }) };
    }
  });

  const proposed = await service.propose({ topic: 'A sample topic', direction: 'Use a documentary tone', profile: { channel_name: 'My channel' } });
  assert.equal(proposed.status, 'pending');
  assert.equal(proposed.concept.name, 'First story');
  assert.match(lastPrompt, /My channel/);
  assert.match(lastPrompt, /A sample topic/);
  assert.equal(records.size, 1);

  const revised = await service.revise({ conceptId: proposed.id, feedback: 'Keep the opening; improve the ending' });
  assert.equal(revised.revisionOf, proposed.id);
  assert.equal(revised.status, 'pending');
  assert.match(lastPrompt, /Keep the opening/);
  assert.match(lastPrompt, /First story/);

  const approved = await service.approve(revised.id);
  assert.equal(approved.status, 'approved');
  await assert.rejects(() => service.revise({ conceptId: revised.id, feedback: 'Change it' }), /immutable/);

  const unavailable = new VideoConceptService(db, { fetch: async () => { throw new Error('ECONNREFUSED'); } });
  await assert.rejects(() => unavailable.propose({ topic: 'Offline test' }), /No cloud or paid fallback was attempted/);
  process.stdout.write('Video concept service tests passed\\n');
}

run().catch(error => { process.stderr.write('Video concept service tests failed: ' + (error.stack || error.message) + '\\n'); process.exitCode = 1; });