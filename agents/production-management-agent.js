const path = require('path');
const crypto = require('crypto');
const fs = require('fs').promises;
const sharp = require('sharp');
const { Logger } = require('../utils/logger');
const { AIVideoGenerator } = require('../utils/ai-video-generator');
const { SceneRepairService } = require('../utils/scene-repair-service');
const { runFFmpeg, getMediaInfo, getAudioInfo } = require('../utils/ffmpeg');
const { mixBackgroundMusic } = require('../utils/audio-mixer');
const { buildSubtitleFilter, describeSubtitleApplication, validateSrtContent } = require('../utils/subtitle-renderer');
const { requireApprovedVideoConcept } = require('../utils/approved-video-concept-gate');
const { createProductionWorkflow, runProductionStage, prepareProductionWorkflowForResume } = require('../utils/production-stage-workflow');
const { assertScriptQualityGate } = require('../utils/script-quality-gate');

function getArtifactAttemptId(productionData) {
  if (!productionData.timeline || typeof productionData.timeline !== 'object') {
    productionData.timeline = {};
  }
  if (!productionData.timeline.artifactAttemptId) {
    productionData.timeline.artifactAttemptId = crypto.randomUUID();
  }
  return String(productionData.timeline.artifactAttemptId).replace(/[^a-zA-Z0-9_-]/g, '');
}

async function removeAttemptFiles(filePaths = [], preservedPaths = []) {
  const preserved = new Set(preservedPaths.filter(filePath => typeof filePath === 'string' && filePath).map(filePath => path.resolve(filePath)));
  const uniquePaths = new Set(
    filePaths
      .filter(filePath => typeof filePath === 'string' && filePath)
      .map(filePath => path.resolve(filePath))
      .filter(filePath => !preserved.has(filePath))
  );
  await Promise.all([...uniquePaths].map(filePath => fs.rm(filePath, { force: true, recursive: true }).catch(() => {})));
}

function getVideoAttemptSidecarPaths(videoPath) {
  if (typeof videoPath !== 'string' || !videoPath) return [];
  const resolved = path.resolve(videoPath);
  const extension = path.extname(resolved).toLowerCase();
  if (extension !== '.mp4') return [resolved];
  const stem = resolved.slice(0, -extension.length);
  const hybridVisual = stem + '_hybrid_visual.mp4';
  const paths = [
    resolved,
    resolved + '.info',
    resolved + '.assembly.json',
    resolved + '.assembly.json.tmp',
    hybridVisual,
    stem + '_hybrid_visual_rendering.mp4',
    hybridVisual + '.render.json',
    hybridVisual + '.render.json.tmp',
    stem + '_finalizing.mp4',
    stem + '_visual.mp4',
    stem + '_slides'
  ];
  for (let index = 1; index <= 20; index++) {
    const scenePath = `${stem}_cinecode_scene_${String(index).padStart(2, '0')}.mp4`;
    paths.push(scenePath, scenePath + '.rendering.mp4', scenePath + '.render.json', scenePath + '.render.json.tmp');
  }
  return paths;
}


function isLeaseFailure(error) {
  const code = String(error?.code || '').toUpperCase();
  return code.includes('LEASE') || code.includes('LOCK_LOST') || code.includes('LOCK_UNVERIFIED');
}

class ProductionManagementAgent {
  constructor(db, credentials, options = {}) {
    this.db = db;
    this.credentials = credentials;
    this.logger = new Logger('ProductionManagement');
    this.pipeline = [];
    this.assets = new Map();
    this.aiVideoGenerator = new AIVideoGenerator(credentials, { db });
    this.sceneRepair = new SceneRepairService(db, this.aiVideoGenerator, { logger: this.logger });
    this.audioMixer = options.audioMixer || mixBackgroundMusic;
    this.audioMixerDependencies = {
      runFFmpeg: options.runFFmpeg || runFFmpeg,
      getMediaInfo: options.getMediaInfo || getMediaInfo,
      getAudioInfo: options.getAudioInfo || getAudioInfo
    };
  }

  async initialize() {
    this.logger.info('Initializing Production Management Agent...');
    await this.setupDirectories();
    await this.loadPipeline();
    return true;
  }

  async setupDirectories() {
    const dirs = [
      'data/production',
      'data/assets',
      'data/videos',
      'data/audio',
      'data/scripts',
      'temp/processing'
    ];

    for (const dir of dirs) {
      await fs.mkdir(path.join(__dirname, '..', dir), { recursive: true });
    }
  }

  async loadPipeline() {
    try {
      const pipeline = await this.db.getProductionPipeline();
      this.pipeline = pipeline || [];
    } catch (error) {
      this.logger.warn('No existing pipeline found, starting fresh');
    }
  }

  async processContent(contentData) {
    const jobId = contentData?.jobId;
    const upstreamAssertLease = typeof contentData?.assertLease === 'function'
      ? contentData.assertLease
      : async () => {};
    if (!jobId) return this.processContentUnlocked(contentData, upstreamAssertLease);
    if (typeof this.db.acquireProductionOperationLock !== 'function' ||
        typeof this.db.renewProductionOperationLock !== 'function' ||
        typeof this.db.releaseProductionOperationLock !== 'function') {
      const error = new Error('Job production requires database acquire, renew, and release operation-lock support');
      error.code = 'PRODUCTION_JOB_LOCK_UNAVAILABLE';
      error.status = 503;
      throw error;
    }
    const lockId = `job:${jobId}`;
    const owner = `job_${process.pid}_${crypto.randomUUID()}`;
    const leaseMs = 2 * 60 * 60 * 1000;
    const acquired = await this.db.acquireProductionOperationLock(lockId, owner, leaseMs);
    if (!acquired) {
      const error = new Error(`Generation job ${jobId} is already being processed`);
      error.code = 'PRODUCTION_JOB_LOCKED';
      error.status = 409;
      throw error;
    }
    let leaseFailure = null;
    let renewalInFlight = Promise.resolve();
    const assertLease = async () => {
      await upstreamAssertLease();
      await renewalInFlight;
      if (leaseFailure) throw leaseFailure;
    };
    // This wrapper owns a distinct job:<id> lock in addition to any upstream
    // generation-job lease. Pass its identity to all fenced DB writes.
    assertLease.lease = Object.freeze({ productionId: lockId, owner });
    const heartbeat = setInterval(() => {
      renewalInFlight = renewalInFlight.then(async () => {
        if (leaseFailure) return;
        try {
          const renewed = await this.db.renewProductionOperationLock(lockId, owner, leaseMs);
          if (!renewed) leaseFailure = Object.assign(
            new Error(`Generation job lease lost for ${jobId}`),
            { code: 'PRODUCTION_JOB_LEASE_LOST', status: 409 }
          );
        } catch (cause) {
          leaseFailure = Object.assign(
            new Error(`Generation job lease could not be verified for ${jobId}: ${cause.message}`),
            { code: 'PRODUCTION_JOB_LEASE_UNVERIFIED', status: 503 }
          );
        }
      });
    }, 30_000);
    heartbeat.unref?.();
    try {
      return await this.processContentUnlocked(contentData, assertLease);
    } finally {
      clearInterval(heartbeat);
      await renewalInFlight.catch(() => {});
      await this.db.releaseProductionOperationLock(lockId, owner).catch(error => {
        this.logger.error('Failed to release generation job lock:', error);
      });
    }
  }

