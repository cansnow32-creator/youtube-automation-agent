const crypto = require('crypto');
const fs = require('fs').promises;
const fsStreams = require('fs');
const path = require('path');
const sharp = require('sharp');
const { getMediaDuration, runFFmpeg } = require('./ffmpeg');
const { ProvenanceService } = require('./provenance-service');

const VIDEO_EXTENSIONS = new Set(['.mp4']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

function isLeaseFailure(error) {
  const code = String(error?.code || '').toUpperCase();
  return code.includes('LEASE') || code.includes('LOCK_LOST') || code.includes('LOCK_UNVERIFIED');
}

async function replaceFileWithRollback(
  tempPath,
  destinationPath,
  token = crypto.randomUUID(),
  assertLease = async () => {}
) {
  const backupPath = destinationPath + '.' + token + '.backup';
  let backedUp = false;
  await assertLease();
  try {
    await fs.rename(destinationPath, backupPath);
    backedUp = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  try {
    await assertLease();
    await fs.rename(tempPath, destinationPath);
    await assertLease();
  } catch (error) {
    if (isLeaseFailure(error)) throw error;
    if (backedUp) {
      try {
        await assertLease();
        await fs.rename(backupPath, destinationPath);
      } catch (restoreError) {
        if (isLeaseFailure(restoreError)) throw restoreError;
        error.restoreError = restoreError;
        error.message += '; previous output restore also failed: ' + restoreError.message;
      }
    }
    throw error;
  }

  if (backedUp) {
    await assertLease();
    await fs.unlink(backupPath).catch(() => {});
  }
}

function textFromSection(section = {}) {
  if (typeof section.content === 'string') return /\[[^\]]*\]/.test(section.content) ? '' : section.content;
  if (Array.isArray(section.content)) return section.content.filter(item => typeof item === 'string' && !/\[[^\]]*\]/.test(item)).join(' ');
  if (Array.isArray(section.items)) return section.items.map(item => `${item.title || ''}. ${item.description || ''}`).join(' ');
  if (Array.isArray(section.steps)) return section.steps.map(item => `${item.title || ''}. ${item.description || ''}`).join(' ');
  return '';
}

function scriptScenes(script = {}) {
  const scenes = [];
  if (script.hook?.text || script.title) {
    scenes.push({
      label: 'Hook',
      scriptText: script.hook?.text || script.title,
      prompt: `${script.hook?.text || script.title}. Cinematic opening shot, clear subject, intentional camera movement, no captions or on-screen text.`
    });
  }
  if (script.introduction) {
    const scriptText = [
      script.introduction.greeting,
      script.introduction.topicIntro,
      script.introduction.valueProposition,
      script.introduction.credibility
    ].filter(Boolean).join(' ');
    if (scriptText) scenes.push({
      label: 'Introduction', scriptText,
      prompt: `${scriptText}. Establishing visual, clear subject, coherent lighting, no captions or on-screen text.`
    });
  }
  for (const [index, section] of (script.mainContent?.sections || []).entries()) {
    const scriptText = textFromSection(section);
    scenes.push({
      label: section.title || `Scene ${index + 1}`,
      scriptText,
      prompt: `${section.title || ''}. ${scriptText}`.trim() + '. Cinematic explanatory B-roll, natural motion, coherent lighting, no captions or on-screen text.'
    });
  }
  if (script.conclusion) {
    const scriptText = [...(script.conclusion.recap || []), script.conclusion.finalThought].filter(Boolean).join(' ');
    if (scriptText) scenes.push({
      label: 'Conclusion', scriptText,
      prompt: `${scriptText}. Memorable cinematic closing shot, no captions or on-screen text.`
    });
  }
  if (script.callToAction) {
    const cta = script.callToAction;
    const scriptText = [cta.subscribe, cta.like, cta.comment, cta.nextVideo]
      .filter(value => typeof value === 'string').join(' ');
    if (scriptText) scenes.push({
      label: 'Call to action', scriptText,
      prompt: `${scriptText}. Clean closing visual with open composition, no captions or on-screen text.`
    });
  }
  return scenes.length ? scenes : [{ label: script.title || 'Video', scriptText: script.fullScript || '', prompt: script.title || 'Video scene' }];
}

function durationSeconds(value, fallback = 60) {
  if (Number.isFinite(Number(value))) return Math.max(1, Number(value));
  const parts = String(value || '').split(':').map(Number);
  if (parts.length === 2 && parts.every(Number.isFinite)) return Math.max(1, parts[0] * 60 + parts[1]);
  if (parts.length === 3 && parts.every(Number.isFinite)) return Math.max(1, parts[0] * 3600 + parts[1] * 60 + parts[2]);
  return fallback;
}

function buildInitialSceneManifest(production = {}, providerResult = {}) {
  const blueprints = scriptScenes(production.script || {});
  const totalDuration = durationSeconds(production.estimatedDuration || production.assets?.finalVideo?.duration, Math.max(30, blueprints.length * 8));
  const wordCounts = blueprints.map(scene => Math.max(8, scene.scriptText.trim().split(/\s+/).filter(Boolean).length));
  const totalWords = wordCounts.reduce((sum, count) => sum + count, 0);
  const generated = providerResult.scenes || [];
  const visualAssets = (production.assets?.video?.visualAssets || []).filter(Boolean);
  const audio = production.assets?.audio || {};
  const narrationStatus = audio.intentionalSilence === true
    ? 'intentional_silence'
    : audio.simulated || audio.status === 'unavailable' ? 'unavailable' : 'current';

  return blueprints.map((scene, position) => {
    const generatedScene = generated.find(item => String(item.label || '').toLowerCase() === scene.label.toLowerCase()) || generated[position];
    const imagePath = visualAssets[position % Math.max(1, visualAssets.length)] || null;
    const assetPath = generatedScene?.path || imagePath;
    const assetType = generatedScene?.path ? 'video' : imagePath ? 'image' : 'missing';
    const provider = generatedScene?.provider || (assetType === 'image' ? 'image-provider' : providerResult.actualProvider || 'slideshow');
    return {
      id: `scene_${crypto.randomUUID()}`,
      position,
      ...scene,
      duration: Math.max(2, Number(((wordCounts[position] / totalWords) * totalDuration).toFixed(2))),
      assetType,
      assetOrigin: 'generated',
      assetPath,
      audioPath: null,
      narrationProvider: audio.provider || null,
      narrationModel: audio.model || null,
      narrationTaskId: audio.externalTaskId || null,
      narrationError: audio.error || null,
      narrationGeneratedAt: audio.generatedAt || null,
      narrationCost: audio.cost || {},
      provider,
      model: generatedScene?.model || providerResult.model || null,
      externalTaskId: generatedScene?.taskId || null,
      status: assetPath ? 'ready' : 'missing_asset',
      narrationStatus,
      revision: 1,
      locked: false,
      rightsConfirmed: true,
      provenanceSourceIds: [],
      containsSyntheticMedia: Boolean(generatedScene?.path && !['slideshow', 'simulation'].includes(provider)),
      estimatedCost: generatedScene?.path ? { unit: 'generated_seconds', amount: generatedScene.duration || 0, pricing: 'provider-priced' } : {},
      actualCost: {}
    };
  });
}

