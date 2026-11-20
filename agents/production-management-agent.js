const path = require('path');
const crypto = require('crypto');
const fs = require('fs').promises;
const { Logger } = require('../utils/logger');
const { AIVideoGenerator } = require('../utils/ai-video-generator');
const { SceneRepairService } = require('../utils/scene-repair-service');
const { runFFmpeg, getMediaInfo, getAudioInfo } = require('../utils/ffmpeg');
const { mixBackgroundMusic } = require('../utils/audio-mixer');
const { buildSubtitleFilter, describeSubtitleApplication, validateSrtContent } = require('../utils/subtitle-renderer');
const { requireApprovedVideoConcept } = require('../utils/approved-video-concept-gate');
const { createProductionWorkflow, runProductionStage, prepareProductionWorkflowForResume } = require('../utils/production-stage-workflow');
const { assertScriptQualityGate } = require('../utils/script-quality-gate');

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
        if (existing) {
          if (existing.script?.title !== script?.title ||
              existing.timeline?.jobId !== jobId) {
            throw new Error('A persisted production exists for this job but its script/job identity does not match; refusing duplicate production');
          }
          this.logger.info(`Resuming persisted production ${existing.id} for generation job ${jobId}`);
          return this.resumeProduction(existing.id);
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
          script: await this.processScript(script),
          thumbnail: await this.processThumbnail(thumbnail, script),
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
          jobId
        },
        scheduledPublishTime: this.calculatePublishTime(strategy),
        priority: this.calculatePriority(strategy),
        estimatedDuration: script.duration,
        createdAt: new Date().toISOString()
      };
      productionData.jobId = jobId;
      productionData.timeline.productionWorkflow = createProductionWorkflow(approvedConcept.id);
      const persistWorkflow = async () => this.db.updateProductionData(productionData);
      
      // Add to pipeline
      this.pipeline.push(productionData);
      
      // Save to database
      await this.db.saveProductionData(productionData);
      await this.db.saveProductionSnapshot(productionData);
      
      // Persist stage transitions so interrupted or failed work is visible in the production record.
      await runProductionStage(
        productionData.timeline.productionWorkflow,
        'visuals',
        async () => {
          const assets = await this.generateVideoContent(productionData);
          const realAssets = Array.isArray(assets)
            ? assets.filter(asset => typeof asset === 'string' && path.extname(asset).toLowerCase() !== '.info')
            : [];
          if (!realAssets.length) throw new Error('Visual stage produced placeholder assets only; configure a working image provider before retrying');
          return { assetCount: realAssets.length };
        },
        persistWorkflow
      );
      await runProductionStage(
        productionData.timeline.productionWorkflow,
        'narration',
        async () => {
          const audioPath = await this.generateAudioNarration(productionData);
          if (productionData.assets.audio?.simulated || productionData.assets.audio?.status !== 'ready') {
            throw new Error(productionData.assets.audio?.error || 'Narration stage produced simulated audio only');
          }
          return { audioPath, provider: productionData.assets.audio.provider || null };
        },
        persistWorkflow
      );
      await runProductionStage(
        productionData.timeline.productionWorkflow,
        'editing',
        async () => {
          await this.generateCaptions(productionData);
          await this.assembleVideo(productionData);
          const finalVideo = productionData.assets.finalVideo;
          if (!finalVideo || finalVideo.simulated || path.extname(finalVideo.path || '').toLowerCase() !== '.mp4') {
            throw new Error(finalVideo?.blockedReason || 'Editing stage did not produce a real MP4 video file');
          }
          await this.sceneRepair.initializeProduction(productionData, this.aiVideoGenerator.lastVideoResult || {});
          return {
            captionsGenerated: Boolean(productionData.assets.captions?.path),
            finalVideoGenerated: Boolean(productionData.assets.finalVideo?.path),
            simulated: Boolean(productionData.assets.finalVideo?.simulated)
          };
        },
        persistWorkflow
      );

      // Mark as ready — or simulated, when no real video could be produced
      const finalVideo = productionData.assets.finalVideo;
      if (!finalVideo || finalVideo.simulated || path.extname(finalVideo.path || '').toLowerCase() !== '.mp4') {
        throw new Error('Production cannot be marked ready without a real MP4 final video');
      }
      productionData.status = 'ready';
      productionData.timeline.readyForUpload = new Date().toISOString();

      await this.db.updateProductionData(productionData);

      this.logger.info(`Content processing complete: ${productionId} (status: ${productionData.status})`);
      return productionData;
    } catch (error) {
      this.logger.error('Failed to process content:', error);
      if (productionData?.id) {
        productionData.status = 'failed';
        productionData.timeline.lastProductionError = String(error?.message || error).slice(0, 500);
        await this.db.updateProductionData(productionData).catch(persistError => {
          this.logger.error('Failed to persist production failure state:', persistError);
        });
      }
      throw error;
    }
  }

  async resumeProduction(productionId) {
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
      timeline: stored.timeline || {},
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
        await this.db.updateProductionData(productionData);
        throw new Error(productionData.timeline.lastProductionError);
      }
      productionData.status = 'ready';
      await this.db.updateProductionData(productionData);
      return productionData;
    }
    const persistWorkflow = async () => this.db.updateProductionData(productionData);
    try {
      if (workflow.stages.visuals.status !== 'completed') {
        await runProductionStage(workflow, 'visuals', async () => {
          const assets = await this.generateVideoContent(productionData);
          const realAssets = Array.isArray(assets)
            ? assets.filter(asset => typeof asset === 'string' && path.extname(asset).toLowerCase() !== '.info')
            : [];
          if (!realAssets.length) throw new Error('Visual stage produced placeholder assets only; configure a working image provider before retrying');
          return { assetCount: realAssets.length };
        }, persistWorkflow);
      }
      if (workflow.stages.narration.status !== 'completed') {
        await runProductionStage(workflow, 'narration', async () => {
          const audioPath = await this.generateAudioNarration(productionData);
          if (productionData.assets.audio?.simulated || productionData.assets.audio?.status !== 'ready') {
            throw new Error(productionData.assets.audio?.error || 'Narration stage produced simulated audio only');
          }
          return { audioPath, provider: productionData.assets.audio.provider || null };
        }, persistWorkflow);
      }
      if (workflow.stages.editing.status !== 'completed') {
        await runProductionStage(workflow, 'editing', async () => {
          await this.generateCaptions(productionData);
          await this.assembleVideo(productionData);
          const finalVideo = productionData.assets.finalVideo;
          if (!finalVideo || finalVideo.simulated || path.extname(finalVideo.path || '').toLowerCase() !== '.mp4') {
            throw new Error(finalVideo?.blockedReason || 'Editing stage did not produce a real MP4 video file');
          }
          await this.sceneRepair.initializeProduction(productionData, this.aiVideoGenerator.lastVideoResult || {});
          return {
            captionsGenerated: Boolean(productionData.assets.captions?.path),
            finalVideoGenerated: Boolean(productionData.assets.finalVideo?.path),
            simulated: Boolean(productionData.assets.finalVideo?.simulated)
          };
        }, persistWorkflow);
      }
      const finalVideo = productionData.assets.finalVideo;
      if (!finalVideo || finalVideo.simulated || path.extname(finalVideo.path || '').toLowerCase() !== '.mp4') {
        throw new Error('Production cannot be marked ready without a real MP4 final video');
      }
      productionData.status = 'ready';
      productionData.timeline.readyForUpload = new Date().toISOString();
      await this.db.updateProductionData(productionData);
      const index = this.pipeline.findIndex(item => item.id === productionId);
      if (index >= 0) this.pipeline[index] = productionData;
      else this.pipeline.push(productionData);
      return productionData;
    } catch (error) {
      productionData.status = 'failed';
      productionData.timeline.lastProductionError = String(error?.message || error).slice(0, 500);
      await this.db.updateProductionData(productionData);
      throw error;
    }
  }

  generateProductionId() {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 15);
    const extra = Math.random().toString(36).substring(2, 15);
    return `prod_${timestamp}_${random}_${extra}`;
  }

  async processScript(script) {
    const scriptPath = path.join(__dirname, '..', 'data', 'scripts', `${Date.now()}_script.json`);
    
    // Create formatted script for TTS
    const ttsScript = this.formatScriptForTTS(script);
    
    // Save script files
    await fs.writeFile(scriptPath, JSON.stringify(script, null, 2));
    await fs.writeFile(
      scriptPath.replace('.json', '_tts.txt'), 
      ttsScript
    );
    
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

  async processThumbnail(thumbnail, script) {
    try {
      // Try to generate AI thumbnail first
      const thumbnailScript = thumbnail.script || script || { title: thumbnail.title || 'Untitled Video' };
      const aiThumbnail = await this.aiVideoGenerator.generateThumbnail(thumbnailScript, 'ethereal');

      // generateThumbnail returns a simulated placeholder instead of throwing when
      // no image provider works; the designer's real image beats that placeholder.
      if (!aiThumbnail.simulated) {
        return {
          path: aiThumbnail.path,
          originalPath: thumbnail.path,
          dimensions: aiThumbnail.dimensions,
          fileSize: aiThumbnail.fileSize,
          generatedWith: 'AI'
        };
      }
    } catch (error) {
      this.logger.error('AI thumbnail generation failed:', error);
    }

    // Fallback to original processing
    const productionThumbnailPath = path.join(
      __dirname, '..', 'data', 'assets',
      `thumbnail_${Date.now()}.jpg`
    );

    if (thumbnail.path && await fs.access(thumbnail.path).then(() => true).catch(() => false)) {
      const originalBuffer = await fs.readFile(thumbnail.path);
      await fs.mkdir(path.dirname(productionThumbnailPath), { recursive: true });
      await fs.writeFile(productionThumbnailPath, originalBuffer);
      return {
        path: productionThumbnailPath,
        originalPath: thumbnail.path,
        dimensions: thumbnail.dimensions || { width: 1792, height: 1024 },
        fileSize: thumbnail.fileSize || 0
      };
    }

    // Create placeholder
    await fs.mkdir(path.dirname(productionThumbnailPath), { recursive: true });
    await fs.writeFile(productionThumbnailPath + '.placeholder', 'Thumbnail placeholder');
    return {
      path: productionThumbnailPath + '.placeholder',
      originalPath: thumbnail.path,
      dimensions: thumbnail.dimensions || { width: 1792, height: 1024 },
      fileSize: 0,
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

  async generateVideoContent(productionData) {
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
        return stats.isFile() && stats.size > 0;
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
        const generated = await this.aiVideoGenerator.generateVisualAssets(prompt, visualStyle, 1);
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
        await this.db.updateProductionData(productionData);
      } catch (error) {
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
    await this.db.updateProductionData(productionData);

    if (validAssets.length !== visualPrompts.length) {
      const failedCount = visualPrompts.length - validAssets.length;
      const details = failures.map(item => `scene ${item.sceneIndex + 1}: ${item.message}`).join(' | ');
      throw new Error(`Visual generation incomplete: ${validAssets.length}/${visualPrompts.length} scenes ready; ${failedCount} scene(s) will be retried. ${details}`);
    }

    productionData.timeline.videoGenerated = new Date().toISOString();
    await this.db.updateProductionData(productionData);
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

  async generateAudioNarration(productionData) {
    this.logger.info('Generating AI audio narration...');
    
    try {
      const audioPath = path.join(__dirname, '..', 'data', 'audio', `${productionData.id}_narration.mp3`);
      
      // Read the TTS script
      const ttsText = await fs.readFile(productionData.assets.script.ttsPath, 'utf8');
      
      // Generate audio using AI TTS and retain the provider evidence returned by the generator.
      const audioDirection = productionData.strategy?.approvedVideoConcept?.audioDirection || {};
      const generatedPath = await this.aiVideoGenerator.generateTTSAudio(ttsText, audioPath, { direction: audioDirection });
      const evidence = this.aiVideoGenerator.lastNarrationResult || {};
      const usable = await this.aiVideoGenerator.isUsableAudioFile(generatedPath);

      productionData.assets.audio = {
        direction: audioDirection,
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
      return generatedPath;
    } catch (error) {
      this.logger.error('AI audio generation failed:', error);
      return await this.simulateAudioGeneration(productionData, error);
    }
  }

  async generateCaptions(productionData) {
    this.logger.info('Generating captions...');
    
    const captionsPath = path.join(__dirname, '..', 'data', 'captions', `${productionData.id}_captions.srt`);
    
    // Generate SRT captions based on script timing
    const captions = await this.createSRTCaptions(productionData);
    validateSrtContent(captions);
    
    await fs.mkdir(path.dirname(captionsPath), { recursive: true });
    await fs.writeFile(captionsPath, captions);
    
    productionData.assets.captions = {
      designDirection: productionData.strategy?.approvedVideoConcept?.subtitleDirection || null,
      path: captionsPath,
      format: 'srt',
      language: 'en',
      autoGenerated: true
    };
    
    productionData.timeline.captionsGenerated = new Date().toISOString();
    
    return captionsPath;
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

  async assembleVideo(productionData) {
    this.logger.info('Assembling final AI-generated video...');
    
    try {
      const requestedVideoPath = path.join(__dirname, '..', 'data', 'videos', `${productionData.id}_final.mp4`);
      const narrationReady = await this.aiVideoGenerator.isUsableAudioFile(productionData.assets.audio?.path);
      if (!narrationReady && productionData.assets.audio?.intentionalSilence !== true) {
        this.logger.warn('Final assembly is blocked until narration succeeds or the operator explicitly confirms an intentional silent video.');
        return await this.simulateVideoAssembly(productionData, 'Narration is missing');
      }

      // Use AI Video Generator to create the final video
      const producedPath = await this.aiVideoGenerator.generateVideo(
        productionData.script,
        productionData.assets.video.visualAssets || [],
        productionData.assets.audio.path,
        requestedVideoPath,
        {
          jobId: productionData.jobId,
          productionId: productionData.id,
          estimatedDuration: productionData.estimatedDuration,
          approvedVideoConcept: productionData.strategy?.approvedVideoConcept || null
        }
      );

      // The generator falls back to a placeholder .info file when it cannot render
      if (!producedPath || path.extname(producedPath).toLowerCase() !== '.mp4') {
        return await this.simulateVideoAssembly(productionData);
      }

      let finalVideoPath = producedPath;
      const approvedConcept = productionData.strategy?.approvedVideoConcept || {};
      const audioDirection = approvedConcept.audioDirection || {};
      const musicAsset = audioDirection.musicAsset || approvedConcept.backgroundMusic || null;
      if (musicAsset && musicAsset.enabled !== false) {
        const mixedPath = path.join(__dirname, '..', 'data', 'videos', `${productionData.id}_music_mixed.mp4`);
        const mixResult = await this.audioMixer(producedPath, mixedPath, musicAsset, this.audioMixerDependencies);
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
        const captionedPath = path.join(__dirname, '..', 'data', 'videos', `${productionData.id}_captioned.mp4`);
        await runFFmpeg([
          '-y', '-i', finalVideoPath,
          '-vf', buildSubtitleFilter(captionsPath, subtitleDirection),
          '-map', '0:v:0', '-map', '0:a:0?',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
          '-c:a', 'copy', '-movflags', '+faststart', captionedPath
        ]);
        const captionedStats = await fs.stat(captionedPath);
        if (!captionedStats.isFile() || captionedStats.size <= 0) {
          throw new Error('Subtitle renderer returned an empty captioned video');
        }
        finalVideoPath = captionedPath;
        productionData.assets.captions.styleApplication = describeSubtitleApplication(subtitleDirection);
      }

      // Validate the actual encoded output, not only the existence of a non-empty file.
      const stats = await fs.stat(finalVideoPath);
      if (!stats.isFile() || stats.size <= 0) {
        throw new Error('Final video assembly returned an empty output file');
      }
      const finalMediaInfo = await getMediaInfo(finalVideoPath);
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
      if (!cleanMediaInfo.width || !cleanMediaInfo.height || !Number.isFinite(cleanMediaInfo.duration) || cleanMediaInfo.duration <= 0) {
        throw new Error('Clean source video is missing a valid video stream or duration');
      }

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
      this.logger.error('AI video assembly failed:', error);
      // Fallback to simulation
      return await this.simulateVideoAssembly(productionData);
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
  async simulateAudioGeneration(productionData, failure = null) {
    const audioPath = path.join(__dirname, '..', 'data', 'audio', `${productionData.id}_narration.mp3`);
    
    await fs.writeFile(audioPath + '.info', JSON.stringify({
      message: 'AI TTS audio would be generated here',
      timestamp: new Date().toISOString()
    }, null, 2));
    
    productionData.assets.audio = {
      path: audioPath + '.info',
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
    
    return audioPath + '.info';
  }

  async simulateVideoAssembly(productionData, reason = null) {
    const finalVideoPath = path.join(__dirname, '..', 'data', 'videos', `${productionData.id}_final.mp4`);
    
    const assemblyInstructions = {
      message: 'AI video would be assembled here',
      blockedReason: reason,
      assets: productionData.assets,
      timestamp: new Date().toISOString()
    };
    
    await fs.writeFile(
      finalVideoPath + '.assembly.json',
      JSON.stringify(assemblyInstructions, null, 2)
    );
    
    productionData.assets.finalVideo = {
      path: finalVideoPath + '.assembly.json',
      fileSize: 0,
      duration: productionData.estimatedDuration,
      simulated: true,
      blockedReason: reason
    };
    
    return finalVideoPath + '.assembly.json';
  }
}

module.exports = { ProductionManagementAgent };
