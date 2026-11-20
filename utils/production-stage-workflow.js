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
  workflow.stages[stage] = { ...workflow.stages[stage], status: 'in_progress', startedAt: timestamp, error: null };
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

async function runProductionStage(workflow, stage, task, persist = async () => {}, now = () => new Date()) {
  startProductionStage(workflow, stage, now);
  await persist(workflow);
  try {
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
  runProductionStage
};
