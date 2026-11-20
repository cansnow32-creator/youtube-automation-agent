const fs = require('fs').promises;
const crypto = require('crypto');
const path = require('path');
const { VideoProviderRegistry, DEFAULT_PROVIDER_ORDER, safeModelError } = require('./video-providers');
const { Logger } = require('./logger');
const { runFFmpeg } = require('./ffmpeg');

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

async function removeAttemptOutputs(paths = []) {
  await Promise.all([...new Set(paths.filter(value => typeof value === 'string' && value))]
    .map(filePath => fs.rm(filePath, { force: true }).catch(() => {})));
}

class MediaGenerationService {
  constructor(db, credentials = {}, options = {}) {
    this.db = db;
    this.registry = options.registry || new VideoProviderRegistry(credentials, options.providerOptions);
    this.logger = options.logger || new Logger('MediaGeneration');
    this.pollIntervalMs = Math.max(10, Number(options.pollIntervalMs ?? process.env.VIDEO_PROVIDER_POLL_MS ?? 5000));
    this.maxPollMs = Math.max(1000, Number(options.maxPollMs ?? process.env.VIDEO_PROVIDER_TIMEOUT_MS ?? 60 * 60 * 1000));
    this.sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }

  async settings() {
    const stored = this.db?.getAllSettings ? await this.db.getAllSettings() : {};
    const provider = process.env.VIDEO_PROVIDER || stored.video_provider || 'slideshow';
    const order = String(process.env.VIDEO_PROVIDER_ORDER || stored.video_provider_order || DEFAULT_PROVIDER_ORDER.join(','))
      .split(',').map(value => value.trim()).filter(Boolean);
    return {
      provider,
      order,
      mode: process.env.VIDEO_GENERATION_MODE || stored.video_generation_mode || 'hybrid',
      clipDuration: Math.max(3, Number(process.env.VIDEO_CLIP_DURATION || stored.video_clip_duration || 8)),
      maxGeneratedSeconds: Math.max(0, Number(process.env.VIDEO_MAX_GENERATED_SECONDS || stored.video_max_generated_seconds || 60)),
      generateAudio: false,
      resolution: process.env.VIDEO_RESOLUTION || stored.video_resolution || '720p',
      aspectRatio: process.env.VIDEO_ASPECT_RATIO || stored.video_aspect_ratio || '16:9'
    };
  }

  listProviders() {
    return [
      { id: 'cinecode', name: 'CineCode Local Cinematic Renderer', available: true, model: 'local-ffmpeg-camera-motion', local: true },
      ...this.registry.list()
    ];
  }

  buildScenePlan(script = {}, visualAssets = [], settings = {}) {
    const prompts = [];
    if (script.hook?.text || script.title) {
      prompts.push({
        label: 'Hook',
        prompt: `${script.hook?.text || script.title}. Cinematic opening shot, clear subject, intentional camera movement, no captions or on-screen text.`
      });
    }
    for (const section of script.mainContent?.sections || []) {
      const detail = typeof section.content === 'string'
        ? section.content
        : (section.items || section.steps || []).map(item => `${item.title || ''} ${item.description || ''}`).join(' ');
      prompts.push({
        label: section.title || 'Scene',
        prompt: `${section.title || ''}. ${detail}`.trim() + '. Cinematic explanatory B-roll, natural motion, coherent lighting, no captions or on-screen text.'
      });
    }
    if (script.conclusion?.finalThought) {
      prompts.push({ label: 'Conclusion', prompt: `${script.conclusion.finalThought}. Memorable cinematic closing shot, no captions or on-screen text.` });
    }

    const clipDuration = Number(settings.clipDuration || 8);
    const maxScenes = Math.max(0, Math.floor(Number(settings.maxGeneratedSeconds || 0) / clipDuration));
    return prompts.slice(0, maxScenes).map((scene, index) => ({
      ...scene,
      index,
      duration: clipDuration,
      firstFrame: visualAssets[index % Math.max(1, visualAssets.length)] || null,
      referenceImages: []
    }));
  }

