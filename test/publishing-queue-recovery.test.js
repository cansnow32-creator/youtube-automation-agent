const assert = require('node:assert/strict');
const { PublishingSchedulingAgent } = require('../agents/publishing-scheduling-agent');

function makeAgent(queue, options = {}) {
  const agent = Object.create(PublishingSchedulingAgent.prototype);
  agent.publishQueue = options.initialQueue || [];
  agent.activePublishes = new Map();
  agent.autoPublishEnabled = options.autoPublishEnabled !== false;
  agent.logger = { info() {}, warn() {}, error() {}, success() {} };
  agent.db = {
    getPublishQueue: options.getPublishQueue || (async () => queue.map(entry => ({ ...entry }))),
    updateScheduleEntry: options.updateScheduleEntry || (async () => {})
  };
  return agent;
}

function dueEntry(id = 'overdue-1') {
  return {
    id,
    productionId: id,
    title: 'Overdue scheduled video',
    publishTime: new Date(Date.now() - 60_000).toISOString(),
    status: 'scheduled'
  };
}

async function testAutomaticPublishingIsDisabledByDefault() {
  const previous = process.env.AUTO_PUBLISH_ENABLED;
  delete process.env.AUTO_PUBLISH_ENABLED;
  let queueReads = 0;
  let publishCalls = 0;
  try {
    const agent = new PublishingSchedulingAgent({
      getPublishQueue: async () => { queueReads++; return [dueEntry('must-stay-queued')]; }
    }, {});
    agent.publishContent = async () => { publishCalls++; };
    assert.equal(agent.autoPublishEnabled, false, 'automatic publishing must default to disabled');
    assert.equal(await agent.processPublishQueue(), 0);
    assert.equal(queueReads, 0, 'disabled queue processing must not even load due uploads');
    assert.equal(publishCalls, 0, 'disabled queue processing must never call the upload path');
  } finally {
    if (previous === undefined) delete process.env.AUTO_PUBLISH_ENABLED;
    else process.env.AUTO_PUBLISH_ENABLED = previous;
  }
}

async function testAutomaticPublishingRequiresExplicitEnvironmentOptIn() {
  const previous = process.env.AUTO_PUBLISH_ENABLED;
  process.env.AUTO_PUBLISH_ENABLED = 'true';
  try {
    const agent = new PublishingSchedulingAgent({}, {});
    assert.equal(agent.autoPublishEnabled, true, 'only an explicit true value enables automatic publishing');
  } finally {
    if (previous === undefined) delete process.env.AUTO_PUBLISH_ENABLED;
    else process.env.AUTO_PUBLISH_ENABLED = previous;
  }
}

async function testOverdueRowsAreReloadedAfterRestart() {
  let published = 0;
  const agent = makeAgent([dueEntry()]);
  agent.publishContent = async () => { published += 1; };
  assert.equal(agent.publishQueue.length, 0, 'simulate a fresh process with an empty in-memory queue');
  const processed = await agent.processPublishQueue();
  assert.equal(processed, 1);
  assert.equal(published, 1, 'overdue database rows must be caught up after restart');
}

async function testInvalidPublishTimeFailsClosed() {
  const invalid = { ...dueEntry('invalid-time'), publishTime: 'not-a-date' };
  const updates = [];
  let published = 0;
  const agent = makeAgent([invalid], { updateScheduleEntry: async entry => updates.push({ ...entry }) });
  agent.publishContent = async () => { published += 1; };
  assert.equal(await agent.processPublishQueue(), 0);
  assert.equal(published, 0, 'invalid schedule timestamps must never trigger an upload');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].status, 'failed');
  assert.match(updates[0].error, /Invalid publish time/);
}

async function testDatabaseReadFailureDiscardsStaleQueue() {
  let published = 0;
  const agent = makeAgent([], {
    initialQueue: [dueEntry('stale-memory')],
    getPublishQueue: async () => { throw new Error('database unavailable'); }
  });
  agent.publishContent = async () => { published += 1; };
  assert.equal(await agent.processPublishQueue(), 0);
  assert.equal(published, 0, 'stale memory must not be used when durable queue reload fails');
  assert.deepEqual(agent.publishQueue, []);
}

async function testConcurrentQueueTicksShareOnePublishOperation() {
  let publishCalls = 0;
  let releasePublish;
  const pending = new Promise(resolve => { releasePublish = resolve; });
  const agent = makeAgent([dueEntry('racing-entry')]);
  agent.publishContentOnce = async () => {
    publishCalls += 1;
    await pending;
    return { status: 'published' };
  };

  const first = agent.processPublishQueue();
  const second = agent.processPublishQueue();
  while (publishCalls === 0) await new Promise(resolve => setImmediate(resolve));
  assert.equal(publishCalls, 1, 'overlapping queue ticks in one process must share the active publish promise');
  releasePublish();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results, [1, 1]);
  assert.equal(publishCalls, 1);
}

async function main() {
  await testAutomaticPublishingIsDisabledByDefault();
  await testAutomaticPublishingRequiresExplicitEnvironmentOptIn();
  await testOverdueRowsAreReloadedAfterRestart();
  await testInvalidPublishTimeFailsClosed();
  await testDatabaseReadFailureDiscardsStaleQueue();
  await testConcurrentQueueTicksShareOnePublishOperation();
  process.stdout.write('Publishing queue recovery tests passed\\n');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
