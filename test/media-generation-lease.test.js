const assert = require('node:assert/strict');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { MediaGenerationService } = require('../utils/media-generation-service');
const { Database } = require('../database/db');

async function testAttemptScopedClipOutputsAndLeaseLossCleanup() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'media-lease-attempt-'));
  const db = {};
  const service = new MediaGenerationService(db, {}, { logger: { info() {}, warn() {}, error() {} } });
  const provider = {
    id: 'test-provider',
    model: 'test-model',
    describe: () => ({ model: 'test-model' }),
    normalizeRequest: request => ({ ...request, duration: 4 })
  };
  service.settings = async () => ({
    provider: 'test-provider',
    order: ['test-provider'],
    mode: 'hybrid',
    clipDuration: 4,
    maxGeneratedSeconds: 8,
    generateAudio: false,
    resolution: '720p',
    aspectRatio: '16:9'
  });
  service.registry = { select: () => provider };
  service.buildScenePlan = () => [
    { index: 0, duration: 4, prompt: 'Scene one' },
    { index: 1, duration: 4, prompt: 'Scene two' }
  ];
  const createdPaths = [];
  service.generateClip = async ({ outputPath, scene, assertLease }) => {
    assert.equal(typeof assertLease, 'function');
    await fs.writeFile(outputPath, Buffer.alloc(1200, scene.index + 1));
    createdPaths.push(outputPath);
    return {
      outputPath,
      reused: false,
      task: { model: 'test-model', external_task_id: 'task-' + scene.index }
    };
  };

  try {
    const first = await service.generateClips({
      jobId: 'job-1',
      productionId: 'production-1',
      script: {},
      outputDir: directory,
      attemptId: 'attempt-a'
    });
    assert.equal(first.clips.length, 2);
    assert.ok(first.clips.every(clip => clip.path.includes('production-1_attempt-a_test-provider_')));
    assert.notEqual(first.clips[0].path, first.clips[1].path);

    await fs.rm(first.clips[0].path, { force: true });
    await fs.rm(first.clips[1].path, { force: true });
    createdPaths.length = 0;

    let leaseChecks = 0;
    await assert.rejects(
      service.generateClips({
        jobId: 'job-1',
        productionId: 'production-1',
        script: {},
        outputDir: directory,
        attemptId: 'attempt-b',
        assertLease: async () => {
          leaseChecks += 1;
          // The first clip has been produced; fail before the second can start.
          if (leaseChecks >= 7) {
            throw Object.assign(new Error('generation lease lost during provider clip set'), {
              code: 'GENERATION_JOB_LEASE_LOST',
              status: 409
            });
          }
        }
      }),
      error => error.code === 'GENERATION_JOB_LEASE_LOST'
    );
    assert.equal(createdPaths.length, 1);
    assert.equal(await fs.access(createdPaths[0]).then(() => true, () => false), false,
      'partial clip sets from an abandoned attempt are removed');
    assert.deepEqual(await fs.readdir(directory), []);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function testPartialAttemptCleanupPreservesReusedClips() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'media-lease-reuse-'));
  const reusedPath = path.join(directory, 'previously-persisted.mp4');
  await fs.writeFile(reusedPath, Buffer.alloc(1200, 3));
  const service = new MediaGenerationService({}, {}, { logger: { info() {}, warn() {}, error() {} } });
  service.settings = async () => ({
    provider: 'test-provider',
    order: ['test-provider'],
    mode: 'hybrid',
    clipDuration: 4,
    maxGeneratedSeconds: 8,
    generateAudio: false,
    resolution: '720p',
    aspectRatio: '16:9'
  });
  service.registry = {
    select: () => ({
      id: 'test-provider',
      describe: () => ({ model: 'test-model' }),
      normalizeRequest: request => ({ ...request, duration: 4 })
    })
  };
  service.buildScenePlan = () => [
    { index: 0, duration: 4, prompt: 'Cached scene' },
    { index: 1, duration: 4, prompt: 'New scene' }
  ];
  let newPath = null;
  service.generateClip = async ({ outputPath, scene }) => {
    if (scene.index === 0) {
      return {
        task: { model: 'test-model', external_task_id: 'old-task' },
        outputPath: reusedPath,
        reused: true
      };
    }
    newPath = outputPath;
    await fs.writeFile(outputPath, Buffer.alloc(1200, 4));
    return {
      task: { model: 'test-model', external_task_id: 'new-task' },
      outputPath,
      reused: false
    };
  };

  try {
    let checks = 0;
    await assert.rejects(
      service.generateClips({
        jobId: 'job-2',
        productionId: 'production-2',
        script: {},
        outputDir: directory,
        attemptId: 'attempt-reuse',
        assertLease: async () => {
          checks += 1;
          if (checks >= 7) {
            throw Object.assign(new Error('generation lease lost after a new clip'), {
              code: 'GENERATION_JOB_LEASE_LOST',
              status: 409
            });
          }
        }
      }),
      error => error.code === 'GENERATION_JOB_LEASE_LOST'
    );
    assert.equal(await fs.access(reusedPath).then(() => true, () => false), true,
      'a clip reused from a persisted task must not be deleted');
    assert.ok(newPath);
    assert.equal(await fs.access(newPath).then(() => true, () => false), false,
      'new attempt output must be removed after lease loss');
    assert.deepEqual((await fs.readdir(directory)).sort(), ['previously-persisted.mp4']);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function testRemoteProviderTaskIsCancelledWhenLeaseLostBeforeTaskPersistence() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'media-lease-cancel-'));
  const updates = [];
  const cancelled = [];
  const task = { id: 'media-cancel-task', status: 'submitting', providerData: {} };
  const db = {
    findMediaGenerationTask: async () => null,
    createMediaGenerationTask: async () => ({ ...task }),
    updateMediaGenerationTask: async (_id, changes) => {
      updates.push(changes);
      return { ...task, ...changes, external_task_id: changes.externalTaskId || task.external_task_id };
    }
  };
  const service = new MediaGenerationService(db, {}, { logger: { info() {}, warn() {}, error() {} } });
  const provider = {
    id: 'seedance',
    model: 'test-model',
    capabilities: { cancellation: true },
    createTask: async () => ({
      status: 'queued',
      model: 'test-model',
      externalTaskId: 'remote-task-created-before-lease-loss'
    }),
    cancelTask: async taskId => {
      cancelled.push(taskId);
      return true;
    },
    downloadResult: async () => {
      throw new Error('Download must not begin after lease loss');
    }
  };
  let leaseChecks = 0;

  try {
    await assert.rejects(
      service.generateClip({
        jobId: 'job-cancel',
        productionId: 'production-cancel',
        scene: { index: 0, prompt: 'cancel me' },
        provider,
        outputPath: path.join(directory, 'cancelled-scene.mp4'),
        request: { prompt: 'cancel me' },
        assertLease: async () => {
          leaseChecks += 1;
          // createTask has returned its remote ID, but no task update may persist it.
          if (leaseChecks >= 4) {
            throw Object.assign(new Error('generation job lease lost after remote submission'), {
              code: 'GENERATION_JOB_LEASE_LOST',
              status: 409
            });
          }
        }
      }),
      error => error.code === 'GENERATION_JOB_LEASE_LOST'
    );
    assert.deepEqual(cancelled, ['remote-task-created-before-lease-loss'],
      'a cancellable remote job is cancelled even when its ID was never persisted locally');
    assert.equal(updates.length, 0, 'stale worker must not write the remote task ID after lease loss');
    assert.deepEqual(await fs.readdir(directory), []);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function makeStatefulMediaTaskDb(initialTask = null) {
  let row = initialTask ? {
    ...initialTask,
    providerData: { ...(initialTask.providerData || {}) }
  } : null;
  return {
    get row() { return row; },
    async findMediaGenerationTask() {
      return row ? { ...row, providerData: { ...(row.providerData || {}) } } : null;
    },
    async createMediaGenerationTask(input) {
      if (!row) {
        row = {
          id: 'media-stateful-task',
          job_id: input.jobId,
          production_id: input.productionId,
          scene_index: input.sceneIndex,
          provider: input.provider,
          model: input.model,
          status: input.status || 'submitting',
          external_task_id: null,
          providerData: {},
          output_path: null,
          error: null,
          completed_at: null
        };
      }
      return { ...row, providerData: { ...(row.providerData || {}) } };
    },
    async updateMediaGenerationTask(_id, changes) {
      row = { ...row };
      if (changes.model !== undefined) row.model = changes.model;
      if (changes.externalTaskId !== undefined) row.external_task_id = changes.externalTaskId;
      if (changes.status !== undefined) row.status = changes.status;
      if (changes.providerData !== undefined) row.providerData = { ...(changes.providerData || {}) };
      if (changes.outputPath !== undefined) row.output_path = changes.outputPath;
      if (changes.error !== undefined) row.error = changes.error;
      if (changes.completedAt !== undefined) row.completed_at = changes.completedAt;
      return { ...row, providerData: { ...(row.providerData || {}) } };
    }
  };
}

async function testSqliteCanClearPreviousRemoteTaskAndOutputReferences() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'media-db-clear-'));
  const db = new Database();
  db.dbPath = path.join(directory, 'media-tasks.sqlite');

  try {
    await db.initialize();
    const created = await db.createMediaGenerationTask({
      jobId: null,
      productionId: 'production-db-clear',
      sceneIndex: 0,
      provider: 'test-provider',
      model: 'test-model',
      status: 'failed'
    });
    await db.updateMediaGenerationTask(created.id, {
      externalTaskId: 'old-remote-task',
      outputPath: path.join(directory, 'old-output.mp4'),
      status: 'failed'
    });
    const reset = await db.updateMediaGenerationTask(created.id, {
      externalTaskId: null,
      outputPath: null,
      status: 'submitting',
      completedAt: null,
      error: null
    });
    assert.equal(reset.external_task_id, null, 'SQLite update must clear the previous external task ID');
    assert.equal(reset.output_path, null, 'SQLite update must clear the previous output path');
    assert.equal(reset.status, 'submitting');
    assert.equal(reset.completed_at, null);
  } finally {
    await db.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function testAmbiguousProviderSubmissionIsNotAutomaticallyRetried() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'media-submission-unknown-'));
  const db = makeStatefulMediaTaskDb();
  const service = new MediaGenerationService(db, {}, { logger: { info() {}, warn() {}, error() {} } });
  let createCalls = 0;
  const provider = {
    id: 'non-cancellable-provider',
    model: 'test-model',
    capabilities: { cancellation: false },
    createTask: async () => {
      createCalls++;
      // The request may have reached the provider even though the client timed out.
      throw Object.assign(new Error('socket closed while awaiting provider response'), { code: 'ECONNRESET' });
    }
  };

  try {
    await assert.rejects(
      service.generateClip({
        jobId: 'job-unknown-submission',
        productionId: 'production-unknown-submission',
        scene: { index: 0, prompt: 'ambiguous submission' },
        provider,
        outputPath: path.join(directory, 'scene.mp4'),
        request: { prompt: 'ambiguous submission' }
      }),
      /socket closed/
    );
    assert.equal(db.row.status, 'submission_unknown');
    assert.equal(db.row.external_task_id, null);

    await assert.rejects(
      service.generateClip({
        jobId: 'job-unknown-submission',
        productionId: 'production-unknown-submission',
        scene: { index: 0, prompt: 'ambiguous submission' },
        provider,
        outputPath: path.join(directory, 'scene-retry.mp4'),
        request: { prompt: 'ambiguous submission' }
      }),
      error => error.code === 'MEDIA_TASK_SUBMISSION_UNKNOWN' && error.status === 409
    );
    assert.equal(createCalls, 1, 'an ambiguous provider request must not be submitted twice');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function testLeaseLossAfterNonCancellableSubmissionBlocksRetry() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'media-submission-lease-'));
  const db = makeStatefulMediaTaskDb();
  const service = new MediaGenerationService(db, {}, { logger: { info() {}, warn() {}, error() {} } });
  let createCalls = 0;
  const provider = {
    id: 'non-cancellable-provider',
    model: 'test-model',
    capabilities: { cancellation: false },
    createTask: async () => {
      createCalls++;
      return { status: 'queued', model: 'test-model', externalTaskId: 'remote-accepted-but-not-persisted' };
    }
  };
  let checks = 0;

  try {
    await assert.rejects(
      service.generateClip({
        jobId: 'job-lease-unknown',
        productionId: 'production-lease-unknown',
        scene: { index: 0, prompt: 'accepted remotely' },
        provider,
        outputPath: path.join(directory, 'scene.mp4'),
        request: { prompt: 'accepted remotely' },
        assertLease: async () => {
          checks++;
          if (checks >= 4) {
            throw Object.assign(new Error('generation lease lost after provider accepted request'), {
              code: 'GENERATION_JOB_LEASE_LOST',
              status: 409
            });
          }
        }
      }),
      error => error.code === 'GENERATION_JOB_LEASE_LOST'
    );
    assert.equal(db.row.status, 'submitting');
    assert.equal(db.row.external_task_id, null);

    await assert.rejects(
      service.generateClip({
        jobId: 'job-lease-unknown',
        productionId: 'production-lease-unknown',
        scene: { index: 0, prompt: 'accepted remotely' },
        provider,
        outputPath: path.join(directory, 'scene-retry.mp4'),
        request: { prompt: 'accepted remotely' }
      }),
      error => error.code === 'MEDIA_TASK_SUBMISSION_UNKNOWN'
    );
    assert.equal(createCalls, 1, 'a stale worker cannot cause a duplicate remote task on retry');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function testTerminalTaskRetryWritesAheadAndPreservesSubmissionHistory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'media-submission-history-'));
  const outputPath = path.join(directory, 'new-scene.mp4');
  const db = makeStatefulMediaTaskDb({
    id: 'media-terminal-task',
    job_id: 'job-terminal-retry',
    production_id: 'production-terminal-retry',
    scene_index: 0,
    provider: 'test-provider',
    model: 'old-model',
    status: 'failed',
    external_task_id: 'old-terminal-remote-id',
    providerData: { outputUrl: 'https://provider.invalid/old.mp4', model: 'old-model' },
    output_path: 'old-output.mp4',
    error: 'previous remote task failed',
    completed_at: new Date().toISOString()
  });
  const service = new MediaGenerationService(db, {}, { logger: { info() {}, warn() {}, error() {} } });
  service.isValidVideo = async () => true;
  let createCalls = 0;
  const provider = {
    id: 'test-provider',
    model: 'new-model',
    capabilities: { cancellation: false },
    createTask: async () => {
      createCalls++;
      assert.equal(db.row.status, 'submitting', 'submission intent must be persisted before the remote API call');
      assert.equal(db.row.external_task_id, null, 'old terminal ID must be cleared before a new submission');
      assert.equal(db.row.output_path, null);
      return {
        status: 'succeeded',
        model: 'new-model',
        externalTaskId: 'new-remote-id',
        outputUrl: 'https://provider.invalid/new.mp4'
      };
    },
    downloadResult: async (_remote, destination) => {
      await fs.writeFile(destination, Buffer.alloc(1200, 7));
    }
  };

  try {
    const result = await service.generateClip({
      jobId: 'job-terminal-retry',
      productionId: 'production-terminal-retry',
      scene: { index: 0, prompt: 'new attempt' },
      provider,
      outputPath,
      request: { prompt: 'new attempt' }
    });
    assert.equal(result.outputPath, outputPath);
    assert.equal(createCalls, 1);
    assert.equal(db.row.status, 'succeeded');
    assert.equal(db.row.external_task_id, 'new-remote-id');
    assert.equal(db.row.output_path, outputPath);
    assert.equal(db.row.providerData.previousTasks[0].externalTaskId, 'old-terminal-remote-id',
      'the previous terminal task ID remains available for audit');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function testRemotePollingErrorReconcilesExistingTaskInsteadOfResubmitting() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'media-remote-reconcile-'));
  const db = makeStatefulMediaTaskDb({
    id: 'media-running-task',
    job_id: 'job-existing-remote',
    production_id: 'production-existing-remote',
    scene_index: 0,
    provider: 'test-provider',
    model: 'test-model',
    status: 'running',
    external_task_id: 'existing-remote-task',
    providerData: { model: 'test-model' },
    output_path: null,
    error: null
  });
  const service = new MediaGenerationService(db, {}, { logger: { info() {}, warn() {}, error() {} } });
  service.isValidVideo = async () => true;
  let getCalls = 0;
  let createCalls = 0;
  const provider = {
    id: 'test-provider',
    model: 'test-model',
    capabilities: { cancellation: false },
    getTask: async id => {
      assert.equal(id, 'existing-remote-task');
      getCalls++;
      if (getCalls === 1) throw new Error('temporary provider status outage');
      return {
        status: 'succeeded',
        model: 'test-model',
        externalTaskId: id,
        outputUrl: 'https://provider.invalid/completed.mp4'
      };
    },
    createTask: async () => {
      createCalls++;
      throw new Error('must not create a replacement task');
    },
    downloadResult: async (_remote, destination) => {
      await fs.writeFile(destination, Buffer.alloc(1200, 8));
    }
  };

  try {
    await assert.rejects(
      service.generateClip({
        jobId: 'job-existing-remote',
        productionId: 'production-existing-remote',
        scene: { index: 0, prompt: 'reconcile' },
        provider,
        outputPath: path.join(directory, 'first-attempt.mp4'),
        request: { prompt: 'reconcile' }
      }),
      /temporary provider status outage/
    );
    assert.equal(db.row.status, 'reconciliation_required');
    assert.equal(db.row.external_task_id, 'existing-remote-task');

    const result = await service.generateClip({
      jobId: 'job-existing-remote',
      productionId: 'production-existing-remote',
      scene: { index: 0, prompt: 'reconcile' },
      provider,
      outputPath: path.join(directory, 'resumed-attempt.mp4'),
      request: { prompt: 'reconcile' }
    });
    assert.equal(result.task.external_task_id, 'existing-remote-task');
    assert.equal(db.row.status, 'succeeded');
    assert.equal(getCalls, 2);
    assert.equal(createCalls, 0, 'a recoverable remote task must be polled, not duplicated');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function main() {
  await testSqliteCanClearPreviousRemoteTaskAndOutputReferences();
  await testAmbiguousProviderSubmissionIsNotAutomaticallyRetried();
  await testLeaseLossAfterNonCancellableSubmissionBlocksRetry();
  await testTerminalTaskRetryWritesAheadAndPreservesSubmissionHistory();
  await testRemotePollingErrorReconcilesExistingTaskInsteadOfResubmitting();
  await testAttemptScopedClipOutputsAndLeaseLossCleanup();
  await testPartialAttemptCleanupPreservesReusedClips();
  await testRemoteProviderTaskIsCancelledWhenLeaseLostBeforeTaskPersistence();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'media-lease-fence-'));
  const outputPath = path.join(directory, 'scene.mp4');
  const updates = [];
  const task = { id: 'media-task-1', status: 'submitting', providerData: {} };
  const db = {
    findMediaGenerationTask: async () => null,
    createMediaGenerationTask: async () => ({ ...task }),
    updateMediaGenerationTask: async (_id, changes) => {
      updates.push(changes);
      return { ...task, ...changes, external_task_id: changes.externalTaskId || task.external_task_id };
    }
  };
  const service = new MediaGenerationService(db, {}, { logger: { info() {}, warn() {}, error() {} } });
  service.isValidVideo = async () => true;
  const provider = {
    id: 'test-provider',
    model: 'test-model',
    capabilities: { cancellation: false },
    createTask: async () => ({ status: 'succeeded', model: 'test-model', externalTaskId: 'remote-1' }),
    downloadResult: async (_remote, destination) => {
      await fs.writeFile(destination, Buffer.alloc(1200, 1));
    }
  };
  let leaseChecks = 0;
  await assert.rejects(
    service.generateClip({
      jobId: 'repair-job',
      productionId: 'production-1',
      scene: { index: 0, prompt: 'test scene' },
      provider,
      outputPath,
      request: {},
      assertLease: async () => {
        leaseChecks += 1;
        if (leaseChecks >= 7) {
          throw Object.assign(new Error('scene operation lease lost after provider download'), { code: 'SCENE_EDIT_LEASE_LOST' });
        }
      }
    }),
    error => error.code === 'SCENE_EDIT_LEASE_LOST'
  );

  assert.equal(updates.length, 1, 'the stale worker does not mark the downloaded clip as succeeded');
  assert.notEqual(updates[0].status, 'succeeded');
  assert.equal(await fs.access(outputPath).then(() => true, () => false), false, 'the stale worker does not publish the canonical output');
  assert.deepEqual(await fs.readdir(directory), [], 'the attempt-specific download is cleaned up after lease loss');
  await fs.rm(directory, { recursive: true, force: true });
  process.stdout.write('Media generation lease fence tests passed\\n');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
