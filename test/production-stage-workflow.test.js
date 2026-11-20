const assert = require('node:assert/strict');
const {
  STAGE_ORDER,
  createProductionWorkflow,
  startProductionStage,
  completeProductionStage,
  failProductionStage,
  prepareProductionWorkflowForResume,
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

  const interrupted = createProductionWorkflow('approved-concept-3', now);
  startProductionStage(interrupted, 'visuals', now);
  const resumeStage = prepareProductionWorkflowForResume(interrupted, now);
  assert.equal(resumeStage, 'visuals');
  assert.equal(interrupted.currentStage, null);
  assert.equal(interrupted.stages.visuals.status, 'pending');
  assert.match(interrupted.stages.visuals.lastError, /stopped before the stage completed/);
  startProductionStage(interrupted, 'visuals', now);
  assert.equal(interrupted.stages.visuals.attemptCount, 2);

  const retry = createProductionWorkflow('approved-concept-4', now);
  startProductionStage(retry, 'visuals', now);
  failProductionStage(retry, 'visuals', new Error('temporary provider error'), now);
  assert.equal(prepareProductionWorkflowForResume(retry, now), 'visuals');
  assert.equal(retry.stages.visuals.status, 'pending');
  assert.match(retry.stages.visuals.lastError, /temporary provider error/);

  // A failure while persisting the initial in_progress transition must not
  // leave the stage permanently active in memory.
  const persistFailure = createProductionWorkflow('approved-concept-persist-failure', now);
  let persistAttempts = 0;
  await assert.rejects(
    runProductionStage(persistFailure, 'visuals', async () => {
      throw new Error('task must not run when initial persistence fails');
    }, async () => {
      persistAttempts++;
      if (persistAttempts === 1) throw new Error('database unavailable');
    }, now),
    /database unavailable/
  );
  assert.equal(persistFailure.currentStage, null);
  assert.equal(persistFailure.stages.visuals.status, 'failed');
  assert.match(persistFailure.stages.visuals.error, /database unavailable/);
  assert.equal(persistAttempts, 2, 'failure state should receive one best-effort persistence attempt');

  const inconsistent = createProductionWorkflow('approved-concept-inconsistent', now);
  inconsistent.stages.narration.status = 'completed';
  inconsistent.stages.narration.completedAt = new Date().toISOString();
  assert.throws(
    () => prepareProductionWorkflowForResume(inconsistent, now),
    /narration is completed after an incomplete stage/
  );

  const unknownStatus = createProductionWorkflow('approved-concept-unknown-status', now);
  unknownStatus.stages.visuals.status = 'cancelled';
  assert.throws(
    () => prepareProductionWorkflowForResume(unknownStatus, now),
    /unexpected visuals status/
  );

  const invalid = createProductionWorkflow('approved-concept-2', now);
  startProductionStage(invalid, 'visuals', now);
  assert.throws(() => startProductionStage(invalid, 'visuals', now), /still active/);
  failProductionStage(invalid, 'visuals', new Error('cancelled'), now);
  assert.equal(invalid.stages.visuals.status, 'failed');
  assert.equal(invalid.currentStage, null);

  process.stdout.write('Production stage workflow tests passed\n');
}

run().catch(error => {
  process.stderr.write(`Production stage workflow tests failed: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
