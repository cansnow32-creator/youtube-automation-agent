const assert = require('node:assert/strict');
const {
  STAGE_ORDER,
  createProductionWorkflow,
  startProductionStage,
  completeProductionStage,
  failProductionStage,
  runProductionStage
} = require('../utils/production-stage-workflow');

async function run() {
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 10, 20, 0, 0, tick++));
  assert.throws(() => createProductionWorkflow(null, now), /approved concept is required/);

  const workflow = createProductionWorkflow('approved-concept-1', now);
  assert.deepEqual(STAGE_ORDER, ['research', 'visuals', 'narration', 'editing']);
  assert.equal(workflow.stages.research.status, 'completed');
  assert.equal(workflow.stages.visuals.status, 'pending');
  assert.throws(() => startProductionStage(workflow, 'narration', now), /visuals is completed/);

  const persisted = [];
  await runProductionStage(workflow, 'visuals', async () => ({ assetCount: 3 }), async value => {
    persisted.push(value.stages.visuals.status);
  }, now);
  assert.deepEqual(persisted, ['in_progress', 'completed']);
  assert.equal(workflow.stages.visuals.details.assetCount, 3);

  await runProductionStage(workflow, 'narration', async () => ({ provider: 'local-test' }), async () => {}, now);
  assert.equal(workflow.stages.narration.status, 'completed');

  await assert.rejects(
    runProductionStage(workflow, 'editing', async () => { throw new Error('FFmpeg failed'); }, async () => {}, now),
    /FFmpeg failed/
  );
  assert.equal(workflow.stages.editing.status, 'failed');
  assert.match(workflow.stages.editing.error, /FFmpeg failed/);
  assert.equal(workflow.currentStage, null);

  workflow.stages.editing.status = 'pending';
  await runProductionStage(workflow, 'editing', async () => ({ output: 'final.mp4' }), async () => {}, now);
  assert.equal(workflow.stages.editing.status, 'completed');
  assert.equal(workflow.stages.editing.details.output, 'final.mp4');

  const invalid = createProductionWorkflow('approved-concept-2', now);
  startProductionStage(invalid, 'visuals', now);
  assert.throws(() => startProductionStage(invalid, 'visuals', now), /still active/);
  failProductionStage(invalid, 'visuals', new Error('cancelled'), now);
  assert.equal(invalid.stages.visuals.status, 'failed');
  assert.equal(invalid.currentStage, null);

  process.stdout.write('Production stage workflow tests passed\\n');
}

run().catch(error => {
  process.stderr.write(`Production stage workflow tests failed: ${error.stack || error.message}\\n`);
  process.exitCode = 1;
});