  async processContentUnlocked(contentData, assertLease = async () => {}) {
    await assertLease();
    let productionData = null;
    try {
      this.logger.info('Processing content for production...');
      
      const { strategy: inputStrategy, script, thumbnail, seo, jobId = null } = contentData;
      assertScriptQualityGate(script);
      const requestedConceptId = contentData.approvedConceptId ||
        inputStrategy?.approvedVideoConceptId ||
        inputStrategy?.approvedVideoConcept?.id;
      const approvedConcept = await requireApprovedVideoConcept(this.db, requestedConceptId);
      const strategy = {
        ...(inputStrategy || {}),
        approvedVideoConcept: approvedConcept.concept,
        approvedVideoConceptId: approvedConcept.id
      };

      // A failed generation-stage retry must resume the persisted production for
      // this job instead of creating a duplicate production and repeating media work.
      if (jobId && typeof this.db.getProductionBundleByJobId === 'function') {
        const existing = await this.db.getProductionBundleByJobId(jobId);
        await assertLease();
        if (existing) {
          if (existing.script?.title !== script?.title ||
              existing.timeline?.jobId !== jobId) {
            throw new Error('A persisted production exists for this job but its script/job identity does not match; refusing duplicate production');
          }
          this.logger.info(`Resuming persisted production ${existing.id} for generation job ${jobId}`);
          return this.resumeProduction(existing.id, assertLease);
        }
      }

      // Create production entry
      const productionId = this.generateProductionId();
      
      productionData = {
        id: productionId,
        strategy,
        script,
        thumbnail,
        seo,
        status: 'processing',
        assets: {
          script: await this.processScript(script, assertLease),
          thumbnail: await this.processThumbnail(thumbnail, script, assertLease),
          audio: null, // Will be generated later
          video: null, // Will be generated later
          captions: null // Will be generated later
        },
        timeline: {
          created: new Date().toISOString(),
          scriptReady: new Date().toISOString(),
          thumbnailReady: new Date().toISOString(),
          audioGenerated: null,
          videoGenerated: null,
          captionsGenerated: null,
          readyForUpload: null,
          jobId,
          artifactAttemptId: crypto.randomUUID()
        },
        scheduledPublishTime: this.calculatePublishTime(strategy),
        priority: this.calculatePriority(strategy),
        estimatedDuration: script.duration,
        createdAt: new Date().toISOString()
      };
      productionData.jobId = jobId;
      productionData.timeline.productionWorkflow = createProductionWorkflow(approvedConcept.id);
      const persistWorkflow = async () => { await assertLease(); return this.db.updateProductionData(productionData, assertLease.lease || null); };
      
      // Add to pipeline
      this.pipeline.push(productionData);
      
      // Save to database
      await assertLease();
      await this.db.saveProductionData(productionData, assertLease.lease || null);
      await assertLease();
      await this.db.saveProductionSnapshot(productionData, assertLease.lease || null);
      
      // Persist stage transitions so interrupted or failed work is visible in the production record.
      await runProductionStage(
        productionData.timeline.productionWorkflow,
        'visuals',
        async () => {
          const assets = await this.generateVideoContent(productionData, assertLease);
          const realAssets = Array.isArray(assets)
            ? assets.filter(asset => typeof asset === 'string' && path.extname(asset).toLowerCase() !== '.info')
            : [];
          if (!realAssets.length) throw new Error('Visual stage produced placeholder assets only; configure a working image provider before retrying');
          return { assetCount: realAssets.length };
        },
        persistWorkflow
      );
      try {
        await runProductionStage(
          productionData.timeline.productionWorkflow,
          'narration',
          async () => {
            const audioPath = await this.generateAudioNarration(productionData, assertLease);
            if (productionData.assets.audio?.simulated || productionData.assets.audio?.status !== 'ready') {
              throw new Error(productionData.assets.audio?.error || 'Narration stage produced simulated audio only');
            }
            return { audioPath, provider: productionData.assets.audio.provider || null };
          },
          persistWorkflow
        );
      } catch (error) {
        // Lease ownership is gone or unverifiable: preserve every artifact for the current owner/recovery.
        throw error;
      }
      try {
        await runProductionStage(
          productionData.timeline.productionWorkflow,
          'editing',
          async () => {
            await this.generateCaptions(productionData, assertLease);
            await this.assembleVideo(productionData, assertLease);
            const finalVideo = productionData.assets.finalVideo;
            if (!finalVideo || finalVideo.simulated || path.extname(finalVideo.path || '').toLowerCase() !== '.mp4') {
              throw new Error(finalVideo?.blockedReason || 'Production editing did not produce a real MP4 final video');
            }
            await this.sceneRepair.initializeProduction(productionData, this.aiVideoGenerator.lastVideoResult || {}, assertLease);
            return {
              captionsGenerated: Boolean(productionData.assets.captions?.path),
              finalVideoGenerated: Boolean(productionData.assets.finalVideo?.path),
              simulated: Boolean(productionData.assets.finalVideo?.simulated)
            };
          },
          persistWorkflow
        );
      } catch (error) {
        // Lease ownership is gone or unverifiable: preserve every artifact for the current owner/recovery.
        throw error;
      }
      // Mark as ready — or simulated, when no real video could be produced
      await assertLease();
      const finalVideo = productionData.assets.finalVideo;
      if (!finalVideo || finalVideo.simulated || path.extname(finalVideo.path || '').toLowerCase() !== '.mp4') {
        throw new Error('Production cannot be marked ready without a real MP4 final video');
      }
      await assertLease();
      productionData.status = 'ready';
      productionData.timeline.readyForUpload = new Date().toISOString();

      await assertLease();
      await this.db.updateProductionData(productionData, assertLease.lease || null);

      this.logger.info(`Content processing complete: ${productionId} (status: ${productionData.status})`);
      return productionData;
    } catch (error) {
      this.logger.error('Failed to process content:', error);
      if (productionData?.id) {
        await assertLease();
        productionData.status = 'failed';
        productionData.timeline.lastProductionError = String(error?.message || error).slice(0, 500);
        await this.db.updateProductionData(productionData, assertLease.lease || null).catch(persistError => {
          this.logger.error('Failed to persist production failure state:', persistError);
        });
      }
      throw error;
    }
  }