class SceneRepairService {
  constructor(db, videoGenerator, options = {}) {
    this.db = db;
    this.videoGenerator = videoGenerator;
    this.mediaGeneration = videoGenerator?.mediaGeneration;
    this.logger = options.logger || { info() {}, warn() {}, error() {} };
    this.dataRoot = options.dataRoot || path.join(__dirname, '..', 'data');
    this.getMediaDuration = options.getMediaDuration || getMediaDuration;
    this.runFFmpeg = options.runFFmpeg || runFFmpeg;
    this.activeRebuilds = new Set();
  }

  async withProductionOperationLease(productionId, operation, label = 'scene operation') {
    if (typeof this.db.acquireProductionOperationLock !== 'function' ||
        typeof this.db.renewProductionOperationLock !== 'function' ||
        typeof this.db.releaseProductionOperationLock !== 'function') {
      throw this.error('Database acquire, renew, and release operation-lock support is required for scene changes', 503, 'SCENE_EDIT_LOCK_UNAVAILABLE');
    }
    const owner = crypto.randomUUID();
    let acquired = false;
    let heartbeat = null;
    let renewalInFlight = Promise.resolve();
    let leaseFailure = null;
    const assertLease = async () => {
      await renewalInFlight;
      if (leaseFailure) throw leaseFailure;
    };
    assertLease.lease = Object.freeze({ productionId, owner });
    try {
      acquired = await this.db.acquireProductionOperationLock(productionId, owner);
      if (!acquired) throw this.error('Another operation is already changing this production', 409, 'SCENE_EDIT_IN_PROGRESS');
      heartbeat = setInterval(() => {
        renewalInFlight = renewalInFlight.then(async () => {
          if (!acquired || leaseFailure) return;
          const renewed = await this.db.renewProductionOperationLock(productionId, owner);
          if (!renewed) leaseFailure = this.error(`The ${label} lease was lost; this operation cannot commit further changes`, 409, 'SCENE_EDIT_LEASE_LOST');
        }).catch(error => {
          leaseFailure = this.error(`The ${label} lease could not be verified: ${error.message}`, 503, 'SCENE_EDIT_LEASE_UNVERIFIED');
        });
      }, 60 * 1000);
      heartbeat.unref?.();
      await assertLease();
      return await operation(assertLease);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      await renewalInFlight;
      if (acquired) await this.db.releaseProductionOperationLock(productionId, owner).catch(error => {
        this.logger.warn(`Could not release ${label} lease for ${productionId}: ${error.message}`);
      });
    }
  }

  async ensureManifest(bundle, assertLease = async () => {}) {
    await assertLease();
    if (bundle.scenes?.length) return bundle.scenes;
    const scenes = buildInitialSceneManifest(bundle, bundle.assets?.finalVideo?.provider || {});
    await this.initializeAudioSegments(bundle, scenes, assertLease);
    await assertLease();
    return this.db.replaceProductionScenes(bundle.id, scenes, assertLease.lease);
  }

  async initializeProduction(production, providerResult = {}, assertLease = async () => {}) {
    await assertLease();
    const scenes = buildInitialSceneManifest(production, providerResult);
    await this.initializeAudioSegments(production, scenes, assertLease);
    await assertLease();
    const saved = await this.db.replaceProductionScenes(production.id, scenes, assertLease.lease);
    await assertLease();
    production.assets.sceneManifest = { count: saved.length, version: 1, updatedAt: new Date().toISOString() };
    return saved;
  }

  async initializeAudioSegments(production, scenes, assertLease = async () => {}) {
    const audioPath = production.assets?.audio?.path;
    const audio = production.assets?.audio || {};
    if (!await this.videoGenerator?.isUsableAudioFile?.(audioPath)) {
      for (const scene of scenes) {
        scene.narrationStatus = audio.intentionalSilence === true ? 'intentional_silence' : 'unavailable';
        scene.narrationError = audio.intentionalSilence === true ? null : audio.error || 'Narration audio is unavailable';
      }
      return scenes;
    }
    const directory = path.join(this.dataRoot, 'audio', 'scenes', production.id);
    await assertLease();
    await fs.mkdir(directory, { recursive: true });
    let start = 0;
    for (const scene of scenes) {
      await assertLease();
      const output = path.join(directory, `${String(scene.position).padStart(3, '0')}_r1_${crypto.randomUUID()}.mp3`);
      try {
        await this.runFFmpeg(['-y', '-ss', start.toFixed(2), '-t', Number(scene.duration).toFixed(2), '-i', audioPath, '-vn', '-c:a', 'libmp3lame', output]);
        await assertLease();
        scene.audioPath = output;
        scene.narrationStatus = 'current';
        scene.narrationProvider = audio.provider || null;
        scene.narrationModel = audio.model || null;
        scene.narrationTaskId = audio.externalTaskId || null;
        scene.narrationError = null;
        scene.narrationGeneratedAt = audio.generatedAt || null;
        scene.narrationCost = audio.cost || {};
      } catch (error) {
        await assertLease();
        this.logger.warn(`Could not split narration for scene ${scene.position + 1}: ${error.message}`);
        scene.audioPath = null;
        scene.narrationStatus = 'unavailable';
        scene.narrationError = `Narration segment could not be prepared: ${error.message}`;
      }
      start += Number(scene.duration);
    }
    return scenes;
  }

  async getEditableBundle(productionId, assertLease = async () => {}) {
    const bundle = await this.db.getProductionBundle(productionId);
    if (!bundle) throw this.error('Content not found', 404);
    if (bundle.schedule || bundle.review_status === 'approved') {
      throw this.error('Scene repair is locked after content is approved or scheduled', 409);
    }
    if (!bundle.scenes?.length) {
      bundle.scenes = await this.ensureManifest(bundle, assertLease);
    }
    return bundle;
  }

  async updateScene(productionId, sceneId, input = {}) {
    return this.withProductionOperationLease(productionId, assertLease => this.updateSceneUnlocked(productionId, sceneId, input, assertLease), 'scene update');
  }

