const assert = require('node:assert/strict');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { MediaGenerationService } = require('../utils/media-generation-service');

async function main() {
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
