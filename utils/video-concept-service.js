const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const { getAudioInfo } = require('./ffmpeg');
const { validateMusicRights } = require('./audio-mixer');

const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
const DEFAULT_OLLAMA_MODEL = 'qwen3.5:4b';

function extractJson(value) {
  const source = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(source); } catch (_) {
    const start = source.indexOf('{');
    const end = source.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('Ollama returned invalid concept JSON');
    return JSON.parse(source.slice(start, end + 1));
  }
}

function validateConcept(concept) {
  const required = ['name', 'premise', 'audience', 'emotionalObjective', 'storyArc', 'visualDirection', 'audioDirection', 'subtitleDirection', 'scenePlan'];
  for (const key of required) {
    if (concept?.[key] === undefined || concept?.[key] === null || concept?.[key] === '') throw new Error('Concept is missing required field: ' + key);
  }
  if (!Array.isArray(concept.scenePlan) || concept.scenePlan.length < 2) throw new Error('Concept scenePlan must contain at least two scenes');
  return concept;
}

class VideoConceptService {
  constructor(db, options = {}) {
    this.db = db;
    this.ollamaUrl = String(options.ollamaUrl || process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_URL).replace(/\/$/, '');
    this.model = options.model || process.env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL;
    this.timeoutMs = Number(options.timeoutMs || process.env.OLLAMA_TIMEOUT_MS || 120000);
    this.fetch = options.fetch || globalThis.fetch;
    this.audioDirectory = options.audioDirectory || path.join(__dirname, '..', 'data', 'audio', 'music');
    this.getAudioInfo = options.getAudioInfo || getAudioInfo;
  }