  async updateSceneUnlocked(productionId, sceneId, input = {}, assertLease = async () => {}) {
    await assertLease();
    const bundle = await this.getEditableBundle(productionId, assertLease);
    const scene = bundle.scenes.find(item => item.id === sceneId);
    if (!scene) throw this.error('Scene not found', 404);
    if (scene.locked && input.locked !== false) throw this.error('Unlock this scene before editing it', 409);

    const verifiedSourceIds = new Set((bundle.provenance?.sources || []).filter(source => source.status === 'verified').map(source => source.id));
    const provenanceSourceIds = input.provenanceSourceIds === undefined
      ? scene.provenanceSourceIds
      : [...new Set(this.array(input.provenanceSourceIds).filter(id => verifiedSourceIds.has(id)))];
    const scriptText = input.scriptText === undefined ? scene.scriptText : this.text(input.scriptText, 10000, 'Scene narration');
    const prompt = input.prompt === undefined ? scene.prompt : this.text(input.prompt, 2000, 'Scene prompt');
    const label = input.label === undefined ? scene.label : this.text(input.label, 120, 'Scene label');
    const duration = input.duration === undefined ? scene.duration : Number(input.duration);
    if (!Number.isFinite(duration) || duration < 2 || duration > 600) throw this.error('Scene duration must be between 2 and 600 seconds', 400);
    const scriptChanged = scriptText !== scene.scriptText;
    const promptChanged = prompt !== scene.prompt;
    const durationChanged = duration !== scene.duration;
    await assertLease();
    const next = await this.db.updateProductionScene(productionId, sceneId, {
      label, scriptText, prompt, duration, provenanceSourceIds,
      locked: input.locked === undefined ? scene.locked : input.locked === true,
      narrationStatus: scriptChanged ? 'stale' : scene.narrationStatus,
      status: promptChanged ? 'visual_stale' : scriptChanged || durationChanged ? 'needs_rebuild' : scene.status,
      revision: scriptChanged || promptChanged || durationChanged ? scene.revision + 1 : scene.revision
    }, assertLease.lease);

    await assertLease();
    if (scriptChanged && input.factualChange !== false) {
      await this.markSceneClaimForReview(bundle, next, verifiedSourceIds, assertLease);
    }
    await assertLease();
    await this.db.saveProductionSceneRevision({
      productionId, sceneId, action: 'edit', before: scene, after: next,
      costEvidence: { billed: false }
    }, assertLease.lease);
    await assertLease();
    return next;
  }

  async markSceneClaimForReview(bundle, scene, verifiedSourceIds, assertLease = async () => {}) {
    await assertLease();
    const provenance = bundle.provenance || { sources: [], claims: [], containsSyntheticMedia: false };
    const id = `scene_claim_${scene.id}_r${scene.revision}`;
    const sourceIds = scene.provenanceSourceIds.filter(sourceId => verifiedSourceIds.has(sourceId));
    const claims = [...(provenance.claims || []).filter(claim => !String(claim.id).startsWith(`scene_claim_${scene.id}_`)), {
      id,
      text: scene.scriptText,
      riskLevel: 'standard',
      sourceIds,
      status: sourceIds.length ? 'supported' : 'pending',
      notes: `Narration changed in ${scene.label}; review before approval.`
    }];
    await assertLease();
    await new ProvenanceService(this.db).review(bundle.id, {
      sources: provenance.sources || [], claims,
      containsSyntheticMedia: provenance.containsSyntheticMedia
    }, assertLease.lease);
  }

  async reorder(productionId, orderedIds) {
    return this.withProductionOperationLease(productionId, assertLease => this.reorderUnlocked(productionId, orderedIds, assertLease), 'scene reorder');
  }

  async reorderUnlocked(productionId, orderedIds, assertLease = async () => {}) {
    await assertLease();
    const bundle = await this.getEditableBundle(productionId, assertLease);
    if (bundle.scenes.some(scene => scene.locked)) throw this.error('Unlock every scene before changing timeline order', 409);
    const before = bundle.scenes;
    await assertLease();
    const after = await this.db.reorderProductionScenes(productionId, this.array(orderedIds), assertLease.lease);
    await assertLease();
    await this.db.saveProductionSceneRevision({
      productionId, sceneId: after[0].id, action: 'reorder', before: { order: before.map(scene => scene.id) },
      after: { order: after.map(scene => scene.id) }, costEvidence: { billed: false }
    }, assertLease.lease);
    await assertLease();
    return after;
  }

  async regenerateNarration(productionId, sceneId, input = {}) {
    return this.withProductionOperationLease(productionId, assertLease => this.regenerateNarrationUnlocked(productionId, sceneId, input, assertLease), 'narration regeneration');
  }

  async regenerateNarrationUnlocked(productionId, sceneId, input = {}, assertLease = async () => {}) {
    await assertLease();
    const bundle = await this.getEditableBundle(productionId, assertLease);
    const scene = bundle.scenes.find(item => item.id === sceneId);
    if (!scene) throw this.error('Scene not found', 404);
    if (scene.locked) throw this.error('Unlock this scene before regenerating narration', 409);
    if (input.confirmCost !== true) {
      throw this.error('Confirm that narration regeneration may consume provider credits', 409, 'NARRATION_COST_CONFIRMATION_REQUIRED');
    }

    const before = scene;
    const outputPath = path.join(this.dataRoot, 'audio', 'scenes', productionId, `${String(scene.position).padStart(3, '0')}_r${scene.revision + 1}_${crypto.randomUUID()}.mp3`);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    let generatedPath = null;
    let scenePersisted = false;
    try {
      await assertLease();
      await this.db.updateProductionScene(productionId, sceneId, {
        narrationStatus: 'generating', narrationError: null
      }, assertLease.lease);
      generatedPath = await this.videoGenerator.generateTTSAudio(scene.scriptText, outputPath, { assertLease });
      await assertLease();
      const evidence = this.videoGenerator.lastNarrationResult || {};
      if (!await this.videoGenerator.isUsableAudioFile(generatedPath)) {
        throw this.error('Narration regeneration returned no usable audio; configure a live TTS provider and retry', 422, 'NARRATION_UNAVAILABLE');
      }
      await assertLease();
      const duration = await this.narrationDuration(generatedPath, scene);
      await assertLease();
      const cost = evidence.cost || {
        provider: evidence.provider || 'configured-tts', amount: null, currency: null, invoiceRequired: true
      };
      await assertLease();
      const next = await this.db.updateProductionScene(productionId, sceneId, {
        audioPath: generatedPath,
        duration,
        narrationStatus: 'current',
        narrationProvider: evidence.provider || 'configured-tts',
        narrationModel: evidence.model || null,
        narrationTaskId: evidence.externalTaskId || null,
        narrationError: null,
        narrationGeneratedAt: evidence.generatedAt || new Date().toISOString(),
        narrationCost: cost,
        status: scene.status === 'visual_stale' ? 'visual_stale' : 'needs_rebuild',
        revision: scene.revision + 1
      }, assertLease.lease);
      scenePersisted = true;
      await assertLease();
      await this.updateProductionAudioState(bundle, {
        status: 'partial', path: null, simulated: false, intentionalSilence: false,
        error: 'Scene narration changed; rebuild the final narration mix before approval'
      }, assertLease);
      await assertLease();
      await this.db.saveProductionSceneRevision({
        productionId, sceneId, action: 'regenerate_narration', before, after: next, costEvidence: cost
      }, assertLease.lease);
      return next;
    } catch (error) {
      if (isLeaseFailure(error)) throw error;
      await assertLease();
      if (!scenePersisted) {
        await fs.unlink(outputPath).catch(() => {});
        if (generatedPath) {
          await fs.unlink(generatedPath).catch(() => {});
          await fs.unlink(`${generatedPath}.pcm`).catch(() => {});
        }
      }
      const evidence = this.videoGenerator.lastNarrationResult || {};
      await this.db.updateProductionScene(productionId, sceneId, {
        narrationStatus: 'failed', narrationProvider: evidence.provider || scene.narrationProvider,
        narrationModel: evidence.model || scene.narrationModel, narrationTaskId: evidence.externalTaskId || null,
        narrationError: error.message, narrationGeneratedAt: evidence.generatedAt || new Date().toISOString(),
        narrationCost: evidence.cost || scene.narrationCost || {}
      }, assertLease.lease).catch(() => {});
      await this.db.saveProductionSceneRevision({
        productionId, sceneId, action: 'regenerate_narration', status: 'failed', before, after: {},
        costEvidence: evidence.cost || {}, error: error.message
      }, assertLease.lease).catch(() => {});
      throw error;
    }
  }

