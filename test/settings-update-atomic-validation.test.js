const assert = require('node:assert/strict');
const { YouTubeAutomationAgent } = require('../index');

function createAgent() {
  const routes = new Map();
  const app = {
    use() {},
    get() {},
    post() {},
    patch() {},
    delete() {},
    put(route, ...handlers) { routes.set(route, handlers); }
  };
  const agent = Object.create(YouTubeAutomationAgent.prototype);
  agent.app = app;
  agent.db = {
    writes: [],
    setSetting: async (key, value) => { agent.db.writes.push([key, value]); },
    getAllSettings: async () => ({ saved: true })
  };
  agent.logger = { warn() {} };
  agent.agents = {};
  agent.setupAPI();
  return { agent, routes };
}

async function invoke(handler, body) {
  const response = {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; }
  };
  await handler({ body }, response);
  return response;
}

async function main() {
  const { agent, routes } = createAgent();
  const handler = routes.get('/api/settings').at(-1);

  const invalid = await invoke(handler, {
    approval_required: false,
    video_provider: 'not-a-provider'
  });
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(agent.db.writes, [], 'invalid settings must not leave earlier fields partially persisted');

  const valid = await invoke(handler, {
    approval_required: true,
    video_provider: 'cinecode',
    video_generation_mode: 'hybrid',
    video_clip_duration: 12,
    video_max_generated_seconds: 120
  });
  assert.equal(valid.statusCode, 200);
  assert.deepEqual(agent.db.writes, [
    ['approval_required', 'true'],
    ['video_provider', 'cinecode'],
    ['video_generation_mode', 'hybrid'],
    ['video_clip_duration', '12'],
    ['video_max_generated_seconds', '120']
  ]);
  process.stdout.write('Settings atomic validation tests passed\\n');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
