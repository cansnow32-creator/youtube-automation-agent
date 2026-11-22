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
  agent.db = {};
  agent.logger = { warn() {} };
  agent.agents = {};
  agent.setupAPI();
  return { agent, routes };
}

async function invoke(handler, req) {
  const response = {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; }
  };
  await handler(req, response);
  return response;
}

async function main() {
  const { agent, routes } = createAgent();
  const handlers = routes.get('/api/content/:productionId/provenance');
  assert.ok(handlers, 'provenance route must be registered');
  const handler = handlers.at(-1);

  const lease = { productionId: 'production-1', owner: 'lease-owner' };
  let leaseCalls = 0;
  let provenanceArgs = null;
  let reviewArgs = null;
  agent.scenes = {
    withProductionOperationLease: async (productionId, callback, label) => {
      leaseCalls += 1;
      assert.equal(productionId, 'production-1');
      assert.equal(label, 'provenance update and content-review invalidation');
      const assertLease = async () => {};
      assertLease.lease = lease;
      return callback(assertLease);
    }
  };
  agent.db.getProductionBundle = async id => ({
    id,
    review_status: 'needs_review',
    schedule: null,
    editorData: { factChecked: true, rightsConfirmed: true }
  });
  agent.provenance = {
    review: async (...args) => { provenanceArgs = args; }
  };
  agent.refreshContentReviewUnlocked = async (...args) => {
    reviewArgs = args;
    return { id: 'production-1', review_status: 'needs_review' };
  };
  agent.decorateContentBundle = bundle => bundle;

  const response = await invoke(handler, {
    params: { productionId: 'production-1' },
    body: { sources: [], claims: [] }
  });
  assert.equal(response.statusCode, 200);
  assert.equal(leaseCalls, 1, 'provenance changes must acquire the production lease');
  assert.equal(provenanceArgs[0], 'production-1');
  assert.equal(provenanceArgs[2], lease, 'provenance persistence must use the same lease');
  assert.equal(reviewArgs[0], 'production-1');
  assert.equal(reviewArgs[2].lease, lease, 'review invalidation must use the same lease');

  const locked = createAgent();
  locked.agent.scenes = null;
  const lockedResponse = await invoke(locked.routes.get('/api/content/:productionId/provenance').at(-1), {
    params: { productionId: 'production-1' },
    body: {}
  });
  assert.equal(lockedResponse.statusCode, 503, 'the route must fail closed if production locking is unavailable');

  const approved = createAgent();
  let mutationAttempted = false;
  const approvedLease = { productionId: 'production-1', owner: 'lease-owner' };
  approved.agent.scenes = {
    withProductionOperationLease: async (_id, callback) => {
      const assertLease = async () => {};
      assertLease.lease = approvedLease;
      return callback(assertLease);
    }
  };
  approved.agent.db.getProductionBundle = async id => ({ id, review_status: 'approved', schedule: null });
  approved.agent.provenance = { review: async () => { mutationAttempted = true; } };
  const approvedResponse = await invoke(approved.routes.get('/api/content/:productionId/provenance').at(-1), {
    params: { productionId: 'production-1' },
    body: {}
  });
  assert.equal(approvedResponse.statusCode, 409, 'approved content provenance must remain immutable');
  assert.equal(mutationAttempted, false, 'approved content must not be mutated');

  process.stdout.write('Provenance review operation lock tests passed\\n');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