  async setSilenceOverride(productionId, input = {}) {
    return this.withProductionOperationLease(productionId, assertLease => this.setSilenceOverrideUnlocked(productionId, input, assertLease), 'silence override');
  }

  async setSilenceOverrideUnlocked(productionId, input = {}, assertLease = async () => {}) {
    await assertLease();
    const bundle = await this.getEditableBundle(productionId, assertLease);
    const enabled = input.enabled === true;
    const reason = String(input.reason || '').trim();
    if (enabled && input.confirmed !== true) {
      throw this.error('Confirm the intentional-silence override before applying it', 409, 'SILENCE_CONFIRMATION_REQUIRED');
    }
    if (enabled && reason.length < 10) {
      throw this.error('Explain why this production is intentionally silent using at least 10 characters', 400);
    }
    const changedAt = new Date().toISOString();
    const audioChanges = enabled
      ? {
          path: null, status: 'intentional_silence', simulated: false, intentionalSilence: true,
          silenceReason: reason, silenceConfirmedAt: changedAt, provider: 'operator-override', model: null,
          externalTaskId: null, generatedAt: changedAt, cost: { billed: false }, error: null
        }
      : {
          path: null, status: 'unavailable', simulated: true, intentionalSilence: false,
          silenceReason: null, silenceConfirmedAt: null, provider: null, model: null,
          externalTaskId: null, generatedAt: changedAt, cost: { billed: false },
          error: 'Narration is required; regenerate every missing scene before approval'
        };
    await assertLease();
    await this.updateProductionAudioState(bundle, audioChanges, assertLease);
    const updated = [];
    for (const scene of bundle.scenes) {
      await assertLease();
      const before = scene;
      const hasAudio = !enabled && scene.audioPath && await this.pathExists(scene.audioPath);
      await assertLease();
      const next = await this.db.updateProductionScene(productionId, scene.id, {
        audioPath: enabled ? null : scene.audioPath,
        narrationStatus: enabled ? 'intentional_silence' : hasAudio ? 'current' : 'unavailable',
        narrationProvider: enabled ? 'operator-override' : scene.narrationProvider,
        narrationModel: enabled ? null : scene.narrationModel,
        narrationTaskId: enabled ? null : scene.narrationTaskId,
        narrationError: enabled || hasAudio ? null : 'Narration is required for this scene',
        narrationGeneratedAt: changedAt,
        narrationCost: enabled ? { billed: false } : scene.narrationCost,
        status: scene.status === 'visual_stale' ? 'visual_stale' : 'needs_rebuild',
        revision: scene.revision + 1
      }, assertLease.lease);
      await assertLease();
      await this.db.saveProductionSceneRevision({
        productionId, sceneId: scene.id, action: enabled ? 'confirm_intentional_silence' : 'require_narration',
        before, after: next, costEvidence: { billed: false }
      }, assertLease.lease);
      updated.push(next);
    }
    return { enabled, reason: enabled ? reason : null, scenes: updated };
  }

  async updateProductionAudioState(bundle, changes, assertLease = async () => {}) {
    await assertLease();
    const assets = { ...bundle.assets, audio: { ...(bundle.assets?.audio || {}), ...changes } };
    await this.db.updateProductionData({
      id: bundle.id, status: bundle.status, assets, timeline: bundle.timeline,
      scheduledPublishTime: bundle.scheduled_publish_time, priority: bundle.priority
    }, assertLease.lease);
    await assertLease();
    bundle.assets = assets;
    return assets.audio;
  }

  async regenerationEstimate(productionId, sceneId, input = {}) {
    return this.withProductionOperationLease(
      productionId,
      assertLease => this.regenerationEstimateUnlocked(productionId, sceneId, input, assertLease),
      'regeneration estimate'
    );
  }

  async regenerationEstimateUnlocked(productionId, sceneId, input = {}, assertLease = async () => {}) {
    await assertLease();
    const bundle = await this.getEditableBundle(productionId, assertLease);
    const scene = bundle.scenes.find(item => item.id === sceneId);
    if (!scene) throw this.error('Scene not found', 404);
    await assertLease();
    const settings = await this.mediaGeneration?.settings?.() || { provider: 'slideshow', order: [], clipDuration: scene.duration };
    await assertLease();
    const requestedProvider = input.provider || (scene.provider && scene.provider !== 'image-provider' ? scene.provider : settings.provider);
    const provider = this.mediaGeneration?.registry?.select(requestedProvider, settings.order, { duration: Math.min(scene.duration, settings.clipDuration || scene.duration) });
    const paid = Boolean(provider && provider.id !== 'slideshow');
    const generatedSeconds = paid ? provider.normalizeRequest({ duration: Math.min(scene.duration, settings.clipDuration || scene.duration) }).duration : 0;
    return {
      provider: provider?.id || 'slideshow', model: provider?.model || 'local-image', paid,
      generatedSeconds, pricing: paid ? 'provider-priced' : 'no video-provider charge',
      warning: paid ? 'This regeneration can consume provider credits. The provider invoice is authoritative.' : null
    };
  }

  async regenerate(productionId, sceneId, input = {}) {
    return this.withProductionOperationLease(productionId, assertLease => this.regenerateUnlocked(productionId, sceneId, input, assertLease), 'visual regeneration');
  }

