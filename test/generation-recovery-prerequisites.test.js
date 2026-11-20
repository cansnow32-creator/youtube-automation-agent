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

    await db.saveGenerationCheckpoint('job-2', 'strategy', {
      status: 'completed',
      artifact: { topic: ' ' }
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

  process.stdout.write('Generation recovery prerequisite tests passed\\n');
}

run().catch(error => {
  process.stderr.write(`Generation recovery prerequisite tests failed: ${error.stack || error.message}\\n`);
  process.exitCode = 1;
});
