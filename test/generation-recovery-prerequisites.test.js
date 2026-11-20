const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { GenerationRecoveryService } = require('../utils/generation-recovery-service');

async function run() {
  const checkpoints = new Map();
  const db = {
    async getGenerationCheckpoint(jobId, stage) {
      return checkpoints.get(`${jobId}:${stage}`) || null;
    },
    async saveGenerationCheckpoint(jobId, stage, value) {
      const key = `${jobId}:${stage}`;
      const previous = checkpoints.get(key) || {};
      checkpoints.set(key, {
        ...previous,
        ...value,
        stage,
        artifact: value.artifact === undefined ? previous.artifact : value.artifact
      });
    },
    async deleteGenerationCheckpoints(jobId, stages) {
      for (const stage of stages) checkpoints.delete(`${jobId}:${stage}`);
    },
    async getGenerationJob() { return { details: {} }; }
  };
  const recovery = new GenerationRecoveryService(db, {
    maxAttempts: 1,
    baseDelayMs: 0,
    updateJobStage: async () => {}
  });

  let producerCalled = false;
  await assert.rejects(
    recovery.run('job-1', 'script', 20, async () => {
      producerCalled = true;
      return { title: 'A valid script', fullScript: 'Script body' };
    }),
    error => error.status === 409 &&
      error.code === 'GENERATION_PREREQUISITE_MISSING' &&
      error.prerequisiteStage === 'strategy'
  );
  assert.equal(producerCalled, false, 'A stage must not run before its predecessor');

  await recovery.run('job-1', 'strategy', 10, async () => ({ topic: 'A researched topic' }));
  await recovery.run('job-1', 'script', 20, async () => ({
    title: 'A valid script',
    fullScript: 'Script body'
  }));

  await assert.rejects(
    recovery.run('job-1', 'seo', 50, async () => ({
      title: 'SEO title',
      description: 'Description',
      tags: []
    })),
    error => error.code === 'GENERATION_PREREQUISITE_MISSING' &&
      error.prerequisiteStage === 'thumbnail'
  );

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agenttube-recovery-'));
  try {
    const thumbnailPath = path.join(tempDir, 'thumbnail.jpg');
    await fs.writeFile(thumbnailPath, 'valid test thumbnail');
    await recovery.run('job-1', 'thumbnail', 35, async () => ({ path: thumbnailPath }));
    const seo = await recovery.run('job-1', 'seo', 50, async () => ({
      title: 'SEO title',
      description: 'Description',
      tags: []
    }));
    assert.equal(seo.title, 'SEO title');


    const validVideoPath = path.join(tempDir, 'valid-final.mp4');
    const cleanVideoPath = path.join(tempDir, 'valid-clean.mp4');
    const placeholderPath = path.join(tempDir, 'placeholder.mp4.assembly.json');
    const invalidVideoPath = path.join(tempDir, 'invalid-final.mp4');
    await Promise.all([
      fs.writeFile(validVideoPath, 'encoded-video'),
      fs.writeFile(cleanVideoPath, 'clean-encoded-video'),
      fs.writeFile(placeholderPath, JSON.stringify({ message: 'simulation only' })),
      fs.writeFile(invalidVideoPath, 'not an encoded video')
    ]);
    const mediaRecovery = new GenerationRecoveryService(db, {
      maxAttempts: 1,
      getMediaInfo: async filePath => {
        if (filePath === invalidVideoPath) throw new Error('invalid media container');
        return { duration: 12, width: 1920, height: 1080, hasAudio: true };
      }
    });
    assert.equal(await mediaRecovery.validateArtifact('production', {
      id: 'production-valid',
      assets: { finalVideo: { path: validVideoPath, cleanPath: cleanVideoPath } }
    }), true, 'a real encoded MP4 and its clean source can be reused');
    assert.equal(await mediaRecovery.validateArtifact('production', {
      id: 'production-placeholder',
      assets: { finalVideo: { path: placeholderPath } }
    }), false, 'a non-MP4 simulation sidecar must never satisfy a production checkpoint');
    assert.equal(await mediaRecovery.validateArtifact('production', {
      id: 'production-invalid',
      assets: { finalVideo: { path: invalidVideoPath } }
    }), false, 'a file with an MP4 extension but invalid media must not be reused');
    assert.equal(await mediaRecovery.validateArtifact('production', {
      id: 'production-simulated',
      assets: { finalVideo: { path: validVideoPath, simulated: true } }
    }), false, 'explicitly simulated video artifacts must not be reused');
    assert.equal(await mediaRecovery.validateArtifact('production', {
      id: 'production-missing-clean',
      assets: { finalVideo: { path: validVideoPath, cleanPath: path.join(tempDir, 'missing-clean.mp4') } }
    }), false, 'a declared clean source must also exist and be valid');

    await db.saveGenerationCheckpoint('job-2', 'strategy', {
      status: 'completed',
      artifact: { topic: '' }
    });
    await assert.rejects(
      recovery.run('job-2', 'script', 20, async () => ({
        title: 'Should not run',
        fullScript: 'Body'
      })),
      error => error.code === 'GENERATION_PREREQUISITE_MISSING' &&
        error.prerequisiteStage === 'strategy'
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  // Losing the outer generation-job lease while a producer is running must
  // prevent the stale worker from saving either a completed or failed checkpoint.
  const leaseWrites = [];
  db.saveGenerationCheckpoint = async (jobId, stage, value) => {
    leaseWrites.push({ jobId, stage, status: value.status });
    const key = `${jobId}:${stage}`;
    const previous = checkpoints.get(key) || {};
    checkpoints.set(key, {
      ...previous,
      ...value,
      stage,
      artifact: value.artifact === undefined ? previous.artifact : value.artifact
    });
  };
  let leaseLost = false;
  await assert.rejects(
    recovery.run('job-lease-loss', 'strategy', 10, async () => {
      leaseLost = true;
      return { topic: 'Must not be checkpointed' };
    }, {
      assertLease: async () => {
        if (leaseLost) {
          throw Object.assign(new Error('generation job lease lost'), {
            code: 'GENERATION_JOB_LEASE_LOST',
            status: 409
          });
        }
      }
    }),
    error => error.code === 'GENERATION_JOB_LEASE_LOST'
  );
  assert.deepEqual(
    leaseWrites.map(write => write.status),
    ['running'],
    'a worker that lost its job lease must not persist completed or failed state'
  );
  process.stdout.write('Generation recovery prerequisite tests passed\n');
}

run().catch(error => {
  process.stderr.write(`Generation recovery prerequisite tests failed: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