  async regenerateUnlocked(productionId, sceneId, input = {}, assertLease = async () => {}) {
    await assertLease();
    const bundle = await this.getEditableBundle(productionId, assertLease);
    const scene = bundle.scenes.find(item => item.id === sceneId);
    if (!scene) throw this.error('Scene not found', 404);
    if (scene.locked) throw this.error('Unlock this scene before regenerating it', 409);
    const estimate = await this.regenerationEstimateUnlocked(productionId, sceneId, input, assertLease);
    if (estimate.paid && input.confirmPaid !== true) throw this.error('Confirm the paid scene regeneration before starting it', 409, 'PAID_CONFIRMATION_REQUIRED', estimate);

    const before = scene;
    let visual = {};
    let narration = {};
    const attemptFiles = new Set();
    let scenePersisted = false;
    try {
      await assertLease();
      await this.db.updateProductionScene(productionId, sceneId, { status: 'generating' }, assertLease.lease);
      if (estimate.paid) {
        const provider = this.mediaGeneration.registry.get(estimate.provider);
        const settings = await this.mediaGeneration.settings();
        const request = provider.normalizeRequest({
          prompt: scene.prompt, duration: estimate.generatedSeconds, resolution: settings.resolution,
          aspectRatio: settings.aspectRatio, generateAudio: false, referenceImages: []
        });
        const outputPath = path.join(this.dataRoot, 'videos', 'scenes', `${productionId}_${scene.id}_r${scene.revision + 1}_${crypto.randomUUID()}.mp4`);
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        const result = await this.mediaGeneration.generateClip({
          jobId: `repair_${productionId}_${scene.id}_${scene.revision + 1}`,
          productionId, scene: { index: scene.position, prompt: scene.prompt }, provider, outputPath, request, assertLease
        });
        if (result?.outputPath) attemptFiles.add(result.outputPath);
        await assertLease();
        visual = {
          assetType: 'video', assetOrigin: 'generated', assetPath: result.outputPath,
          provider: provider.id, model: result.task.model, externalTaskId: result.task.external_task_id,
          containsSyntheticMedia: true
        };
      } else {
        const profile = await this.db.getChannelProfile?.() || {};
        const assets = await this.videoGenerator.generateVisualAssets(scene.prompt, profile.visual_style || 'ethereal', 1, assertLease);
        for (const asset of assets || []) if (asset) attemptFiles.add(asset);
        await assertLease();
        const assetPath = assets[0];
        const generatedImageUsable = assetPath && IMAGE_EXTENSIONS.has(path.extname(assetPath).toLowerCase())
          && await this.isUsableSceneAsset({ assetType: 'image', assetPath });
        if (!generatedImageUsable) {
          throw this.error('No valid replacement image was generated; configure an image provider or upload a usable asset', 422, 'SCENE_ASSET_UNAVAILABLE');
        }
        visual = { assetType: 'image', assetOrigin: 'generated', assetPath, provider: 'image-provider', model: null, externalTaskId: null, containsSyntheticMedia: true };
      }

      if (scene.narrationStatus === 'stale' || input.regenerateNarration === true) {
        const audioPath = path.join(this.dataRoot, 'audio', 'scenes', productionId, `${String(scene.position).padStart(3, '0')}_r${scene.revision + 1}_${crypto.randomUUID()}.mp3`);
        await fs.mkdir(path.dirname(audioPath), { recursive: true });
        attemptFiles.add(audioPath);
        const generatedPath = await this.videoGenerator.generateTTSAudio(scene.scriptText, audioPath, { assertLease });
        attemptFiles.add(generatedPath);
        attemptFiles.add(`${generatedPath}.pcm`);
        await assertLease();
        if (!await this.videoGenerator.isUsableAudioFile(generatedPath)) {
          throw this.error('Narration regeneration returned a simulation; configure a live TTS provider before rebuilding edited narration', 422, 'NARRATION_UNAVAILABLE');
        }
        const evidence = this.videoGenerator.lastNarrationResult || {};
        narration = {
          audioPath: generatedPath, duration: await this.narrationDuration(generatedPath, scene), narrationStatus: 'current',
          narrationProvider: evidence.provider || 'configured-tts', narrationModel: evidence.model || null,
          narrationTaskId: evidence.externalTaskId || null, narrationError: null,
          narrationGeneratedAt: evidence.generatedAt || new Date().toISOString(), narrationCost: evidence.cost || {}
        };
      }

      await assertLease();
      const next = await this.db.updateProductionScene(productionId, sceneId, {
        ...visual, ...narration, status: 'needs_rebuild', revision: scene.revision + 1,
        estimatedCost: estimate,
        actualCost: { generatedSeconds: estimate.generatedSeconds, provider: estimate.provider, amount: null, currency: null, invoiceRequired: estimate.paid }
      }, assertLease.lease);
      scenePersisted = true;
      await assertLease();
      await this.db.saveProductionSceneRevision({
        productionId, sceneId, action: 'regenerate', before, after: next,
        costEvidence: next.actualCost
      }, assertLease.lease);
      return { scene: next, estimate };
    } catch (error) {
      if (isLeaseFailure(error)) throw error;
      await assertLease();
      if (!scenePersisted) {
        for (const filePath of attemptFiles) await fs.unlink(filePath).catch(() => {});
      }
      await this.db.updateProductionScene(productionId, sceneId, { status: 'failed' }, assertLease.lease).catch(() => {});
      await this.db.saveProductionSceneRevision({
        productionId, sceneId, action: 'regenerate', status: 'failed', before,
        after: {}, costEvidence: estimate, error: error.message
      }, assertLease.lease).catch(() => {});
      throw error;
    }
  }

  async replaceAsset(productionId, sceneId, file = {}) {
    return this.withProductionOperationLease(
      productionId,
      assertLease => this.replaceAssetUnlocked(productionId, sceneId, file, assertLease),
      'asset replacement'
    );
  }

  async replaceAssetUnlocked(productionId, sceneId, file = {}, assertLease = async () => {}) {
    await assertLease();
    const bundle = await this.getEditableBundle(productionId, assertLease);
    await assertLease();
    const scene = bundle.scenes.find(item => item.id === sceneId);
    if (!scene) throw this.error('Scene not found', 404);
    if (scene.locked) throw this.error('Unlock this scene before replacing its asset', 409);
    if (file.rightsConfirmed !== true) throw this.error('Confirm that you have rights to the replacement asset', 400, 'RIGHTS_CONFIRMATION_REQUIRED');
    if (!Buffer.isBuffer(file.buffer) || !file.buffer.length) throw this.error('Replacement asset is empty', 400);

    const contentType = String(file.contentType || '').toLowerCase();
    const assetType = contentType.startsWith('image/') ? 'image' : contentType.startsWith('video/') ? 'video' : null;
    if (!assetType) throw this.error('Replacement assets must be an image or video', 415);
    const suppliedExtension = path.extname(String(file.filename || '')).toLowerCase();
    const extension = suppliedExtension || (assetType === 'video' ? '.mp4' : '.png');
    if ((assetType === 'video' && !VIDEO_EXTENSIONS.has(extension)) || (assetType === 'image' && !IMAGE_EXTENSIONS.has(extension))) {
      throw this.error('Replacement asset file type is not supported', 415);
    }

    const directory = path.join(this.dataRoot, 'scene-assets', productionId);
    const attemptId = crypto.randomUUID();
    const outputPath = path.join(directory, `${scene.id}_r${scene.revision + 1}_${attemptId}${extension}`);
    const tempPath = `${outputPath}.${attemptId}.upload${extension}`;
    let scenePersisted = false;
    try {
      await assertLease();
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(tempPath, file.buffer, { flag: 'wx' });
      await assertLease();

      try {
        if (assetType === 'video') {
          if (!await this.mediaGeneration?.isValidVideo?.(tempPath)) throw new Error('Video is not a valid, decodable MP4-compatible asset');
        } else {
          const metadata = await sharp(tempPath, { failOn: 'error' }).metadata();
          const expectedFormat = extension === '.jpg' || extension === '.jpeg' ? 'jpeg' : extension.slice(1);
          if (!metadata.width || !metadata.height || metadata.format !== expectedFormat) {
            throw new Error('Image content does not match its file extension or is not a valid image');
          }
        }
      } catch (error) {
        throw this.error(error.message || 'Replacement asset is invalid', 422);
      }

      await assertLease();
      await fs.rename(tempPath, outputPath);
      await assertLease();
      const next = await this.db.updateProductionScene(productionId, sceneId, {
        assetType, assetOrigin: 'uploaded', assetPath: outputPath, provider: 'operator-upload', model: null,
        externalTaskId: null, rightsConfirmed: true, containsSyntheticMedia: file.containsSyntheticMedia === true,
        status: 'needs_rebuild', revision: scene.revision + 1,
        estimatedCost: {}, actualCost: { billed: false }
      }, assertLease.lease);
      scenePersisted = true;
      await assertLease();
      await this.db.saveProductionSceneRevision({
        productionId, sceneId, action: 'replace_asset', before: scene, after: next,
        costEvidence: { billed: false }
      }, assertLease.lease);
      return next;
    } catch (error) {
      if (isLeaseFailure(error)) throw error;
      await assertLease();
      if (!scenePersisted) {
        await fs.unlink(tempPath).catch(() => {});
        await fs.unlink(outputPath).catch(() => {});
      }
      throw error;
    }
  }