  async generateClips({
    jobId,
    productionId,
    script,
    visualAssets = [],
    outputDir,
    attemptId = null,
    assertLease = async () => {}
  }) {
    await assertLease();
    const settings = await this.settings();
    await assertLease();
    const routingRequest = {
      duration: settings.clipDuration,
      firstFrame: visualAssets[0] || null,
      generateAudio: settings.generateAudio
    };
    const provider = this.registry.select(settings.provider, settings.order, routingRequest);
    const providerInfo = provider.describe();
    await assertLease();
    if (provider.id === 'slideshow' || settings.mode === 'slideshow' || settings.maxGeneratedSeconds === 0) {
      return { clips: [], requestedProvider: settings.provider, actualProvider: 'slideshow', model: 'local-ffmpeg', settings };
    }

    const normalized = provider.normalizeRequest(routingRequest);
    const effectiveSettings = { ...settings, clipDuration: normalized.duration };
    const scenes = this.buildScenePlan(script, visualAssets, effectiveSettings);
    const safeAttemptId = String(attemptId || crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]/g, '');
    const clips = [];
    const attemptOutputPaths = [];
    try {
      for (const scene of scenes) {
        await assertLease();
        const outputPath = path.join(
          outputDir,
          `${productionId}_${safeAttemptId}_${provider.id}_${String(scene.index).padStart(2, '0')}.mp4`
        );
        const result = await this.generateClip({
          jobId,
          productionId,
          scene,
          provider,
          outputPath,
          request: {
            prompt: scene.prompt,
            duration: scene.duration,
            firstFrame: scene.firstFrame,
            referenceImages: scene.referenceImages,
            resolution: settings.resolution,
            aspectRatio: settings.aspectRatio,
            generateAudio: settings.generateAudio
          },
          assertLease
        });
        if (!result.reused) attemptOutputPaths.push(result.outputPath);
        await assertLease();
        clips.push({ ...scene, path: result.outputPath, provider: provider.id, model: result.task.model, taskId: result.task.external_task_id, reused: result.reused === true });
      }
      await assertLease();
      const models = [...new Set(clips.map(clip => clip.model).filter(Boolean))];
      return {
        clips, requestedProvider: settings.provider, actualProvider: provider.id,
        model: models.join(', ') || providerInfo.model, settings: effectiveSettings,
        attemptId: safeAttemptId
      };
    } catch (error) {
      // This invocation cannot return a complete clip set. Remove only the
      // outputs created during this attempt; reused persisted clips are untouched.
      await removeAttemptOutputs(attemptOutputPaths);
      throw error;
    }
  }

  async generateClip({ jobId, productionId, scene, provider, outputPath, request, assertLease = async () => {} }) {
    await assertLease();
    let task = this.db?.findMediaGenerationTask
      ? await this.db.findMediaGenerationTask(jobId, scene.index, provider.id, productionId)
      : null;

    if (task?.status === 'succeeded' && task.output_path) {
      const reusableOutput = await this.isValidVideo(task.output_path);
      await assertLease();
      if (reusableOutput) {
        this.logger.info(`Reusing ${provider.id} scene ${scene.index} from ${task.external_task_id}`);
        return { task, outputPath: task.output_path, reused: true };
      }
    }

    let taskCreatedThisInvocation = !task;
    if (!task) {
      await assertLease();
      if (this.db?.createMediaGenerationTask) {
        task = await this.db.createMediaGenerationTask({
          jobId, productionId, sceneIndex: scene.index, provider: provider.id, model: provider.model,
          status: 'submitting', request: this.safeRequest(request)
        });
        // A concurrent claimant may have inserted the unique task row after our
        // read. Only the caller that actually inserted it may submit the remote job.
        taskCreatedThisInvocation = task.createdByThisInvocation !== false;
      } else {
        task = { id: `media_${Date.now()}_${scene.index}`, status: 'submitting' };
      }
    }

    // A persisted submission without a remote ID is ambiguous: the process may
    // have crashed after the provider accepted the request but before the ID was
    // stored. Never submit a second paid request automatically in that state.
    if (!taskCreatedThisInvocation && !task.external_task_id &&
        ['submitting', 'submission_unknown', 'reconciliation_required'].includes(task.status)) {
      const error = new Error(
        `Media task ${task.id} has an unresolved provider submission without an external task ID. Automatic resubmission is blocked to avoid duplicate provider jobs; reconcile the provider dashboard before retrying.`
      );
      error.code = 'MEDIA_TASK_SUBMISSION_UNKNOWN';
      error.status = 409;
      throw error;
    }

    let remote;
    let remoteSubmissionAttempted = false;
    let remoteTaskId = task?.external_task_id || null;
    let previousTaskHistory = Array.isArray(task.providerData?.previousTasks)
      ? [...task.providerData.previousTasks]
      : [];
    const providerDataForTask = remote => ({
      ...this.providerData(remote),
      ...(previousTaskHistory.length ? { previousTasks: previousTaskHistory } : {})
    });
    const downloadPath = `${outputPath}.${crypto.randomUUID()}.part.mp4`;
    let outputPublished = false;
    try {
      await assertLease();
      const resumeExistingRemoteTask = Boolean(task.external_task_id && [
        'queued', 'running', 'submitting', 'submission_unknown',
        'reconciliation_required', 'downloading', 'download_pending', 'succeeded'
      ].includes(task.status));

      if (resumeExistingRemoteTask) {
        remote = await provider.getTask(task.external_task_id, task.providerData || {});
      } else {
        await this.assertNotCancelled(jobId, provider, task);

        // Write-ahead intent: once this row is reset to "submitting" with no
        // remote ID, a crash at any point around provider.createTask() becomes
        // an explicit ambiguous outcome. A retry will reconcile, never resubmit.
        if (!taskCreatedThisInvocation) {
          if (task.external_task_id) {
            previousTaskHistory.push({
              externalTaskId: task.external_task_id,
              status: task.status,
              outputPath: task.output_path || null,
              completedAt: task.completed_at || null
            });
            previousTaskHistory = previousTaskHistory.slice(-10);
          }
          task = await this.updateTask(task, {
            status: 'submitting',
            externalTaskId: null,
            providerData: previousTaskHistory.length ? { previousTasks: previousTaskHistory } : {},
            outputPath: null,
            error: null,
            completedAt: null
          });
          await assertLease();
        }

        remoteTaskId = null;
        remoteSubmissionAttempted = true;
        remote = await provider.createTask(request);
      }
      remoteTaskId = remote?.externalTaskId || remote?.id || remoteTaskId;
      if (!remoteTaskId) {
        const error = new Error(`${provider.id} did not return a remote task ID; provider submission outcome is unknown and will not be repeated automatically.`);
        error.code = 'MEDIA_TASK_SUBMISSION_UNKNOWN';
        error.status = 409;
        throw error;
      }
      await assertLease();
      task = await this.updateTask(task, {
        status: remote.status === 'succeeded' ? 'downloading' : remote.status,
        model: remote.model || task.model,
        externalTaskId: remoteTaskId,
        providerData: providerDataForTask(remote),
        error: remote.error || null
      });
      await assertLease();

      const started = Date.now();
      while (!TERMINAL.has(remote.status)) {
        if (Date.now() - started > this.maxPollMs) {
          const error = new Error(`${provider.id} did not finish within the configured timeout`);
          error.code = 'MEDIA_PROVIDER_TIMEOUT';
          throw error;
        }
        await assertLease();
        await this.assertNotCancelled(jobId, provider, task);
        await this.sleep(this.pollIntervalMs);
        await assertLease();
        remote = await provider.getTask(remote.externalTaskId, task.providerData || {});
        remoteTaskId = remote?.externalTaskId || remote?.id || remoteTaskId;
        await assertLease();
        task = await this.updateTask(task, {
          status: remote.status === 'succeeded' ? 'downloading' : remote.status,
          providerData: providerDataForTask(remote),
          error: remote.error || null
        });
        await assertLease();
      }

      if (remote.status !== 'succeeded') {
        const error = new Error(remote.error || `${provider.id} video generation ${remote.status}`);
        error.code = remote.status === 'cancelled' ? 'JOB_CANCELLED' : 'MEDIA_PROVIDER_FAILED';
        throw error;
      }

      await assertLease();
      await provider.downloadResult(remote, downloadPath);
      await assertLease();
      if (!await this.isValidVideo(downloadPath)) throw new Error(`${provider.id} returned an invalid MP4 asset`);
      await assertLease();
      await fs.rename(downloadPath, outputPath);
      outputPublished = true;
      await assertLease();
      task = await this.updateTask(task, {
        status: 'succeeded', outputPath, completedAt: new Date().toISOString(),
        providerData: providerDataForTask(remote), error: null
      });
      await assertLease();
      return { task, outputPath, reused: false };
    } catch (error) {
      await fs.unlink(downloadPath).catch(() => {});
      try {
        await assertLease();
      } catch (leaseError) {
        if (outputPublished) await fs.unlink(outputPath).catch(() => {});
        if (remoteTaskId && !TERMINAL.has(remote?.status)) {
          await this.cancelRemoteTaskOnLeaseLoss(provider, remoteTaskId);
        }
        throw leaseError;
      }
      const recoveryStatus = error.code === 'JOB_CANCELLED'
        ? 'cancelled'
        : (remoteSubmissionAttempted && !remoteTaskId)
          ? 'submission_unknown'
          : (remote?.status === 'succeeded')
            ? 'download_pending'
            : (remoteTaskId && (!remote || !TERMINAL.has(remote.status)))
              ? 'reconciliation_required'
              : 'failed';
      if (recoveryStatus === 'download_pending' && outputPublished) {
        await fs.unlink(outputPath).catch(() => {});
      }
      await this.updateTask(task, {
        status: recoveryStatus,
        externalTaskId: recoveryStatus === 'submission_unknown' ? null : undefined,
        outputPath: ['submission_unknown', 'reconciliation_required', 'download_pending'].includes(recoveryStatus)
          ? null
          : undefined,
        error: safeModelError(error),
        completedAt: ['failed', 'cancelled', 'submission_unknown'].includes(recoveryStatus)
          ? new Date().toISOString()
          : null
      });
      throw error;
    }
  }

  isSubmissionRecordStale(task, minimumAgeMs = 10 * 60 * 1000) {
    const updatedAt = Date.parse(task?.updated_at || '');
    return Number.isFinite(updatedAt) && Date.now() - updatedAt >= minimumAgeMs;
  }

  async reconcileTaskSubmission(taskId, externalTaskId, options = {}) {
    const remoteId = String(externalTaskId || '').trim();
    if (!remoteId || remoteId.length > 512) {
      const error = new Error('A valid external provider task ID is required');
      error.code = 'INVALID_EXTERNAL_TASK_ID';
      error.status = 400;
      throw error;
    }
    if (typeof this.db?.getMediaGenerationTaskById !== 'function') {
      const error = new Error('Media task reconciliation requires database task lookup support');
      error.code = 'MEDIA_TASK_RECONCILIATION_UNAVAILABLE';
      error.status = 503;
      throw error;
    }

    const task = await this.db.getMediaGenerationTaskById(taskId);
    if (!task) {
      const error = new Error(`Media generation task not found: ${taskId}`);
      error.code = 'MEDIA_TASK_NOT_FOUND';
      error.status = 404;
      throw error;
    }
    if (!['submitting', 'submission_unknown', 'reconciliation_required'].includes(task.status)) {
      const error = new Error(`Media task ${taskId} is not awaiting remote-task reconciliation`);
      error.code = 'MEDIA_TASK_NOT_RECONCILABLE';
      error.status = 409;
      throw error;
    }
    if (task.status === 'submitting' && !this.isSubmissionRecordStale(task)) {
      const error = new Error('This provider submission is still recent; wait at least 10 minutes before manually attaching a remote task ID');
      error.code = 'MEDIA_TASK_SUBMISSION_STILL_ACTIVE';
      error.status = 409;
      throw error;
    }
    if (task.external_task_id && task.external_task_id !== remoteId) {
      const error = new Error('This task already references a different external provider task ID');
      error.code = 'MEDIA_TASK_REMOTE_ID_CONFLICT';
      error.status = 409;
      throw error;
    }

    const provider = this.registry.get(task.provider);
    if (!provider || typeof provider.getTask !== 'function') {
      const error = new Error(`Provider ${task.provider} cannot query remote task status`);
      error.code = 'MEDIA_PROVIDER_STATUS_UNAVAILABLE';
      error.status = 422;
      throw error;
    }

    const providerTaskType = options.providerTaskType;
    if (providerTaskType !== undefined &&
        !['text2video', 'image2video'].includes(providerTaskType)) {
      const error = new Error('Provider task type must be text2video or image2video');
      error.code = 'INVALID_PROVIDER_TASK_TYPE';
      error.status = 400;
      throw error;
    }
    const context = { ...(task.providerData || {}) };
    if (providerTaskType) context.taskType = providerTaskType;

    const remote = await provider.getTask(remoteId, context);
    if (remote?.externalTaskId && remote.externalTaskId !== remoteId) {
      const error = new Error('Provider returned a different task ID during reconciliation');
      error.code = 'MEDIA_TASK_REMOTE_ID_MISMATCH';
      error.status = 409;
      throw error;
    }
    if (!['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(remote?.status)) {
      const error = new Error('Provider returned an unsupported remote task status during reconciliation');
      error.code = 'MEDIA_TASK_REMOTE_STATUS_UNKNOWN';
      error.status = 422;
      throw error;
    }

    const status = remote.status === 'succeeded' ? 'download_pending' : remote.status;
    const previousTasks = Array.isArray(task.providerData?.previousTasks)
      ? task.providerData.previousTasks
      : [];
    return this.db.updateMediaGenerationTask(taskId, {
      externalTaskId: remoteId,
      status,
      outputPath: null,
      providerData: {
        ...this.providerData(remote),
        ...(previousTasks.length ? { previousTasks } : {}),
        ...(providerTaskType ? { taskType: providerTaskType } : {})
      },
      error: remote.error || null,
      completedAt: ['failed', 'cancelled'].includes(status) ? new Date().toISOString() : null
    });
  }

  async resolveAmbiguousSubmissionAsAbsent(taskId, confirmedNoRemoteTask) {
    if (confirmedNoRemoteTask !== true) {
      const error = new Error('Explicit operator confirmation that no remote provider task exists is required');
      error.code = 'REMOTE_TASK_ABSENCE_CONFIRMATION_REQUIRED';
      error.status = 400;
      throw error;
    }
    if (typeof this.db?.getMediaGenerationTaskById !== 'function') {
      const error = new Error('Media task resolution requires database task lookup support');
      error.code = 'MEDIA_TASK_RECONCILIATION_UNAVAILABLE';
      error.status = 503;
      throw error;
    }
    const task = await this.db.getMediaGenerationTaskById(taskId);
    if (!task) {
      const error = new Error(`Media generation task not found: ${taskId}`);
      error.code = 'MEDIA_TASK_NOT_FOUND';
      error.status = 404;
      throw error;
    }
    if (!['submitting', 'submission_unknown', 'reconciliation_required'].includes(task.status) ||
        task.external_task_id) {
      const error = new Error('Only unresolved submissions without a remote task ID can be resolved as absent');
      error.code = 'MEDIA_TASK_NOT_RESOLVABLE_AS_ABSENT';
      error.status = 409;
      throw error;
    }
    if (task.status === 'submitting' && !this.isSubmissionRecordStale(task)) {
      const error = new Error('This provider submission is still recent; wait at least 10 minutes and inspect the provider dashboard before resolving it as absent');
      error.code = 'MEDIA_TASK_SUBMISSION_STILL_ACTIVE';
      error.status = 409;
      throw error;
    }

    const now = new Date().toISOString();
    const previousTasks = Array.isArray(task.providerData?.previousTasks)
      ? task.providerData.previousTasks
      : [];
    return this.db.updateMediaGenerationTask(taskId, {
      status: 'failed',
      externalTaskId: null,
      outputPath: null,
      providerData: {
        ...(previousTasks.length ? { previousTasks } : {}),
        operatorResolution: {
          action: 'confirmed_no_remote_task',
          confirmedAt: now
        }
      },
      error: 'Operator confirmed that no remote provider task exists; a new attempt may now be submitted',
      completedAt: now
    });
  }

  async cancelRemoteTaskOnLeaseLoss(provider, taskId) {
    if (!taskId) return;
    if (!provider?.capabilities?.cancellation || typeof provider.cancelTask !== 'function') {
      this.logger.warn(`Lease lost while remote task ${taskId} was active; provider ${provider?.id || 'unknown'} does not support cancellation.`);
      return;
    }
    try {
      await provider.cancelTask(taskId);
      this.logger.warn(`Cancelled remote task ${taskId} after generation lease loss.`);
    } catch (error) {
      this.logger.warn(`Could not cancel remote task ${taskId} after lease loss: ${safeModelError(error)}`);
    }
  }

  safeRequest(request) {
    const reference = value => value ? path.basename(String(value)) : null;
    return {
      prompt: String(request.prompt || '').slice(0, 2000),
      duration: request.duration,
      resolution: request.resolution,
      aspectRatio: request.aspectRatio,
      generateAudio: request.generateAudio,
      firstFrame: reference(request.firstFrame),
      lastFrame: reference(request.lastFrame),
      referenceImages: (request.referenceImages || []).map(reference),
      referenceVideos: (request.referenceVideos || []).map(reference),
      referenceAudios: (request.referenceAudios || []).map(reference)
    };
  }

  providerData(remote = {}) {
    return {
      outputUrl: remote.outputUrl || null,
      taskType: remote.taskType || null,
      model: remote.model || null
    };
  }

  async updateTask(task, changes) {
    if (!this.db?.updateMediaGenerationTask) return {
      ...task,
      ...changes,
      external_task_id: changes.externalTaskId === undefined ? task.external_task_id : changes.externalTaskId,
      output_path: changes.outputPath === undefined ? task.output_path : changes.outputPath,
      providerData: changes.providerData === undefined ? task.providerData : changes.providerData
    };
    return this.db.updateMediaGenerationTask(task.id, changes);
  }

  async assertNotCancelled(jobId, provider, task) {
    if (!jobId || !this.db?.getGenerationJob) return;
    const job = await this.db.getGenerationJob(jobId);
    if (!job?.cancelRequested) return;
    if (task?.external_task_id && provider.capabilities.cancellation) {
      await provider.cancelTask(task.external_task_id).catch(() => {});
    }
    const error = new Error(job.details?.cancelReason || 'Generation cancelled by operator');
    error.code = 'JOB_CANCELLED';
    throw error;
  }

  async isValidVideo(filePath) {
    try {
      const buffer = await fs.readFile(filePath);
      if (buffer.length < 1000 || !buffer.subarray(4, 32).toString('ascii').includes('ftyp')) return false;
      await runFFmpeg(['-v', 'error', '-i', filePath, '-f', 'null', '-']);
      return true;
    } catch (_error) {
      return false;
    }
  }
}

module.exports = { MediaGenerationService };