  async requestOllama(prompt, images = []) {
    if (typeof this.fetch !== 'function') throw new Error('Node.js 18 or newer is required for local Ollama requests');
    let response;
    try {
      response = await this.fetch(this.ollamaUrl + '/api/chat', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: prompt, ...(images.length ? { images } : {}) }],
          stream: false, format: 'json', options: { temperature: 0.45 }
        }),
        signal: globalThis.AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      throw new Error('Local Ollama is unavailable at ' + this.ollamaUrl + '. Start Ollama and ensure ' + this.model + ' is installed. No cloud or paid fallback was attempted. Cause: ' + error.message);
    }
    if (!response.ok) throw new Error('Local Ollama request failed: HTTP ' + response.status + '. No cloud or paid fallback was attempted.');
    const payload = await response.json();
    const content = payload?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('Local Ollama returned an empty concept. No cloud or paid fallback was attempted.');
    return content;
  }

  buildPrompt(input) {
    const profile = input.profile || {};
    const channel = {
      channelName: profile.channel_name || profile.channelName || '', goal: profile.goal || '',
      targetAudience: profile.target_audience || profile.targetAudience || '',
      brandVoice: profile.brand_voice || profile.brandVoice || '',
      defaultStyle: profile.default_style || profile.defaultStyle || '',
      visualStyle: profile.visual_style || profile.visualStyle || '',
      callToAction: profile.call_to_action || profile.callToAction || '',
      bannedTopics: profile.banned_topics || profile.bannedTopics || []
    };
    const schema = { name: 'short memorable concept title', premise: 'original one-paragraph premise', audience: 'specific intended audience', emotionalObjective: 'what viewers should feel or understand', storyArc: ['hook', 'setup', 'development', 'payoff', 'ending'], visualDirection: { style: '...', palette: '...', composition: '...', backgrounds: '...' }, audioDirection: { narration: '...', pacing: '...', music: 'mood only; do not copy a track', musicAsset: null }, subtitleDirection: { typography: '...', placement: '...', animation: '...' }, transitions: 'editing rhythm and transitions', originalityNotes: ['how this differs from source references or common templates'], rightsNotes: ['use original, licensed, public-domain or permission-cleared assets only'], scenePlan: [{ scene: 1, purpose: '...', visual: '...', narrationIntent: '...', durationSeconds: 8 }, { scene: 2, purpose: '...', visual: '...', narrationIntent: '...', durationSeconds: 8 }] };
    if (input.previousConcept) return 'You are a creative director. Revise the existing concept using user feedback. Preserve every element not explicitly requested to change. Never copy another creator\'s footage, audio, script, subtitles or branding. Return ONLY valid JSON matching this schema: ' + JSON.stringify(schema) + '\nCHANNEL PROFILE:\n' + JSON.stringify(channel) + '\nTOPIC: ' + input.topic + '\nUSER DIRECTION: ' + (input.direction || '') + '\nREVISION FEEDBACK: ' + (input.feedback || '') + '\nCURRENT CONCEPT:\n' + JSON.stringify(input.previousConcept);
    return 'You are a creative director for an original YouTube channel. Propose a distinctive video concept tailored to the channel and topic; avoid generic templates. Never copy another creator\'s footage, audio, script, subtitles or branding. References may inform style only unless reuse rights are explicitly confirmed. Return ONLY valid JSON matching this schema: ' + JSON.stringify(schema) + '\nCHANNEL PROFILE:\n' + JSON.stringify(channel) + '\nTOPIC: ' + input.topic + '\nUSER CREATIVE DIRECTION: ' + (input.direction || 'Independently propose the strongest original concept.') + '\nReference notes (style analysis only): ' + (input.referenceNotes || 'None');
  }

  async analyzeReferenceVideo(referenceId) {
    const reference = await this.db.getReferenceVideo(referenceId);
    if (!reference) throw new Error('Reference video not found');
    if (!Array.isArray(reference.framePaths) || !reference.framePaths.length) {
      throw new Error('Reference video has no extracted preview frames');
    }
    const images = await Promise.all(reference.framePaths.slice(0, 6).map(async framePath =>
      (await fs.readFile(framePath)).toString('base64')
    ));
    const prompt = [
      'Analyze the supplied sampled frames from one user-provided reference video.',
      'Return ONLY valid JSON. Do not identify people, infer private traits, or reproduce protected creative expression.',
      'Extract high-level style guidance only: visual style, palette, composition, camera language, editing rhythm, subtitle treatment, and general audio mood if inferable from the visuals.',
      'Do not transcribe or recreate dialogue, logos, exact scene content, characters, or distinctive protected designs.',
      'Schema:',
      JSON.stringify({
        visualStyle: 'short description',
        colorPalette: 'colors and contrast',
        composition: 'framing and layout',
        cameraLanguage: 'shot types and camera movement',
        editingRhythm: 'pacing inferred from sampled frames only; state uncertainty',
        subtitleTreatment: 'placement and visual treatment, if visible',
        audioMood: 'visual inference only; state not directly observed',
        observations: ['grounded visible observations'],
        limitations: ['what cannot be inferred from still frames']
      }),
      `Reference file: ${reference.originalName}. Duration: ${reference.durationSeconds} seconds. Frames are sampled across the clip, not continuous footage.`
    ].join('\n');
    const analysis = extractJson(await this.requestOllama(prompt, images));
    const required = ['visualStyle', 'colorPalette', 'composition', 'cameraLanguage', 'editingRhythm', 'subtitleTreatment', 'audioMood', 'observations', 'limitations'];
    for (const key of required) {
      if (analysis?.[key] === undefined || analysis?.[key] === null) {
        throw new Error('Reference analysis is missing field: ' + key);
      }
    }
    const updated = await this.db.updateReferenceVideoAnalysis(referenceId, analysis, 'complete');
    return updated;
  }

  async propose(input) {
    const topic = String(input.topic || '').trim().slice(0, 300);
    if (!topic) throw new Error('A topic is required to propose a video concept');
    let referenceNotes = String(input.referenceNotes || '').trim().slice(0, 3000);
    let referenceContext = null;
    if (input.referenceVideoId) {
      let reference = await this.db.getReferenceVideo(input.referenceVideoId);
      if (!reference) throw new Error('Reference video not found');
      if (reference.analysisStatus !== 'complete' || !reference.analysis) {
        reference = await this.analyzeReferenceVideo(reference.id);
      }
      referenceContext = {
        id: reference.id,
        originalName: reference.originalName,
        analysis: reference.analysis
      };
      referenceNotes = [referenceNotes, 'LOCAL REFERENCE VIDEO STYLE ANALYSIS (STYLE ONLY):', JSON.stringify(reference.analysis)].filter(Boolean).join('\n');
    }
    const concept = validateConcept(extractJson(await this.requestOllama(this.buildPrompt({ topic, profile: input.profile, direction: input.direction, referenceNotes }))));
    if (referenceContext) concept.referenceContext = referenceContext;
    const record = { id: crypto.randomUUID(), topic, concept, status: 'pending', revisionOf: null, feedback: null };
    await this.db.saveVideoConcept(record);
    return record;
  }

  async get(conceptId) {
    return this.db.getVideoConcept(conceptId);
  }

  async revise(input) {
    const current = await this.db.getVideoConcept(input.conceptId);
    if (!current) throw new Error('Video concept not found');
    if (current.status === 'approved') throw new Error('Approved concepts are immutable. Create a new concept instead.');
    const feedback = String(input.feedback || '').trim().slice(0, 4000);
    const direction = String(input.direction || '').trim();
    if (!feedback && !direction) throw new Error('Describe what should change before requesting a revision');
    const profile = await this.db.getChannelProfile();
    const concept = validateConcept(extractJson(await this.requestOllama(this.buildPrompt({ topic: current.topic, profile, direction, previousConcept: current.concept, feedback }))));
    if (current.concept?.referenceContext) concept.referenceContext = current.concept.referenceContext;
    const record = { id: crypto.randomUUID(), topic: current.topic, concept, status: 'pending', revisionOf: current.id, feedback: feedback || direction };
    await this.db.saveVideoConcept(record);
    return record;
  }

  async attachMusicAsset(conceptId, audioBuffer, metadata = {}) {
    const current = await this.db.getVideoConcept(conceptId);
    if (!current) throw new Error('Video concept not found');
    if (current.status !== 'pending') throw new Error('Music must be attached before concept approval. Approved concepts are immutable.');
    if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) throw new Error('A non-empty audio file is required');
    if (audioBuffer.length > 50 * 1024 * 1024) throw new Error('Background music files must be 50 MB or smaller');

    const mimeTypes = {
      'audio/mpeg': '.mp3',
      'audio/mp3': '.mp3',
      'audio/wav': '.wav',
      'audio/x-wav': '.wav',
      'audio/wave': '.wav',
      'audio/mp4': '.m4a',
      'audio/x-m4a': '.m4a',
      'audio/aac': '.aac',
      'audio/ogg': '.ogg',
      'audio/flac': '.flac',
      'audio/x-flac': '.flac',
      'audio/webm': '.webm'
    };
    const mimeType = String(metadata.mimeType || '').toLowerCase().split(';')[0].trim();
    const extension = mimeTypes[mimeType];
    if (!extension) throw new Error('Unsupported audio format. Use MP3, WAV, M4A, AAC, OGG, FLAC or WebM audio.');

    const musicAsset = {
      enabled: true,
      title: String(metadata.title || '').trim().slice(0, 200) || null,
      creator: String(metadata.creator || '').trim().slice(0, 200) || null,
      licenseType: String(metadata.licenseType || ''),
      rightsConfirmed: metadata.rightsConfirmed === true,
      attribution: String(metadata.attribution || '').trim().slice(0, 1000) || null,
      licenseName: String(metadata.licenseName || '').trim().slice(0, 200) || null,
      licenseUrl: String(metadata.licenseUrl || '').trim().slice(0, 1000) || null,
      sourceUrl: String(metadata.sourceUrl || '').trim().slice(0, 1000) || null,
      volume: Number(metadata.volume ?? 0.18),
      loop: metadata.loop !== false,
      fadeInSeconds: Number(metadata.fadeInSeconds ?? 2),
      fadeOutSeconds: Number(metadata.fadeOutSeconds ?? 3)
    };
    validateMusicRights(musicAsset);
    if (!Number.isFinite(musicAsset.volume) || musicAsset.volume < 0.01 || musicAsset.volume > 0.5) {
      throw new Error('Background music volume must be between 0.01 and 0.5');
    }
    if (![musicAsset.fadeInSeconds, musicAsset.fadeOutSeconds].every(value => Number.isFinite(value) && value >= 0 && value <= 30)) {
      throw new Error('Music fade durations must be between 0 and 30 seconds');
    }

    await fs.mkdir(this.audioDirectory, { recursive: true });
    const safeConceptId = String(conceptId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    const filePath = path.join(this.audioDirectory, `${safeConceptId}_${crypto.randomUUID()}${extension}`);
    await fs.writeFile(filePath, audioBuffer, { flag: 'wx' });
    try {
      const audioInfo = await this.getAudioInfo(filePath);
      musicAsset.path = filePath;
      musicAsset.mimeType = mimeType;
      musicAsset.fileSize = audioBuffer.length;
      musicAsset.trackDuration = audioInfo.duration;
      const concept = {
        ...current.concept,
        audioDirection: {
          ...(current.concept.audioDirection || {}),
          musicAsset
        }
      };
      const updated = await this.db.updateVideoConcept(conceptId, concept);
      if (!updated) throw new Error('Video concept not found');
      return updated;
    } catch (error) {
      await fs.rm(filePath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async approve(conceptId) {
    const current = await this.db.getVideoConcept(conceptId);
    if (!current) throw new Error('Video concept not found');
    return this.db.approveVideoConcept(conceptId);
  }
}

module.exports = { VideoConceptService, extractJson, validateConcept, DEFAULT_OLLAMA_MODEL };