  async resumeProduction(productionId, upstreamAssertLease = async () => {}) {
    if (typeof this.db.acquireProductionOperationLock !== 'function' ||
        typeof this.db.renewProductionOperationLock !== 'function' ||
        typeof this.db.releaseProductionOperationLock !== 'function') {
      const error = new Error('Production resume requires database acquire, renew, and release operation-lock support');
      error.code = 'PRODUCTION_OPERATION_LOCK_UNAVAILABLE';
      error.status = 503;
      throw error;
    }
    const owner = `resume_${process.pid}_${crypto.randomUUID()}`;
    const leaseMs = 2 * 60 * 60 * 1000;
    const acquired = await this.db.acquireProductionOperationLock(productionId, owner, leaseMs);
    if (!acquired) {
      const error = new Error(`Production ${productionId} is already being processed by another worker`);
      error.code = 'PRODUCTION_OPERATION_LOCKED';
      error.status = 409;
      throw error;
    }

    let leaseFailure = null;
    let renewalInFlight = Promise.resolve();
    const assertLease = async () => {
      await upstreamAssertLease();
      await renewalInFlight;
      if (leaseFailure) throw leaseFailure;
    };
    assertLease.lease = Object.freeze({ productionId, owner });
    const heartbeat = setInterval(() => {
      renewalInFlight = renewalInFlight.then(async () => {
        if (leaseFailure) return;
        try {
          const renewed = await this.db.renewProductionOperationLock(productionId, owner, leaseMs);
          if (!renewed) {
            leaseFailure = Object.assign(
              new Error(`Production resume lease lost for ${productionId}`),
              { code: 'PRODUCTION_RESUME_LEASE_LOST', status: 409 }
            );
          }
        } catch (cause) {
          leaseFailure = Object.assign(
            new Error(`Production resume lease could not be verified for ${productionId}: ${cause.message}`),
            { code: 'PRODUCTION_RESUME_LEASE_UNVERIFIED', status: 503 }
          );
        }
      });
    }, 30_000);
    heartbeat.unref?.();

    try {
      return await this.resumeProductionUnlocked(productionId, assertLease);
    } finally {
      clearInterval(heartbeat);
      await renewalInFlight.catch(() => {});
      await this.db.releaseProductionOperationLock(productionId, owner).catch(error => {
        this.logger.error('Failed to release production resume lock:', error);
      });
    }
  }

  async resumeProductionUnlocked(productionId, assertLease = async () => {}) {
    await assertLease();
    const stored = await this.db.getProductionBundle(productionId);
    if (!stored) throw new Error(`Production not found: ${productionId}`);
    const approvedConcept = await requireApprovedVideoConcept(
      this.db,
      stored.strategy?.approvedVideoConceptId || stored.strategy?.approvedVideoConcept?.id
    );
    const productionData = {
      id: stored.id,
      strategy: {
        ...(stored.strategy || {}),
        approvedVideoConcept: approvedConcept.concept,
        approvedVideoConceptId: approvedConcept.id
      },
      script: stored.script,
      thumbnail: stored.thumbnail,
      seo: stored.seo,
      assets: stored.assets || {},
      timeline: { ...(stored.timeline || {}), artifactAttemptId: crypto.randomUUID() },
      scheduledPublishTime: stored.scheduled_publish_time,
      priority: stored.priority,
      estimatedDuration: stored.estimated_duration,
      jobId: stored.timeline?.jobId || null,
      status: 'processing'
    };
    assertScriptQualityGate(productionData.script);
    const workflow = productionData.timeline.productionWorkflow;
    const nextStage = prepareProductionWorkflowForResume(workflow);
    if (!nextStage) {
      const finalVideo = productionData.assets.finalVideo;
      if (!finalVideo || finalVideo.simulated || path.extname(finalVideo.path || '').toLowerCase() !== '.mp4') {
        productionData.status = 'failed';
        productionData.timeline.lastProductionError = 'Completed stage records do not contain a real MP4 final video';
        await assertLease();
        await this.db.updateProductionData(productionData, assertLease.lease || null);
        throw new Error(productionData.timeline.lastProductionError);
      }
      productionData.status = 'ready';
      await assertLease();
      await this.db.updateProductionData(productionData, assertLease.lease || null);
      return productionData;
    }
    const persistWorkflow = async () => { await assertLease(); return this.db.updateProductionData(productionData, assertLease.lease || null); };
    try {
      await assertLease();
      if (workflow.stages.visuals.status !== 'completed') {
        await runProductionStage(workflow, 'visuals', async () => {
          const assets = await this.generateVideoContent(productionData, assertLease);
          const realAssets = Array.isArray(assets)
            ? assets.filter(asset => typeof asset === 'string' && path.extname(asset).toLowerCase() !== '.info')
            : [];
          if (!realAssets.length) throw new Error('Visual stage produced placeholder assets only; configure a working image provider before retrying');
          return { assetCount: realAssets.length };
        }, persistWorkflow);
      }
      await assertLease();
      if (workflow.stages.narration.status !== 'completed') {
        try {
          await runProductionStage(workflow, 'narration', async () => {
            const audioPath = await this.generateAudioNarration(productionData, assertLease);
            if (productionData.assets.audio?.simulated || productionData.assets.audio?.status !== 'ready') {
              throw new Error(productionData.assets.audio?.error || 'Narration stage produced simulated audio only');
            }
            return { audioPath, provider: productionData.assets.audio.provider || null };
          }, persistWorkflow);
        } catch (error) {
          // Lease ownership is gone or unverifiable: preserve every artifact for the current owner/recovery.
          throw error;
        }
      }
      await assertLease();
      if (workflow.stages.editing.status !== 'completed') {
        try {
          await runProductionStage(workflow, 'editing', async () => {
            await this.generateCaptions(productionData, assertLease);
            await this.assembleVideo(productionData, assertLease);
            const finalVideo = productionData.assets.finalVideo;
            if (!finalVideo || finalVideo.simulated || path.extname(finalVideo.path || '').toLowerCase() !== '.mp4') {
              throw new Error(finalVideo?.blockedReason || 'Production editing did not produce a real MP4 final video');
            }
            await this.sceneRepair.initializeProduction(productionData, this.aiVideoGenerator.lastVideoResult || {}, assertLease);
            return {
              captionsGenerated: Boolean(productionData.assets.captions?.path),
              finalVideoGenerated: Boolean(productionData.assets.finalVideo?.path),
              simulated: Boolean(productionData.assets.finalVideo?.simulated)
            };
          }, persistWorkflow);
        } catch (error) {
          // Lease ownership is gone or unverifiable: preserve every artifact for the current owner/recovery.
          throw error;
        }
      }
      await assertLease();
      const finalVideo = productionData.assets.finalVideo;
      if (!finalVideo || finalVideo.simulated || path.extname(finalVideo.path || '').toLowerCase() !== '.mp4') {
        throw new Error('Production cannot be marked ready without a real MP4 final video');
      }
      productionData.status = 'ready';
      productionData.timeline.readyForUpload = new Date().toISOString();
      await assertLease();
      await this.db.updateProductionData(productionData, assertLease.lease || null);
      const index = this.pipeline.findIndex(item => item.id === productionId);
      if (index >= 0) this.pipeline[index] = productionData;
      else this.pipeline.push(productionData);
      return productionData;
    } catch (error) {
      await assertLease();
      productionData.status = 'failed';
      productionData.timeline.lastProductionError = String(error?.message || error).slice(0, 500);
      await this.db.updateProductionData(productionData, assertLease.lease || null);
      throw error;
    }
  }