  async narrationDuration(audioPath, scene) {
    try {
      return Math.max(2, (await this.getMediaDuration(audioPath)) + 0.5);
    } catch (error) {
      this.logger.warn(`Could not measure narration duration for scene ${scene.id}, keeping previous duration: ${error.message}`);
      return scene.duration;
    }
  }

  async cleanupStaleRepairTemps(productionId, maxAgeMs = 24 * 60 * 60 * 1000) {
    const targets = [
      { directory: path.join(this.dataRoot, 'videos'), prefix: `${productionId}_repair_`, suffix: /(?:_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_visual\.mp4\.rendering\.mp4|\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.rendering\.mp4)$/i },
      { directory: path.join(this.dataRoot, 'captions'), prefix: `${productionId}_repair_`, suffix: /\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.writing$/i },
      { directory: path.join(this.dataRoot, 'audio'), prefix: `${productionId}_scene_mix_`, suffix: /\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.writing\.m4a$/i }
    ];
    const cutoff = Date.now() - Math.max(0, Number(maxAgeMs) || 0);
    let removed = 0;
    for (const target of targets) {
      let entries;
      try { entries = await fs.readdir(target.directory, { withFileTypes: true }); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.startsWith(target.prefix) || !target.suffix.test(entry.name)) continue;
        const filePath = path.join(target.directory, entry.name);
        try {
          const stat = await fs.stat(filePath);
          if (stat.mtimeMs >= cutoff) continue;
          await fs.unlink(filePath);
          removed++;
        } catch (error) {
          if (error.code !== 'ENOENT') this.logger.warn(`Could not remove stale scene repair temp ${filePath}: ${error.message}`);
        }
      }
    }
    return removed;
  }
  async rebuild(productionId) {
    if (this.activeRebuilds.has(productionId)) {
      throw this.error('A scene rebuild is already running for this production', 409, 'SCENE_REBUILD_IN_PROGRESS');
    }
    if (typeof this.db.acquireProductionOperationLock !== 'function' ||
        typeof this.db.renewProductionOperationLock !== 'function' ||
        typeof this.db.releaseProductionOperationLock !== 'function') {
      throw this.error('Database acquire, renew, and release operation-lock support is required for scene rebuilds', 503, 'SCENE_REBUILD_LOCK_UNAVAILABLE');
    }
    this.activeRebuilds.add(productionId);
    const lockOwner = crypto.randomUUID();
    let databaseLockAcquired = false;
    let leaseHeartbeat = null;
    let renewalInFlight = Promise.resolve();
    let leaseFailure = null;
    const assertLease = async () => {
      await renewalInFlight;
      if (leaseFailure) throw leaseFailure;
    };
    // Rebuild uses a dedicated lease loop rather than the shared scene-edit
    // wrapper, so attach the owner context explicitly for fenced DB writes.
    assertLease.lease = Object.freeze({ productionId, owner: lockOwner });
    try {
      databaseLockAcquired = await this.db.acquireProductionOperationLock(productionId, lockOwner);
      if (!databaseLockAcquired) {
        throw this.error('Another application process is rebuilding this production', 409, 'SCENE_REBUILD_IN_PROGRESS');
      }
      leaseHeartbeat = setInterval(() => {
        renewalInFlight = renewalInFlight.then(async () => {
          if (!databaseLockAcquired || leaseFailure) return;
          const renewed = await this.db.renewProductionOperationLock(productionId, lockOwner);
          if (!renewed) {
            leaseFailure = this.error('Scene rebuild lease was lost; this attempt cannot commit its output', 409, 'SCENE_REBUILD_LEASE_LOST');
          }
        }).catch(error => {
          leaseFailure = this.error(`Scene rebuild lease could not be verified: ${error.message}`, 503, 'SCENE_REBUILD_LEASE_UNVERIFIED');
        });
      }, 60 * 1000);
      leaseHeartbeat.unref?.();
      await assertLease();
      if (databaseLockAcquired) await this.cleanupStaleRepairTemps(productionId);
      return await this.rebuildUnlocked(productionId, assertLease);
    } finally {
      if (leaseHeartbeat) clearInterval(leaseHeartbeat);
      await renewalInFlight;
      if (databaseLockAcquired) {
        await this.db.releaseProductionOperationLock(productionId, lockOwner).catch(error => {
          this.logger.warn(`Could not release scene rebuild lease for ${productionId}: ${error.message}`);
        });
      }
      this.activeRebuilds.delete(productionId);
    }
  }

  async rebuildUnlocked(productionId, assertLease = async () => {}) {
    await assertLease();
    const bundle = await this.getEditableBundle(productionId, assertLease);
    await assertLease();
    const scenes = await this.db.listProductionScenes(productionId);
    await assertLease();
    if (!scenes.length) throw this.error('No scene manifest is available', 409);
    const missing = [];
    const fullNarrationReady = await this.videoGenerator.isUsableAudioFile(bundle.assets?.audio?.path);
    const currentSceneAudio = [];
    for (const scene of scenes) {
      await assertLease();
      if (!['current', 'intentional_silence'].includes(scene.narrationStatus)) {
        missing.push(`${scene.label}: narration is ${String(scene.narrationStatus || 'unavailable').replaceAll('_', ' ')}`);
      }
      if (scene.narrationStatus === 'current') {
        const audioUsable = await this.isUsableNarrationSegment(scene);
        currentSceneAudio.push(audioUsable);
        if (scene.audioPath && !audioUsable) missing.push(`${scene.label}: narration segment is missing or invalid`);
      }
      if (scene.status === 'visual_stale') missing.push(`${scene.label}: visual prompt changed but the asset was not regenerated or replaced`);
      if (['failed', 'generating', 'missing_asset'].includes(scene.status)) missing.push(`${scene.label}: scene status is ${scene.status.replaceAll('_', ' ')}`);
      if (!await this.isUsableSceneAsset(scene)) missing.push(`${scene.label}: visual asset is missing or invalid`);
      if (scene.assetOrigin === 'uploaded' && !scene.rightsConfirmed) missing.push(`${scene.label}: media rights are not confirmed`);
    }
    const hasAnySceneAudioPath = scenes.some(scene => Boolean(scene.audioPath));
    if (hasAnySceneAudioPath && currentSceneAudio.some(value => !value)) {
      missing.push('The scene narration mix is incomplete; regenerate every missing or invalid narration segment');
    } else if (!hasAnySceneAudioPath && !fullNarrationReady) {
      missing.push('No usable production or scene narration audio is available');
    }
    if (missing.length) throw this.error(`Cannot rebuild: ${missing.join('; ')}`, 409, 'SCENE_REBUILD_BLOCKED', { blockers: missing });

    await assertLease();
    const fingerprint = await this.buildRebuildFingerprint(scenes, bundle.assets?.audio?.path, assertLease);
    await assertLease();
    const attemptId = crypto.randomUUID();
    // Every worker publishes immutable attempt-scoped artifacts. A stale worker
    // can therefore never overwrite a newer worker's cache/output path.
    const visualPath = path.join(this.dataRoot, 'videos', `${productionId}_repair_${fingerprint}_${attemptId}_visual.mp4`);
    const visualTempPath = `${visualPath}.rendering.mp4`;
    const finalPath = path.join(this.dataRoot, 'videos', `${productionId}_repair_${fingerprint}_${attemptId}.mp4`);
    const finalTempPath = `${finalPath}.${attemptId}.rendering.mp4`;
    const captionsPath = path.join(this.dataRoot, 'captions', `${productionId}_repair_${fingerprint}_${attemptId}.srt`);
    await fs.mkdir(path.dirname(finalPath), { recursive: true });
    await fs.mkdir(path.dirname(captionsPath), { recursive: true });

    const validateVideo = async filePath => {
      if (typeof this.videoGenerator.validateRenderedVideo !== 'function') {
        throw this.error('Video generator cannot validate rendered repair output', 503, 'VIDEO_VALIDATION_UNAVAILABLE');
      }
      return this.videoGenerator.validateRenderedVideo(filePath);
    };
    let visualReady = false;
    try {
      await validateVideo(visualPath);
      visualReady = true;
    } catch (_error) {
      await assertLease();
      await fs.unlink(visualPath).catch(() => {});
    }
    if (!visualReady) {
      await assertLease();
      await fs.unlink(visualTempPath).catch(() => {});
      try {
        await this.videoGenerator.renderMediaTimeline(scenes.map(scene => ({
          type: scene.assetType, path: scene.assetPath, duration: scene.duration
        })), visualTempPath, {}, assertLease);
        await validateVideo(visualTempPath);
        await assertLease();
        await replaceFileWithRollback(visualTempPath, visualPath, attemptId, assertLease);
      } catch (error) {
        if (isLeaseFailure(error)) throw error;
        await assertLease();
        await fs.unlink(visualTempPath).catch(() => {});
        throw error;
      }
    }

    await assertLease();
    const audioPath = await this.rebuildNarration(productionId, scenes, bundle.assets?.audio?.path, fingerprint, assertLease, attemptId);
    await assertLease();
    const allIntentionalSilence = scenes.every(scene => scene.narrationStatus === 'intentional_silence');
    let finalReady = false;
    try {
      await validateVideo(finalPath);
      finalReady = true;
    } catch (_error) {
      await assertLease();
      await fs.unlink(finalPath).catch(() => {});
    }
    if (!finalReady) {
      await assertLease();
      await fs.unlink(finalTempPath).catch(() => {});
      try {
        await this.videoGenerator.addAudioToVideo(visualPath, audioPath, finalTempPath, {
          allowSilent: allIntentionalSilence,
          assertLease
        });
        await validateVideo(finalTempPath);
        await assertLease();
        await replaceFileWithRollback(finalTempPath, finalPath, attemptId, assertLease);
      } catch (error) {
        if (isLeaseFailure(error)) throw error;
        await assertLease();
        await fs.unlink(finalTempPath).catch(() => {});
        throw error;
      }
    }
    const captions = this.buildSRT(scenes);
    const existingCaptions = await fs.readFile(captionsPath, 'utf8').catch(() => null);
    await assertLease();
    if (existingCaptions !== captions) {
      const captionsTempPath = `${captionsPath}.${attemptId}.writing`;
      await fs.writeFile(captionsTempPath, captions);
      await assertLease();
      await replaceFileWithRollback(captionsTempPath, captionsPath, attemptId, assertLease);
    }
    const stats = await fs.stat(finalPath);
    const previousPath = bundle.assets?.finalVideo?.path || null;
    const containsSyntheticMedia = scenes.some(scene => scene.containsSyntheticMedia);
    const assets = {
      ...bundle.assets,
      audio: {
        ...(bundle.assets?.audio || {}), path: audioPath, simulated: false,
        status: allIntentionalSilence ? 'intentional_silence' : 'ready',
        intentionalSilence: allIntentionalSilence,
        provider: allIntentionalSilence ? 'operator-override' : 'scene-mix',
        model: allIntentionalSilence ? null : 'ffmpeg-concat',
        generatedAt: new Date().toISOString(), error: null,
        sceneMixed: scenes.some(scene => scene.audioPath) || scenes.some(scene => scene.narrationStatus === 'intentional_silence'),
        sceneEvidence: scenes.map(scene => ({
          sceneId: scene.id, status: scene.narrationStatus, provider: scene.narrationProvider,
          model: scene.narrationModel, externalTaskId: scene.narrationTaskId, generatedAt: scene.narrationGeneratedAt
        }))
      },
      captions: { path: captionsPath, format: 'srt', language: 'en', autoGenerated: true, sceneAware: true },
      finalVideo: {
        ...(bundle.assets?.finalVideo || {}), path: finalPath, previousPath, fileSize: stats.size,
        duration: scenes.reduce((sum, scene) => sum + scene.duration, 0), simulated: false,
        provider: { actualProvider: 'scene-repair', model: 'mixed-assets', scenes: scenes.length }
      },
      sceneManifest: { count: scenes.length, version: 1, updatedAt: new Date().toISOString() }
    };
    const timeline = { ...bundle.timeline, sceneRepairAt: new Date().toISOString(), captionsGenerated: new Date().toISOString(), readyForUpload: new Date().toISOString() };
    await assertLease();
    await assertLease();
    await this.db.finalizeProductionRebuild({
      production: {
        id: productionId, status: 'ready', assets, timeline,
        scheduledPublishTime: bundle.scheduled_publish_time, priority: bundle.priority
      },
      sceneIds: scenes.map(scene => scene.id),
      provenance: containsSyntheticMedia && bundle.provenance && !bundle.provenance.containsSyntheticMedia
        ? { ...bundle.provenance, containsSyntheticMedia: true, reviewedAt: null }
        : null,
      revision: {
        sceneId: scenes[0].id,
        before: { finalVideo: previousPath },
        after: { finalVideo: finalPath, captions: captionsPath },
        costEvidence: { billed: false, reusedScenes: scenes.length }
      }
    }, assertLease.lease);
    await assertLease();
    return { productionId, finalVideo: finalPath, previousVideo: previousPath, captions: captionsPath, scenes: scenes.length };
  }

  async buildRebuildFingerprint(scenes, fallbackAudioPath, assertLease = async () => {}) {
    const hash = crypto.createHash('sha256');
    const inputs = [];
    for (const scene of scenes) {
      await assertLease();
      const entry = {
        id: scene.id, revision: scene.revision, assetType: scene.assetType,
        duration: Number(scene.duration), narrationStatus: scene.narrationStatus,
        scriptText: scene.scriptText || ''
      };
      if (scene.assetPath) entry.assetSha256 = await this.hashFile(scene.assetPath);
      await assertLease();
      if (scene.audioPath && scene.narrationStatus === 'current') entry.audioSha256 = await this.hashFile(scene.audioPath);
      await assertLease();
      inputs.push(entry);
    }
    const fallback = fallbackAudioPath && !scenes.some(scene => scene.audioPath && scene.narrationStatus === 'current')
      ? await this.hashFile(fallbackAudioPath) : null;
    await assertLease();
    hash.update(JSON.stringify({ version: 2, inputs, fallback }));
    return hash.digest('hex').slice(0, 24);
  }

  async hashFile(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fsStreams.createReadStream(filePath);
      stream.on('error', reject);
      stream.on('data', chunk => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
    });
  }

  async rebuildNarration(productionId, scenes, fallbackAudioPath, fingerprint, assertLease = async () => {}, attemptId = crypto.randomUUID()) {
    await assertLease();
    const hasSceneAudio = scenes.some(scene => scene.audioPath && scene.narrationStatus === 'current');
    const allCurrentWithoutSegments = scenes.every(scene => scene.narrationStatus === 'current' && !scene.audioPath);
    if (!hasSceneAudio && allCurrentWithoutSegments) { await assertLease(); return fallbackAudioPath; }
    const outputPath = path.join(this.dataRoot, 'audio', `${productionId}_scene_mix_${fingerprint}_${attemptId}.m4a`);
    try {
      const stat = await fs.stat(outputPath);
      if (stat.isFile() && stat.size > 0) {
        const duration = await this.getMediaDuration(outputPath);
        if (Number.isFinite(duration) && duration > 0) {
          await assertLease();
          await this.runFFmpeg(['-v', 'error', '-i', outputPath, '-f', 'null', '-']);
          await assertLease();
          return outputPath;
        }
      }
    } catch (_error) {
      // Missing or corrupt cached narration mix is rebuilt below.
    }
    const tempPath = `${outputPath}.${crypto.randomUUID()}.writing.m4a`;
    const args = ['-y'];
    for (const scene of scenes) {
      if (scene.narrationStatus === 'intentional_silence') {
        args.push('-f', 'lavfi', '-t', Number(scene.duration).toFixed(2), '-i', 'anullsrc=r=48000:cl=mono');
      } else {
        args.push('-i', scene.audioPath);
      }
    }
    const filters = scenes.map((scene, index) => `[${index}:a]aresample=48000,apad,atrim=duration=${Number(scene.duration).toFixed(2)},asetpts=PTS-STARTPTS[a${index}]`);
    filters.push(`${scenes.map((_, index) => `[a${index}]`).join('')}concat=n=${scenes.length}:v=0:a=1[aout]`);
    args.push('-filter_complex', filters.join(';'), '-map', '[aout]', '-c:a', 'aac', tempPath);
    try {
      await this.runFFmpeg(args, { assertLease });
      const stat = await fs.stat(tempPath);
      if (!stat.isFile() || stat.size <= 0) throw new Error('Narration mix output is empty');
      const duration = await this.getMediaDuration(tempPath);
      if (!Number.isFinite(duration) || duration <= 0) throw new Error('Narration mix output has invalid duration');
      await this.runFFmpeg(['-v', 'error', '-i', tempPath, '-f', 'null', '-']);
      // The FFmpeg render may outlive the lease; verify ownership immediately before publishing this immutable attempt file.
      await assertLease();
      await replaceFileWithRollback(tempPath, outputPath, undefined, assertLease);
      return outputPath;
    } catch (error) {
      if (isLeaseFailure(error)) throw error;
      await assertLease();
      await fs.unlink(tempPath).catch(() => {});
      throw error;
    }
  }

  buildSRT(scenes) {
    const time = seconds => {
      const ms = Math.max(0, Math.round(seconds * 1000));
      const hours = Math.floor(ms / 3600000);
      const minutes = Math.floor((ms % 3600000) / 60000);
      const secs = Math.floor((ms % 60000) / 1000);
      const millis = ms % 1000;
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
    };
    let cursor = 0;
    let index = 1;
    const blocks = [];
    for (const scene of scenes) {
      const words = scene.scriptText.trim().split(/\s+/).filter(Boolean);
      const groups = [];
      for (let offset = 0; offset < words.length; offset += 8) groups.push(words.slice(offset, offset + 8).join(' '));
      const duration = Number(scene.duration);
      const perGroup = groups.length ? duration / groups.length : duration;
      for (const group of groups) {
        blocks.push(`${index++}\n${time(cursor)} --> ${time(cursor + perGroup)}\n${group}`);
        cursor += perGroup;
      }
      if (!groups.length) cursor += duration;
    }
    return blocks.join('\n\n') + (blocks.length ? '\n' : '');
  }

  decorateScene(scene, productionId) {
    return {
      ...scene,
      assetUrl: scene.assetPath ? `/api/content/${encodeURIComponent(productionId)}/scenes/${encodeURIComponent(scene.id)}/asset?v=${scene.revision}` : null
    };
  }

  text(value, limit, label) {
    const output = String(value || '').trim();
    if (!output) throw this.error(`${label} is required`, 400);
    if (output.length > limit) throw this.error(`${label} must be ${limit.toLocaleString()} characters or less`, 400);
    return output;
  }

  array(value) {
    return Array.isArray(value) ? value.map(item => String(item)) : [];
  }

  async isUsableSceneAsset(scene) {
    if (!scene?.assetPath) return false;
    try {
      const stat = await fs.stat(scene.assetPath);
      if (!stat.isFile() || stat.size <= 0) return false;
      if (scene.assetType === 'image') {
        if (!IMAGE_EXTENSIONS.has(path.extname(scene.assetPath).toLowerCase())) return false;
        const metadata = await sharp(scene.assetPath, { failOn: 'error' }).metadata();
        const extension = path.extname(scene.assetPath).toLowerCase();
        const expectedFormat = extension === '.jpg' || extension === '.jpeg' ? 'jpeg' : extension.slice(1);
        return Boolean(metadata.width && metadata.height && metadata.format === expectedFormat);
      }
      if (scene.assetType === 'video') {
        if (!VIDEO_EXTENSIONS.has(path.extname(scene.assetPath).toLowerCase())) return false;
        if (typeof this.mediaGeneration?.isValidVideo === 'function') {
          return Boolean(await this.mediaGeneration.isValidVideo(scene.assetPath));
        }
        if (typeof this.videoGenerator?.validateRenderedVideo === 'function') {
          await this.videoGenerator.validateRenderedVideo(scene.assetPath);
          return true;
        }
        return false;
      }
      return false;
    } catch (_error) {
      return false;
    }
  }

  async isUsableNarrationSegment(scene) {
    if (!scene?.audioPath || scene.narrationStatus !== 'current') return false;
    try {
      return Boolean(await this.videoGenerator?.isUsableAudioFile?.(scene.audioPath));
    } catch (_error) {
      return false;
    }
  }

  async pathExists(filePath) {
    try {
      const stat = await fs.stat(filePath);
      return stat.isFile() && stat.size > 0;
    } catch (_error) {
      return false;
    }
  }

  error(message, status = 400, code, details) {
    const error = new Error(message);
    error.status = status;
    if (code) error.code = code;
    if (details) error.details = details;
    return error;
  }
}

module.exports = { SceneRepairService, buildInitialSceneManifest, scriptScenes, replaceFileWithRollback };
