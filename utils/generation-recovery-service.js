const fs = require('fs').promises;
const path = require('path');
const { getMediaInfo: defaultGetMediaInfo } = require('./ffmpeg');

const GENERATION_STAGES = [
  'strategy',
  'script',
  'thumbnail',
  'seo',
  'production',
  'quality_review'
];

class GenerationRecoveryService {
  constructor(db, options = {}) {
    this.db = db;
    this.getMediaInfo = options.getMediaInfo || defaultGetMediaInfo;
    this.updateJobStage = options.updateJobStage || (async () => null);
    this.logger = options.logger || { info() {}, warn() {} };
    this.maxAttempts = Math.max(1, Number(options.maxAttempts || process.env.GENERATION_STAGE_MAX_ATTEMPTS || 2));
    this.baseDelayMs = Math.max(0, Number(options.baseDelayMs ?? process.env.GENERATION_RETRY_BASE_MS ?? 1000));
  }

  async run(jobId, stage, progress, producer, options = {}) {
    if (!GENERATION_STAGES.includes(stage)) throw new Error(`Unknown generation stage: ${stage}`);
    if (typeof producer !== 'function') throw new Error('A generation stage producer is required');
    const assertLease = typeof options.assertLease === 'function' ? options.assertLease : async () => {};
    const lease = assertLease.lease || null;

    await assertLease();
    await this.assertPrerequisites(jobId, stage, assertLease);
    const checkpoint = await this.db.getGenerationCheckpoint(jobId, stage);
    await assertLease();
    if (checkpoint?.status === 'completed') {
      const valid = await this.validateArtifact(stage, checkpoint.artifact);
      await assertLease();
      if (valid) {
        await this.markReused(jobId, stage, progress, assertLease);
        this.logger.info(`Reusing verified ${stage} checkpoint for ${jobId}`);
        return checkpoint.artifact;
      }
      const stageIndex = GENERATION_STAGES.indexOf(stage);
      await assertLease();
      await this.db.deleteGenerationCheckpoints(jobId, GENERATION_STAGES.slice(stageIndex + 1), lease);
      await assertLease();
      await this.db.saveGenerationCheckpoint(jobId, stage, {
        status: 'invalid',
        error: 'The saved artifact is missing or no longer valid',
        completedAt: null
      }, lease);
      await assertLease();
    }

    let lastError;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      await assertLease();
      await this.updateJobStage(jobId, stage, progress, { attempt });
      await assertLease();
      const startedAt = new Date().toISOString();
      await this.db.saveGenerationCheckpoint(jobId, stage, {
        status: 'running',
        error: null,
        startedAt,
        completedAt: null,
        incrementAttempt: true
      }, lease);
      await assertLease();
      try {
        const artifact = await producer(assertLease);
        await assertLease();
        const valid = await this.validateArtifact(stage, artifact);
        await assertLease();
        if (!valid) throw new Error(`${stage} produced an incomplete or missing artifact`);
        await assertLease();
        await this.db.saveGenerationCheckpoint(jobId, stage, {
          status: 'completed',
          artifact,
          error: null,
          completedAt: new Date().toISOString()
        }, lease);
        await assertLease();
        return artifact;
      } catch (error) {
        lastError = error;
        // A stale worker must not write a failed checkpoint after losing its lease.
        await assertLease();
        await this.db.saveGenerationCheckpoint(jobId, stage, {
          status: error.code === 'JOB_CANCELLED' ? 'cancelled' : 'failed',
          error: error.message,
          completedAt: new Date().toISOString()
        }, lease);
        await assertLease();
        if (error.code === 'JOB_CANCELLED' || attempt >= this.maxAttempts || !this.isRetryable(error)) throw error;
        const delayMs = this.baseDelayMs * (2 ** (attempt - 1));
        this.logger.warn(`${stage} failed transiently; retrying in ${delayMs}ms: ${error.message}`);
        if (delayMs) {
          await assertLease();
          await new Promise(resolve => setTimeout(resolve, delayMs));
          await assertLease();
        }
      }
    }
    throw lastError;
  }

  async assertPrerequisites(jobId, stage, assertLease = async () => {}) {
    const stageIndex = GENERATION_STAGES.indexOf(stage);
    for (const prerequisite of GENERATION_STAGES.slice(0, stageIndex)) {
      await assertLease();
      const checkpoint = await this.db.getGenerationCheckpoint(jobId, prerequisite);
      await assertLease();
      const valid = checkpoint?.status === 'completed' && await this.validateArtifact(prerequisite, checkpoint.artifact);
      await assertLease();
      if (!valid) {
        const error = new Error(`Cannot run ${stage}: prerequisite stage ${prerequisite} is incomplete or its artifact is invalid`);
        error.status = 409;
        error.code = 'GENERATION_PREREQUISITE_MISSING';
        error.prerequisiteStage = prerequisite;
        error.requestedStage = stage;
        throw error;
      }
    }
  }

  async validateArtifact(stage, artifact) {
    if (!artifact || typeof artifact !== 'object') return false;
    if (stage === 'strategy') return Boolean(artifact.topic);
    if (stage === 'script') return Boolean(artifact.title && (artifact.fullScript || artifact.mainContent));
    if (stage === 'thumbnail') return this.validatePathArtifact(artifact.path);
    if (stage === 'seo') return Boolean(artifact.title && artifact.description && Array.isArray(artifact.tags));
    if (stage === 'production') {
      const finalVideo = artifact.assets?.finalVideo;
      if (!artifact.id || !finalVideo || finalVideo.simulated ||
          typeof finalVideo.path !== 'string' ||
          path.extname(finalVideo.path).toLowerCase() !== '.mp4' ||
          !(await this.pathExists(finalVideo.path))) {
        return false;
      }
      try {
        const media = await this.getMediaInfo(finalVideo.path);
        if (!media || !Number.isFinite(Number(media.duration)) || Number(media.duration) <= 0 ||
            !Number.isFinite(Number(media.width)) || Number(media.width) <= 0 ||
            !Number.isFinite(Number(media.height)) || Number(media.height) <= 0) {
          return false;
        }
        if (finalVideo.cleanPath !== undefined) {
          if (typeof finalVideo.cleanPath !== 'string' ||
              path.extname(finalVideo.cleanPath).toLowerCase() !== '.mp4' ||
              !(await this.pathExists(finalVideo.cleanPath))) {
            return false;
          }
          const cleanMedia = await this.getMediaInfo(finalVideo.cleanPath);
          if (!cleanMedia || !Number.isFinite(Number(cleanMedia.duration)) || Number(cleanMedia.duration) <= 0 ||
              !Number.isFinite(Number(cleanMedia.width)) || Number(cleanMedia.width) <= 0 ||
              !Number.isFinite(Number(cleanMedia.height)) || Number(cleanMedia.height) <= 0) {
            return false;
          }
        }
        return true;
      } catch (_error) {
        return false;
      }
    }
    if (stage === 'quality_review') return Boolean(artifact.contentId && artifact.reviewStatus);
    return false;
  }

  async validatePathArtifact(filePath) {
    return Boolean(filePath && await this.pathExists(filePath));
  }

  async pathExists(filePath) {
    try {
      const stat = await fs.stat(filePath);
      return stat.isFile() && stat.size > 0;
    } catch (_error) {
      return false;
    }
  }

  isRetryable(error) {
    const status = Number(error.status || error.statusCode || error.response?.status || 0);
    if ([408, 425, 429].includes(status) || status >= 500) return true;
    const code = String(error.code || '').toUpperCase();
    return ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENETUNREACH', 'EAI_AGAIN'].includes(code);
  }

  async markReused(jobId, stage, progress, assertLease = async () => {}) {
    await assertLease();
    const job = await this.db.getGenerationJob(jobId);
    await assertLease();
    const reusedStages = Array.from(new Set([...(job?.details?.reusedStages || []), stage]));
    await this.updateJobStage(jobId, stage, progress, { reusedStages });
    await assertLease();
  }

  resumePoint(checkpoints = []) {
    const byStage = new Map(checkpoints.map(checkpoint => [checkpoint.stage, checkpoint]));
    return GENERATION_STAGES.find(stage => byStage.get(stage)?.status !== 'completed') || 'quality_review';
  }

  async resetFrom(jobId, requestedStage, assertLease = async () => {}) {
    if (!GENERATION_STAGES.includes(requestedStage)) throw new Error('Resume stage is not supported');
    const index = GENERATION_STAGES.indexOf(requestedStage);
    await assertLease();
    await this.db.deleteGenerationCheckpoints(jobId, GENERATION_STAGES.slice(index), lease);
    await assertLease();
  }
}

module.exports = { GenerationRecoveryService, GENERATION_STAGES };
