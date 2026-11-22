const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AIVideoGenerator } = require('../utils/ai-video-generator');

async function run() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agenttube-video-output-retention-'));
  const persistedClip = path.join(directory, 'production_attempt_provider_scene_00.mp4');
  const generator = Object.create(AIVideoGenerator.prototype);
  generator.logger = { info() {}, warn() {}, error() {} };
  generator.lastVideoResult = null;
  generator.mediaGeneration = {
    async settings() {
      return { provider: 'test-provider', resolution: '720p', aspectRatio: '16:9' };
    },
    async generateClips() {
      await fs.writeFile(persistedClip, Buffer.alloc(1200, 7));
      return {
        clips: [{
          index: 0,
          duration: 4,
          path: persistedClip,
          taskId: 'persisted-task',
          provider: 'test-provider',
          model: 'test-model',
          reused: false
        }],
        requestedProvider: 'test-provider',
        actualProvider: 'test-provider',
        model: 'test-model',
        settings: { mode: 'hybrid' }
      };
    }
  };

  let leaseChecks = 0;
  const assertLease = async () => {
    leaseChecks += 1;
    if (leaseChecks >= 3) {
      throw Object.assign(new Error('generation lease lost after media task persisted its output'), {
        code: 'GENERATION_JOB_LEASE_LOST',
        status: 409
      });
    }
  };

  try {
    await assert.rejects(
      generator.generateVideo(
        { title: 'Lease retention test' },
        [],
        'audio.mp3',
        path.join(directory, 'production_attempt_final.mp4'),
        {
          jobId: 'job-retention',
          productionId: 'production-retention',
          attemptId: 'attempt',
          assertLease
        }
      ),
      error => error.code === 'GENERATION_JOB_LEASE_LOST'
    );

    assert.equal(await fs.access(persistedClip).then(() => true, () => false), true,
      'media-generation output is independently persisted and must survive a stale generator');
    assert.equal(generator.lastVideoResult, null,
      'stale generator must not publish a completed assembly result');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }

  console.log('AI video generator lease output retention tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
