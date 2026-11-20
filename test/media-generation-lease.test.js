const assert = require('node:assert/strict');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { MediaGenerationService } = require('../utils/media-generation-service');

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

async function main() {
  await testAttemptScopedClipOutputsAndLeaseLossCleanup();
  await testPartialAttemptCleanupPreservesReusedClips();
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
        if (leaseChecks >= 5) {
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
