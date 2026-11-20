const STAGE_ORDER = Object.freeze(['research', 'visuals', 'narration', 'editing']);

function createProductionWorkflow(approvedConceptId, now = () => new Date()) {
  if (!approvedConceptId) throw new Error('An approved concept is required to initialize the production workflow');
  const timestamp = now().toISOString();
  return {
    version: 1,
    currentStage: null,
    stages: {
      research: { status: 'completed', startedAt: timestamp, completedAt: timestamp, evidence: { approvedConceptId } },
      visuals: { status: 'pending', startedAt: null, completedAt: null, error: null },
      narration: { status: 'pending', startedAt: null, completedAt: null, error: null },
      editing: { status: 'pending', startedAt: null, completedAt: null, error: null }
    },
    updatedAt: timestamp
  };
}

function startProductionStage(workflow, stage, now = () => new Date()) {
  const index = STAGE_ORDER.indexOf(stage);
  if (index < 0) throw new Error(`Unknown production stage: ${stage}`);
  if (workflow.currentStage) throw new Error(`Production stage ${workflow.currentStage} is still active`);
  const previous = STAGE_ORDER[index - 1];
  if (previous && workflow.stages[previous]?.status !== 'completed') {
    throw new Error(`Production stage ${stage} is blocked until ${previous} is completed`);
  }
  if (workflow.stages[stage]?.status !== 'pending') {
    throw new Error(`Production stage ${stage} cannot start from status ${workflow.stages[stage]?.status || 'missing'}`);
  }
  const timestamp = now().toISOString();
  workflow.stages[stage] = { ...workflow.stages[stage], status: 'in_progress', startedAt: timestamp, error: null, attemptCount: Number(workflow.stages[stage].attemptCount || 0) + 1 };
  workflow.currentStage = stage;
  workflow.updatedAt = timestamp;
  return workflow;
}

function completeProductionStage(workflow, stage, details = {}, now = () => new Date()) {
  if (workflow.currentStage !== stage || workflow.stages[stage]?.status !== 'in_progress') {
    throw new Error(`Production stage ${stage} is not active`);
  }
  const timestamp = now().toISOString();
  workflow.stages[stage] = {
    ...workflow.stages[stage],
    status: 'completed',
    completedAt: timestamp,
    details
  };
  workflow.currentStage = null;
  workflow.updatedAt = timestamp;
  return workflow;
}

function failProductionStage(workflow, stage, error, now = () => new Date()) {
  if (workflow.currentStage !== stage || workflow.stages[stage]?.status !== 'in_progress') return workflow;
  const timestamp = now().toISOString();
  workflow.stages[stage] = {
    ...workflow.stages[stage],
    status: 'failed',
    error: String(error?.message || error || 'Production stage failed').slice(0, 500),
    failedAt: timestamp
  };
  workflow.currentStage = null;
  workflow.updatedAt = timestamp;
  return workflow;
}

function prepareProductionWorkflowForResume(workflow, now = () => new Date()) {
  if (!workflow || !workflow.stages) throw new Error('A persisted production workflow is required to resume production');
  const timestamp = now().toISOString();
  for (const stage of STAGE_ORDER) {
    const state = workflow.stages[stage];
    if (!state) throw new Error(`Production workflow is missing stage: ${stage}`);
    if (state.status === 'in_progress') {
      state.status = 'failed';
      state.error = 'Production process stopped before the stage completed';
      state.failedAt = timestamp;
    }
  }
  workflow.currentStage = null;
  const firstIncomplete = STAGE_ORDER.find(stage => workflow.stages[stage].status !== 'completed');
  if (!firstIncomplete) {
    workflow.updatedAt = timestamp;
    return null;
  }
  const state = workflow.stages[firstIncomplete];
  if (!['pending', 'failed'].includes(state.status)) {
    throw new Error(`Cannot resume from unexpected ${firstIncomplete} status: ${state.status}`);
  }
  if (state.status === 'failed') {
    state.lastError = state.error || null;
    state.status = 'pending';
    state.error = null;
    state.startedAt = null;
    state.completedAt = null;
  }
  workflow.updatedAt = timestamp;
  return firstIncomplete;
}

async function runProductionStage(workflow, stage, task, persist = async () => {}, now = () => new Date()) {
  startProductionStage(workflow, stage, now);
  try {
    // The initial in_progress write is part of the stage attempt. If persistence
    // fails, record the failure in memory and make a best-effort durable write.
    await persist(workflow);
    const result = await task();
    completeProductionStage(workflow, stage, result && typeof result === 'object' ? result : { result: result ?? null }, now);
    await persist(workflow);
    return result;
  } catch (error) {
    failProductionStage(workflow, stage, error, now);
    await persist(workflow).catch(() => {});
    throw error;
  }
}

module.exports = {
  STAGE_ORDER,
  createProductionWorkflow,
  startProductionStage,
  completeProductionStage,
  failProductionStage,
  prepareProductionWorkflowForResume,
  runProductionStage
};