  generateProductionId() {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 15);
    const extra = Math.random().toString(36).substring(2, 15);
    return `prod_${timestamp}_${random}_${extra}`;
  }

  async processScript(script, assertLease = async () => {}) {
    const scriptPath = path.join(__dirname, '..', 'data', 'scripts', `${Date.now()}_script.json`);
    
    // Create formatted script for TTS
    const ttsScript = this.formatScriptForTTS(script);
    
    // Check ownership immediately before each filesystem side effect. A
    // generation worker that lost its job lease must not publish script files.
    await assertLease();
    await fs.writeFile(scriptPath, JSON.stringify(script, null, 2));
    await assertLease();
    await fs.writeFile(
      scriptPath.replace('.json', '_tts.txt'), 
      ttsScript
    );
    await assertLease();
    
    return {
      originalPath: scriptPath,
      ttsPath: scriptPath.replace('.json', '_tts.txt'),
      duration: script.duration,
      sections: script.mainContent.sections.length
    };
  }

  formatScriptForTTS(script) {
    let ttsText = '';
    
    // Add hook
    if (script.hook) {
      ttsText += `${script.hook.text}\n\n`;
    }
    
    // Add introduction
    if (script.introduction) {
      ttsText += `${script.introduction.greeting}\n`;
      ttsText += `${script.introduction.topicIntro}\n`;
      ttsText += `${script.introduction.valueProposition}\n`;
      ttsText += `${script.introduction.credibility}\n\n`;
    }
    
    // Add main content
    if (script.mainContent && script.mainContent.sections) {
      script.mainContent.sections.forEach((section, index) => {
        ttsText += `Section ${index + 1}: ${section.title}\n`;
        
        if (Array.isArray(section.content)) {
          section.content.forEach(line => {
            if (typeof line === 'string' && !line.startsWith('[')) {
              ttsText += `${line}\n`;
            }
          });
        } else if (section.steps) {
          section.steps.forEach(step => {
            ttsText += `${step.title}. ${step.description}\n`;
            ttsText += `${step.tip}\n`;
          });
        } else if (section.items) {
          section.items.forEach(item => {
            ttsText += `Number ${item.number}: ${item.title}. ${item.description}\n`;
          });
        } else if (typeof section.content === 'string') {
          ttsText += `${section.content}\n`;
        }
        
        ttsText += '\n';
      });
    }
    
    // Add conclusion
    if (script.conclusion) {
      script.conclusion.recap.forEach(line => {
        if (typeof line === 'string') {
          ttsText += `${line}\n`;
        }
      });
      ttsText += `\n${script.conclusion.finalThought}\n\n`;
    }
    
    // Add CTA
    if (script.callToAction) {
      ttsText += `${script.callToAction.subscribe}\n`;
      ttsText += `${script.callToAction.like}\n`;
      ttsText += `${script.callToAction.comment}\n`;
    }
    
    return ttsText;
  }

  async processThumbnail(thumbnail, script, assertLease = async () => {}) {
    try {
      // Try to generate AI thumbnail first
      await assertLease();
      const thumbnailScript = thumbnail.script || script || { title: thumbnail.title || 'Untitled Video' };
      const aiThumbnail = await this.aiVideoGenerator.generateThumbnail(thumbnailScript, 'ethereal', assertLease);
      await assertLease();

      // generateThumbnail returns a simulated placeholder instead of throwing when
      // no image provider works; the designer's real image beats that placeholder.
      if (!aiThumbnail.simulated) {
        return {
          path: aiThumbnail.path,
          originalPath: thumbnail.path,
          dimensions: aiThumbnail.dimensions,
          fileSize: aiThumbnail.fileSize,
          thumbnailRecordId: thumbnail.id || null,
          generatedWith: 'AI'
        };
      }
    } catch (error) {
      // Do not turn lease loss into a thumbnail fallback write.
      await assertLease();
      this.logger.error('AI thumbnail generation failed:', error);
    }

    // Fallback to original processing
    const productionThumbnailPath = path.join(
      __dirname, '..', 'data', 'assets',
      `thumbnail_${Date.now()}_${crypto.randomUUID()}.jpg`
    );

    if (thumbnail.path && await fs.access(thumbnail.path).then(() => true).catch(() => false)) {
      const originalBuffer = await fs.readFile(thumbnail.path);
      await assertLease();
      await fs.mkdir(path.dirname(productionThumbnailPath), { recursive: true });
      await assertLease();
      try {
        await fs.writeFile(productionThumbnailPath, originalBuffer);
        await assertLease();
      } catch (error) {
        await fs.rm(productionThumbnailPath, { force: true }).catch(() => {});
        throw error;
      }
      return {
        path: productionThumbnailPath,
        originalPath: thumbnail.path,
        dimensions: thumbnail.dimensions || { width: 1792, height: 1024 },
        fileSize: thumbnail.fileSize || 0,
        thumbnailRecordId: thumbnail.id || null
      };
    }

    // Create placeholder
    await assertLease();
    await fs.mkdir(path.dirname(productionThumbnailPath), { recursive: true });
    await assertLease();
    await fs.writeFile(productionThumbnailPath + '.placeholder', 'Thumbnail placeholder');
    return {
      path: productionThumbnailPath + '.placeholder',
      originalPath: thumbnail.path,
      dimensions: thumbnail.dimensions || { width: 1792, height: 1024 },
      fileSize: 0,
      thumbnailRecordId: thumbnail.id || null,
      simulated: true
    };
  }

  calculatePublishTime(strategy) {
    // Use strategy's recommended time or calculate optimal time
    if (strategy.bestPublishTime) {
      return strategy.bestPublishTime;
    }
    
    // Default: next optimal publishing window
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    tomorrow.setHours(14, 0, 0, 0); // 2 PM default
    
    return tomorrow.toISOString();
  }

  calculatePriority(strategy) {
    let priority = 50; // Base priority
    
    // Adjust based on estimated views
    if (strategy.estimatedViews > 100000) priority += 30;
    else if (strategy.estimatedViews > 50000) priority += 20;
    else if (strategy.estimatedViews > 10000) priority += 10;
    
    // Adjust based on trend score
    if (strategy.competitorAnalysis && strategy.competitorAnalysis.length > 0) {
      priority += 10;
    }
    
    // Time sensitivity
    const hoursUntilPublish = (new Date(strategy.bestPublishTime) - new Date()) / (1000 * 60 * 60);
    if (hoursUntilPublish < 24) priority += 20;
    else if (hoursUntilPublish < 48) priority += 10;
    
    return Math.min(100, priority);
  }

  async generateVideoContent(productionData, assertLease = async () => {}) {
    await assertLease();
    this.logger.info('Generating AI video content with resumable scene assets...');

    const { script } = productionData;
    const approvedConcept = productionData.strategy?.approvedVideoConcept || null;
    const visualPrompts = this.createVisualPromptsFromScript(script, approvedConcept);
    const profile = await this.db.getChannelProfile?.() || {};
    const visualStyle = profile.visual_style || 'ethereal';
    const existingScenes = Array.isArray(productionData.assets.video?.visualSceneAssets)
      ? productionData.assets.video.visualSceneAssets
      : [];
    const scenesByIndex = new Map(existingScenes.map(scene => [scene.sceneIndex, scene]));
    const visualAssets = [];
    const failures = [];

    const isUsableImage = async filePath => {
      if (typeof filePath !== 'string' || !filePath.trim()) return false;
      if (!['.png', '.jpg', '.jpeg', '.webp'].includes(path.extname(filePath).toLowerCase())) return false;
      try {
        const stats = await fs.stat(filePath);
        if (!stats.isFile() || stats.size <= 0) return false;
        const metadata = await sharp(filePath, { failOn: 'error' }).metadata();
        return Boolean(
          metadata.width &&
          metadata.height &&
          ['png', 'jpeg', 'webp'].includes(metadata.format)
        );
      } catch (_error) {
        return false;
      }
    };

    for (let sceneIndex = 0; sceneIndex < visualPrompts.length; sceneIndex++) {
      const prompt = visualPrompts[sceneIndex];
      const promptHash = crypto.createHash('sha256')
        .update(JSON.stringify({ prompt, visualStyle }))
        .digest('hex');
      const previous = scenesByIndex.get(sceneIndex);

      if (previous?.promptHash === promptHash && await isUsableImage(previous.path)) {
        visualAssets.push(previous.path);
        continue;
      }

      try {
        await assertLease();
        const generated = await this.aiVideoGenerator.generateVisualAssets(prompt, visualStyle, 1, assertLease);
        await assertLease();
        const imagePath = Array.isArray(generated)
          ? generated.find(candidate => typeof candidate === 'string' && path.extname(candidate).toLowerCase() !== '.info')
          : null;
        if (!await isUsableImage(imagePath)) {
          throw new Error('Image provider returned no valid image file; placeholder assets are not accepted');
        }

        const sceneRecord = {
          sceneIndex,
          promptHash,
          prompt,
          path: imagePath,
          status: 'ready',
          generatedAt: new Date().toISOString()
        };
        scenesByIndex.set(sceneIndex, sceneRecord);
        visualAssets.push(imagePath);
        productionData.assets.video = {
          ...(productionData.assets.video || {}),
          visualAssets: [...visualAssets],
          visualSceneAssets: [...scenesByIndex.values()].sort((a, b) => a.sceneIndex - b.sceneIndex),
          duration: productionData.estimatedDuration,
          format: 'mp4',
          resolution: '1920x1080',
          fps: 30,
          generatedWith: 'AI'
        };
        productionData.timeline.visualGeneration = {
          totalScenes: visualPrompts.length,
          completedScenes: visualAssets.length,
          failedScenes: failures.map(item => item.sceneIndex),
          updatedAt: new Date().toISOString()
        };
        // Persist immediately: a later scene failure must not lose earlier images.
        await assertLease();
        await this.db.updateProductionData(productionData, assertLease.lease || null);
      } catch (error) {
        // Lease loss/unverifiable ownership is not a provider failure and must
        // never be swallowed into the retry/fallback path.
        await assertLease();
        failures.push({ sceneIndex, message: String(error?.message || error).slice(0, 300) });
        this.logger.warn(`Visual scene ${sceneIndex + 1}/${visualPrompts.length} failed: ${error.message}`);
        // Stop at the first provider failure to avoid spending on later scenes
        // while the provider is unavailable; successful earlier scenes are safe.
        break;
      }
    }

    const validAssets = [];
    for (let sceneIndex = 0; sceneIndex < visualPrompts.length; sceneIndex++) {
      const scene = scenesByIndex.get(sceneIndex);
      const expectedHash = crypto.createHash('sha256')
        .update(JSON.stringify({ prompt: visualPrompts[sceneIndex], visualStyle })).digest('hex');
      if (scene?.promptHash === expectedHash && await isUsableImage(scene.path)) validAssets.push(scene.path);
    }

    productionData.assets.video = {
      ...(productionData.assets.video || {}),
      visualAssets: validAssets,
      visualSceneAssets: [...scenesByIndex.values()].sort((a, b) => a.sceneIndex - b.sceneIndex),
      duration: productionData.estimatedDuration,
      format: 'mp4',
      resolution: '1920x1080',
      fps: 30,
      generatedWith: 'AI'
    };
    productionData.timeline.visualGeneration = {
      totalScenes: visualPrompts.length,
      completedScenes: validAssets.length,
      failedScenes: visualPrompts.map((_, index) => index).filter(index => !validAssets.some(filePath => filePath === scenesByIndex.get(index)?.path)),
      updatedAt: new Date().toISOString()
    };
    await assertLease();
    await this.db.updateProductionData(productionData, assertLease.lease || null);

    if (validAssets.length !== visualPrompts.length) {
      const failedCount = visualPrompts.length - validAssets.length;
      const details = failures.map(item => `scene ${item.sceneIndex + 1}: ${item.message}`).join(' | ');
      throw new Error(`Visual generation incomplete: ${validAssets.length}/${visualPrompts.length} scenes ready; ${failedCount} scene(s) will be retried. ${details}`);
    }

    await assertLease();
    productionData.timeline.videoGenerated = new Date().toISOString();
    await this.db.updateProductionData(productionData, assertLease.lease || null);
    return validAssets;
  }

  async createVideoElements(productionData) {
    const { script } = productionData;
    const elements = [];
    
    // Title slide
    elements.push({
      type: 'title_slide',
      content: script.title,
      duration: 3,
      style: 'modern',
      animation: 'fade_in'
    });
    
    // Content sections
    if (script.mainContent && script.mainContent.sections) {
      script.mainContent.sections.forEach((section) => {
        // Section title
        elements.push({
          type: 'section_title',
          content: section.title,
          duration: 2,
          style: 'minimal',
          animation: 'slide_in'
        });
        
        // Content visuals
        if (section.type === 'list_items' && section.items) {
          section.items.forEach(item => {
            elements.push({
              type: 'list_item',
              content: {
                number: item.number,
                title: item.title,
                description: item.description
              },
              duration: 15,
              style: 'countdown',
              animation: 'zoom_in'
            });
          });
        } else if (section.type === 'solution_steps' && section.steps) {
          section.steps.forEach(step => {
            elements.push({
              type: 'step',
              content: {
                number: step.number,
                title: step.title,
                description: step.description
              },
              duration: 20,
              style: 'tutorial',
              animation: 'step_by_step'
            });
          });
        } else {
          // Generic content slide
          elements.push({
            type: 'content_slide',
            content: section.title,
            duration: section.duration || 30,
            style: 'informative',
            animation: 'fade_transition'
          });
        }
      });
    }
    
    // Conclusion slide
    elements.push({
      type: 'conclusion',
      content: 'Key Takeaways',
      duration: 5,
      style: 'summary',
      animation: 'reveal'
    });
    
    // Subscribe reminder
    elements.push({
      type: 'subscribe_reminder',
      content: 'Subscribe for More!',
      duration: 3,
      style: 'call_to_action',
      animation: 'bounce'
    });
    
    return elements;
  }

  async generateAudioNarration(productionData, assertLease = async () => {}) {
    await assertLease();
    this.logger.info('Generating AI audio narration...');

    const attemptId = getArtifactAttemptId(productionData);
    const audioPath = path.join(__dirname, '..', 'data', 'audio', `${productionData.id}_${attemptId}_narration.mp3`);
    let generatedPath = null;

    try {
      // Reuse only a fully validated artifact already referenced by this production.
      const ttsText = await fs.readFile(productionData.assets.script.ttsPath, 'utf8');
      const audioDirection = productionData.strategy?.approvedVideoConcept?.audioDirection || {};
      const sourceHash = crypto.createHash('sha256')
        .update(JSON.stringify({ ttsText, audioDirection })).digest('hex');
      const existingAudio = productionData.assets.audio;
      if (existingAudio?.sourceHash === sourceHash &&
          existingAudio.status === 'ready' &&
          !existingAudio.simulated &&
          await this.aiVideoGenerator.isUsableAudioFile(existingAudio.path)) {
        await assertLease();
        this.logger.info('Reusing validated narration; source text and audio direction are unchanged.');
        return existingAudio.path;
      }

      await assertLease();
      generatedPath = await this.aiVideoGenerator.generateTTSAudio(ttsText, audioPath, { direction: audioDirection, assertLease });
      await assertLease();
      const evidence = this.aiVideoGenerator.lastNarrationResult || {};
      const usable = await this.aiVideoGenerator.isUsableAudioFile(generatedPath);
      await assertLease();

      productionData.assets.audio = {
        direction: audioDirection,
        sourceHash,
        directionApplied: Boolean(evidence.directionApplied),
        directionApplication: evidence.directionApplication || null,
        path: generatedPath,
        duration: productionData.estimatedDuration,
        format: 'mp3',
        generatedWith: 'AI',
        quality: usable ? 'high' : null,
        status: usable ? 'ready' : 'unavailable',
        simulated: !usable,
        provider: evidence.provider || null,
        model: evidence.model || null,
        externalTaskId: evidence.externalTaskId || null,
        generatedAt: evidence.generatedAt || new Date().toISOString(),
        cost: evidence.cost || {},
        error: usable ? null : 'No live narration provider returned usable audio',
        intentionalSilence: false
      };

      if (usable) productionData.timeline.audioGenerated = new Date().toISOString();
      if (!usable) await removeAttemptFiles([generatedPath, audioPath, audioPath + '.pcm']);
      return usable ? generatedPath : await this.simulateAudioGeneration(productionData, new Error('No live narration provider returned usable audio'), assertLease);
    } catch (error) {
      // Provider/FFmpeg work can finish after the generation lease expires.
      // Remove only this attempt's files; never touch the previously persisted audio path.
      await removeAttemptFiles([generatedPath, audioPath, audioPath + '.pcm']);
      await assertLease();
      this.logger.error('AI audio generation failed:', error);
      return await this.simulateAudioGeneration(productionData, error, assertLease);
    }
  }

  async generateCaptions(productionData, assertLease = async () => {}) {
    await assertLease();
    this.logger.info('Generating captions...');

    const attemptId = getArtifactAttemptId(productionData);
    const captionsPath = path.join(__dirname, '..', 'data', 'captions', `${productionData.id}_${attemptId}_captions.srt`);
    const sourceHash = crypto.createHash('sha256')
      .update(JSON.stringify(productionData.script)).digest('hex');
    const existingCaptions = productionData.assets.captions;
    if (existingCaptions?.sourceHash === sourceHash && existingCaptions.path) {
      try {
        const stats = await fs.stat(existingCaptions.path);
        if (stats.isFile() && stats.size > 0) {
          const savedCaptions = await fs.readFile(existingCaptions.path, 'utf8');
          validateSrtContent(savedCaptions);
          await assertLease();
          this.logger.info('Reusing validated captions; script content is unchanged.');
          return existingCaptions.path;
        }
      } catch (_error) {
        // Missing, unreadable or invalid captions are regenerated below.
      }
    }

    const captions = await this.createSRTCaptions(productionData);
    validateSrtContent(captions);

    try {
      await assertLease();
      await fs.mkdir(path.dirname(captionsPath), { recursive: true });
      await assertLease();
      await fs.writeFile(captionsPath, captions);
      await assertLease();

      productionData.assets.captions = {
        designDirection: productionData.strategy?.approvedVideoConcept?.subtitleDirection || null,
        path: captionsPath,
        sourceHash,
        format: 'srt',
        language: 'en',
        autoGenerated: true
      };
      productionData.timeline.captionsGenerated = new Date().toISOString();
      return captionsPath;
    } catch (error) {
      await removeAttemptFiles([captionsPath]);
      throw error;
    }
  }

  async createSRTCaptions(productionData) {
    const { script } = productionData;
    let srt = '';
    let captionIndex = 1;
    let currentTime = 0;
    
    // Helper function to format time for SRT
    const formatSRTTime = (seconds) => {
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const secs = Math.floor(seconds % 60);
      const ms = Math.floor((seconds % 1) * 1000);
      
      return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
    };
    
    // Process script sections for captions
    const processText = (text, startTime, duration) => {
      const words = text.split(' ');
      const wordsPerCaption = 8; // Optimal words per caption
      
      for (let i = 0; i < words.length; i += wordsPerCaption) {
        const captionWords = words.slice(i, i + wordsPerCaption);
        const captionDuration = (duration / Math.ceil(words.length / wordsPerCaption));
        const captionStartTime = startTime + (i / words.length) * duration;
        const captionEndTime = captionStartTime + captionDuration;
        
        srt += `${captionIndex}\n`;
        srt += `${formatSRTTime(captionStartTime)} --> ${formatSRTTime(captionEndTime)}\n`;
        srt += `${captionWords.join(' ')}\n\n`;
        
        captionIndex++;
      }
    };
    
    // Hook
    if (script.hook && script.hook.text) {
      processText(script.hook.text, currentTime, 5);
      currentTime += 5;
    }
    
    // Introduction
    if (script.introduction) {
      const introText = `${script.introduction.greeting} ${script.introduction.topicIntro} ${script.introduction.valueProposition}`;
      processText(introText, currentTime, 15);
      currentTime += 15;
    }
    
    // Main content
    if (script.mainContent && script.mainContent.sections) {
      script.mainContent.sections.forEach(section => {
        let sectionText = '';
        
        if (Array.isArray(section.content)) {
          sectionText = section.content.filter(line => 
            typeof line === 'string' && !line.startsWith('[')
          ).join(' ');
        } else if (section.steps) {
          sectionText = section.steps.map(step => 
            `${step.title}. ${step.description}`
          ).join(' ');
        } else if (section.items) {
          sectionText = section.items.map(item => 
            `Number ${item.number}: ${item.title}. ${item.description}`
          ).join(' ');
        } else if (typeof section.content === 'string') {
          sectionText = section.content;
        }
        
        if (sectionText) {
          processText(sectionText, currentTime, section.duration || 60);
          currentTime += section.duration || 60;
        }
      });
    }
    
    // Conclusion
    if (script.conclusion) {
      const conclusionText = script.conclusion.recap.join(' ') + ' ' + script.conclusion.finalThought;
      processText(conclusionText, currentTime, 30);
      currentTime += 30;
    }
    
    return srt;
  }

  async assembleVideo(productionData, assertLease = async () => {}) {
    await assertLease();
    this.logger.info('Assembling final AI-generated video...');

    const attemptId = getArtifactAttemptId(productionData);
    const generatedPaths = [];
    const previousBackgroundMusic = productionData.assets.backgroundMusic;
    try {
      const requestedVideoPath = path.join(__dirname, '..', 'data', 'videos', `${productionData.id}_${attemptId}_final.mp4`);
      generatedPaths.push(...getVideoAttemptSidecarPaths(requestedVideoPath));
      const narrationReady = await this.aiVideoGenerator.isUsableAudioFile(productionData.assets.audio?.path);
      if (!narrationReady && productionData.assets.audio?.intentionalSilence !== true) {
        this.logger.warn('Final assembly is blocked until narration succeeds or the operator explicitly confirms an intentional silent video.');
        return await this.simulateVideoAssembly(productionData, 'Narration is missing', assertLease);
      }

      // Use AI Video Generator to create the final video
      await assertLease();
      const producedPath = await this.aiVideoGenerator.generateVideo(
        productionData.script,
        productionData.assets.video.visualAssets || [],
        productionData.assets.audio.path,
        requestedVideoPath,
        {
          jobId: productionData.jobId,
          productionId: productionData.id,
          estimatedDuration: productionData.estimatedDuration,
          approvedVideoConcept: productionData.strategy?.approvedVideoConcept || null,
          attemptId,
          assertLease
        }
      );
      if (producedPath && typeof producedPath === 'string') generatedPaths.push(...getVideoAttemptSidecarPaths(producedPath));
      const providerScenes = this.aiVideoGenerator.lastVideoResult?.scenes || [];
      for (const scene of providerScenes) {
        if (scene.path && scene.reused !== true) {
          generatedPaths.push(
            scene.path,
            scene.path + '.rendering.mp4',
            scene.path + '.render.json',
            scene.path + '.render.json.tmp'
          );
        }
      }
      await assertLease();

      // The generator falls back to a placeholder .info file when it cannot render.
      if (!producedPath || path.extname(producedPath).toLowerCase() !== '.mp4') {
        await removeAttemptFiles(generatedPaths, [
          productionData.assets.audio?.path,
          productionData.assets.captions?.path,
          productionData.assets.finalVideo?.path,
          productionData.assets.finalVideo?.cleanPath,
          previousBackgroundMusic?.path
        ]);
        generatedPaths.length = 0;
        return await this.simulateVideoAssembly(productionData, null, assertLease);
      }

      let finalVideoPath = producedPath;
      const approvedConcept = productionData.strategy?.approvedVideoConcept || {};
      const audioDirection = approvedConcept.audioDirection || {};
      const musicAsset = audioDirection.musicAsset || approvedConcept.backgroundMusic || null;
      if (musicAsset && musicAsset.enabled !== false) {
        const mixedPath = path.join(__dirname, '..', 'data', 'videos', `${productionData.id}_${attemptId}_music_mixed.mp4`);
        const previousMixWasPersisted = previousBackgroundMusic?.path === mixedPath;
        if (!previousMixWasPersisted) {
          generatedPaths.push(
            mixedPath,
            mixedPath + '.mixing.mp4',
            mixedPath + '.mix.json',
            mixedPath + '.mix.json.tmp'
          );
        }
        await assertLease();
        const mixResult = await this.audioMixer(producedPath, mixedPath, musicAsset, { ...this.audioMixerDependencies, assertLease });
        if (mixResult?.path && mixResult.path !== previousBackgroundMusic?.path) generatedPaths.push(mixResult.path);
        await assertLease();
        finalVideoPath = mixResult.path;
        productionData.assets.backgroundMusic = {
          ...mixResult,
          direction: typeof audioDirection.music === 'string' ? audioDirection.music : null
        };
      } else {
        productionData.assets.backgroundMusic = {
          status: musicAsset?.enabled === false ? 'disabled' : 'not_configured',
          direction: typeof audioDirection.music === 'string' ? audioDirection.music : null
        };
      }

      const captionsPath = productionData.assets.captions?.path;
      if (!captionsPath) throw new Error('A generated SRT captions file is required before production can be marked ready');
      const captionsContent = await fs.readFile(captionsPath, 'utf8');
      validateSrtContent(captionsContent);
      const subtitleDirection = productionData.strategy?.approvedVideoConcept?.subtitleDirection || {};
      if (captionsPath) {
        const captionedPath = path.join(__dirname, '..', 'data', 'videos', `${productionData.id}_${attemptId}_captioned.mp4`);
        const captionTempPath = `${captionedPath}.rendering.mp4`;
        const captionManifestPath = `${captionedPath}.render.json`;
        const manifestTempPath = `${captionManifestPath}.tmp`;
        await assertLease();
        const [sourceHash, captionsHash] = await Promise.all([
          new Promise((resolve, reject) => {
            const hash = crypto.createHash('sha256');
            const stream = require('node:fs').createReadStream(finalVideoPath);
            stream.on('error', reject);
            stream.on('data', chunk => hash.update(chunk));
            stream.on('end', () => resolve(hash.digest('hex')));
          }),
          new Promise((resolve, reject) => {
            const hash = crypto.createHash('sha256');
            const stream = require('node:fs').createReadStream(captionsPath);
            stream.on('error', reject);
            stream.on('data', chunk => hash.update(chunk));
            stream.on('end', () => resolve(hash.digest('hex')));
          })
        ]);
        await assertLease();
        const captionFingerprint = crypto.createHash('sha256').update(JSON.stringify({
          sourceHash, captionsHash, subtitleDirection, rendererVersion: 1,
          codec: 'libx264', preset: 'veryfast', crf: 20
        })).digest('hex');
        let captionCached = false;
        try {
          const [manifest, cachedStats] = await Promise.all([
            fs.readFile(captionManifestPath, 'utf8').then(JSON.parse),
            fs.stat(captionedPath)
          ]);
          if (manifest.fingerprint === captionFingerprint && cachedStats.isFile() && cachedStats.size > 0) {
            const cachedInfo = await getMediaInfo(captionedPath);
            if (cachedInfo.width && cachedInfo.height && Number.isFinite(cachedInfo.duration) && cachedInfo.duration > 0) {
              await assertLease();
              await runFFmpeg(['-v', 'error', '-i', captionedPath, '-f', 'null', '-'], { assertLease });
              await assertLease();
              captionCached = true;
              this.logger.info('Reusing validated caption-rendered video.');
            }
          }
        } catch (cacheError) {
          if (isLeaseFailure(cacheError)) throw cacheError;
          captionCached = false;
        }
        if (captionCached && captionedPath !== productionData.assets.finalVideo?.path) {
          generatedPaths.push(
            captionedPath,
            captionedPath + '.rendering.mp4',
            captionManifestPath,
            captionManifestPath + '.tmp'
          );
        }
        if (!captionCached) {
          generatedPaths.push(captionedPath, captionTempPath, captionManifestPath, manifestTempPath);
          await assertLease();
          await fs.rm(captionTempPath, { force: true });
          await runFFmpeg([
            '-y', '-i', finalVideoPath,
            '-vf', buildSubtitleFilter(captionsPath, subtitleDirection),
            '-map', '0:v:0', '-map', '0:a:0?',
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
            '-c:a', 'copy', '-movflags', '+faststart', captionTempPath
          ], { assertLease });
          await assertLease();
          const captionedStats = await fs.stat(captionTempPath);
          if (!captionedStats.isFile() || captionedStats.size <= 0) {
            throw new Error('Subtitle renderer returned an empty captioned video');
          }
          const captionedInfo = await getMediaInfo(captionTempPath);
          if (!captionedInfo.width || !captionedInfo.height || !Number.isFinite(captionedInfo.duration) || captionedInfo.duration <= 0) {
            throw new Error('Subtitle renderer returned a video without valid media metadata');
          }
          await runFFmpeg(['-v', 'error', '-i', captionTempPath, '-f', 'null', '-'], { assertLease });
          await assertLease();
          await fs.rm(captionedPath, { force: true });
          await fs.rename(captionTempPath, captionedPath);
          await assertLease();
          await fs.writeFile(manifestTempPath, JSON.stringify({
            version: 1, fingerprint: captionFingerprint, sourceHash, captionsHash,
            renderedAt: new Date().toISOString()
          }, null, 2));
          await assertLease();
          await fs.rm(captionManifestPath, { force: true });
          await fs.rename(manifestTempPath, captionManifestPath);
          await assertLease();
        }
        finalVideoPath = captionedPath;
        productionData.assets.captions.styleApplication = describeSubtitleApplication(subtitleDirection);
      }

      // Validate the actual encoded output, not only the existence of a non-empty file.
      await assertLease();
      const stats = await fs.stat(finalVideoPath);
      if (!stats.isFile() || stats.size <= 0) {
        throw new Error('Final video assembly returned an empty output file');
      }
      const finalMediaInfo = await getMediaInfo(finalVideoPath);
      await assertLease();
      if (!finalMediaInfo.width || !finalMediaInfo.height || !Number.isFinite(finalMediaInfo.duration) || finalMediaInfo.duration <= 0) {
        throw new Error('Final video is missing a valid video stream or duration');
      }
      if (!finalMediaInfo.hasAudio && productionData.assets.audio?.intentionalSilence !== true) {
        throw new Error('Final video is missing the required narration/audio stream');
      }

      // Preserve and independently validate the clean, subtitle-free source for Shorts.
      const cleanStats = await fs.stat(producedPath);
      if (!cleanStats.isFile() || cleanStats.size <= 0 || path.resolve(producedPath) === path.resolve(finalVideoPath)) {
        throw new Error('Clean source video was not preserved separately from the final captioned video');
      }
      const cleanMediaInfo = await getMediaInfo(producedPath);
      await assertLease();
      if (!cleanMediaInfo.width || !cleanMediaInfo.height || !Number.isFinite(cleanMediaInfo.duration) || cleanMediaInfo.duration <= 0) {
        throw new Error('Clean source video is missing a valid video stream or duration');
      }

      await assertLease();
      productionData.assets.finalVideo = {
        path: finalVideoPath,
        cleanPath: producedPath,
        cleanFileSize: cleanStats.size,
        fileSize: stats.size,
        duration: productionData.estimatedDuration,
        generatedWith: 'AI',
        resolution: '1920x1080',
        format: 'mp4',
        provider: this.aiVideoGenerator.lastVideoResult || { actualProvider: 'slideshow', model: 'local-ffmpeg' }
      };
      productionData.containsSyntheticMedia = Boolean(
        this.aiVideoGenerator.lastVideoResult?.actualProvider &&
        !['slideshow', 'simulation'].includes(this.aiVideoGenerator.lastVideoResult.actualProvider)
      );
      
      this.logger.info('AI video assembly complete');
      return finalVideoPath;
    } catch (error) {
      await removeAttemptFiles(generatedPaths, [
        productionData.assets.audio?.path,
        productionData.assets.captions?.path,
        productionData.assets.finalVideo?.path,
        productionData.assets.finalVideo?.cleanPath,
        previousBackgroundMusic?.path
      ]);
      productionData.assets.backgroundMusic = previousBackgroundMusic;
      // Lease loss must propagate after attempt-local files are removed; it is
      // not a normal rendering failure and must never create a fallback artifact.
      await assertLease();
      this.logger.error('AI video assembly failed:', error);
      return await this.simulateVideoAssembly(productionData, error.message || String(error), assertLease);
    }
  }

  async getPipelineStatus() {
    return this.pipeline.map(item => ({
      id: item.id,
      title: item.script?.title || 'Untitled',
      status: item.status,
      priority: item.priority,
      scheduledPublishTime: item.scheduledPublishTime,
      progress: this.calculateProgress(item)
    }));
  }

  calculateProgress(productionData) {
    const milestones = [
      'scriptReady',
      'thumbnailReady',
      'audioGenerated',
      'videoGenerated',
      'captionsGenerated',
      'readyForUpload'
    ];
    
    const completed = milestones.filter(milestone => 
      productionData.timeline[milestone] !== null
    ).length;
    
    return Math.round((completed / milestones.length) * 100);
  }

  async getNextReadyContent() {
    const ready = this.pipeline
      .filter(item => item.status === 'ready')
      .sort((a, b) => b.priority - a.priority);
    
    return ready[0] || null;
  }

  // Helper method to create visual prompts from script content
  createVisualPromptsFromScript(script, approvedConcept = null) {
    const prompts = [];
    const direction = approvedConcept?.visualDirection || {};
    const scenePlan = Array.isArray(approvedConcept?.scenePlan) ? approvedConcept.scenePlan : [];
    const conceptPrefix = approvedConcept
      ? 'Follow approved video concept "' + (approvedConcept.name || '') + '". Visual style: ' +
        JSON.stringify(direction) + '. Keep palette, composition and background treatment consistent. '
      : '';
    for (const scene of scenePlan.slice(0, 5)) {
      if (scene?.visual) prompts.push(conceptPrefix + scene.visual);
    }
    
    // Title prompt
    prompts.push(conceptPrefix + `${script.title}, clear visual storytelling`);
    
    // Content-based prompts
    if (script.mainContent && script.mainContent.sections) {
      script.mainContent.sections.forEach(section => {
        if (section.title) {
          prompts.push(`${section.title}, relevant explanatory visual`);
        }
      });
    }
    
    // Ensure we have at least 3 prompts
    while (prompts.length < 3) {
      prompts.push(`${script.title || 'Video topic'}, supporting explanatory visual`);
    }
    
    return prompts.slice(0, 5); // Limit to 5 for cost control
  }

  // Fallback simulation methods
  async simulateAudioGeneration(productionData, failure = null, assertLease = async () => {}) {
    const attemptId = getArtifactAttemptId(productionData);
    const audioPath = path.join(__dirname, '..', 'data', 'audio', `${productionData.id}_${attemptId}_narration.mp3`);
    const placeholderPath = audioPath + '.info';

    try {
      await assertLease();
      await fs.writeFile(placeholderPath, JSON.stringify({
        message: 'AI TTS audio would be generated here',
        timestamp: new Date().toISOString()
      }, null, 2));
      await assertLease();
    } catch (error) {
      await removeAttemptFiles([placeholderPath]);
      throw error;
    }

    productionData.assets.audio = {
      path: placeholderPath,
      duration: productionData.estimatedDuration,
      format: 'mp3',
      status: 'unavailable',
      simulated: true,
      provider: this.aiVideoGenerator.lastNarrationResult?.provider || 'simulation',
      model: this.aiVideoGenerator.lastNarrationResult?.model || null,
      externalTaskId: this.aiVideoGenerator.lastNarrationResult?.externalTaskId || null,
      generatedAt: this.aiVideoGenerator.lastNarrationResult?.generatedAt || new Date().toISOString(),
      cost: this.aiVideoGenerator.lastNarrationResult?.cost || { billed: false },
      error: failure?.message || this.aiVideoGenerator.lastNarrationResult?.error || 'No live narration provider is configured',
      intentionalSilence: false
    };

    return placeholderPath;
  }

  async simulateVideoAssembly(productionData, reason = null, assertLease = async () => {}) {
    const attemptId = getArtifactAttemptId(productionData);
    const finalVideoPath = path.join(__dirname, '..', 'data', 'videos', `${productionData.id}_${attemptId}_final.mp4`);
    const placeholderPath = finalVideoPath + '.assembly.json';

    const assemblyInstructions = {
      message: 'AI video would be assembled here',
      blockedReason: reason,
      assets: productionData.assets,
      timestamp: new Date().toISOString()
    };

    try {
      await assertLease();
      await fs.writeFile(placeholderPath, JSON.stringify(assemblyInstructions, null, 2));
      await assertLease();
    } catch (error) {
      await removeAttemptFiles([placeholderPath]);
      throw error;
    }

    productionData.assets.finalVideo = {
      path: placeholderPath,
      fileSize: 0,
      duration: productionData.estimatedDuration,
      simulated: true,
      blockedReason: reason
    };

    return placeholderPath;
  }
}

module.exports = { ProductionManagementAgent, getVideoAttemptSidecarPaths };
