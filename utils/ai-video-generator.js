const OpenAI = require('openai');
const Replicate = require('replicate');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const createReadStream = require('fs').createReadStream;
const { pipeline } = require('stream/promises');
const axios = require('axios');
const sharp = require('sharp');
const { Logger } = require('./logger');
const { runFFmpeg, getMediaDuration, checkFFmpeg, ffmpegInstallHint } = require('./ffmpeg');
const { MediaGenerationService } = require('./media-generation-service');
const { CineCodeRenderer } = require('./cinecode-renderer');

async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

const OPENAI_IMAGE_MODEL = 'gpt-image-2';

function isLeaseFailure(error) {
  const code = String(error?.code || '').toUpperCase();
  return code.includes('LEASE') || code.includes('LOCK_LOST') || code.includes('LOCK_UNVERIFIED');
}

async function removeAttemptFiles(paths = []) {
  await Promise.all([...new Set(paths.filter(value => typeof value === 'string' && value))]
    .map(filePath => fs.rm(filePath, { force: true, recursive: true }).catch(() => {})));
}

function getVideoAttemptSidecarPaths(outputPath) {
  const resolved = path.resolve(outputPath);
  const extension = path.extname(resolved);
  const stem = extension ? resolved.slice(0, -extension.length) : resolved;
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

// Turns an image provider SDK error into one readable line that leads with the
// fix when the cause is recognisable. @google/genai puts the raw JSON error
// body in error.message, which is unreadable on a console.
function describeImageProviderError(provider, model, error) {
  const raw = String(error?.message || error || 'Unknown error');
  let status = Number(error?.status) || null;
  let code = String(error?.code || '');
  let detail = raw;
  try {
    const body = JSON.parse(raw.slice(raw.indexOf('{')));
    if (body?.error) {
      status = status || Number(body.error.code) || null;
      code = body.error.status || code;
      detail = body.error.message || raw;
    }
  } catch (_error) { /* not a JSON error body */ }

  const text = `${code} ${detail}`;
  let fix = null;
  if (provider === 'Gemini') {
    if (/limit:\s*0\b/i.test(text) || (status === 429 && /free.?tier/i.test(text))) {
      fix = `this key has no quota for ${model}. Gemini image models are not on the free tier: turn on billing for the Google Cloud project that owns this API key (AI Studio → API keys → Set up billing). A paid account does not help if the key belongs to a different project.`;
    } else if (status === 429 || /RESOURCE_EXHAUSTED/i.test(code)) {
      fix = 'Gemini rate-limited this key. Wait a minute and retry, or raise the project quota.';
    } else if (/API key not valid|API key expired|API_KEY_INVALID/i.test(text)) {
      fix = 'the Gemini API key was rejected. Create a new key in Google AI Studio and save it in Settings.';
    } else if (/location is not supported|user location/i.test(text)) {
      fix = 'Gemini image generation is not available in your region for this key.';
    } else if (status === 404 || /NOT_FOUND|not supported for generateContent/i.test(text)) {
      fix = `${model} is not available to this key. Set GEMINI_IMAGE_MODEL to an image model your key can use (for example gemini-3.1-flash-image).`;
    } else if (status === 403 || /PERMISSION_DENIED|SERVICE_DISABLED/i.test(text)) {
      fix = "this key's Google Cloud project cannot call the Gemini API. Enable the Generative Language API for that project, or create the key in Google AI Studio.";
    }
  } else if (provider === 'OpenAI') {
    if (status === 401 || /invalid_api_key|Incorrect API key/i.test(text)) {
      fix = 'the OpenAI API key was rejected. Check the key in Settings.';
    } else if (/insufficient_quota|billing/i.test(text)) {
      fix = 'the OpenAI account has no remaining credit. Add billing at platform.openai.com.';
    } else if (status === 403 && /verif/i.test(text)) {
      fix = `${model} requires a verified OpenAI organization (platform.openai.com → Settings → Organization → Verify).`;
    } else if (status === 429) {
      fix = 'OpenAI rate-limited this key. Wait a minute and retry.';
    }
  }

  const label = [status, code && code !== String(status) ? code : null].filter(Boolean).join(' ');
  const summary = `${provider} image generation (${model}) failed${label ? ` [${label}]` : ''}.`;
  const shortDetail = detail.replace(/\s+/g, ' ').trim().slice(0, 220);
  return fix ? `${summary} Fix: ${fix} Details: ${shortDetail}` : `${summary} ${shortDetail}`;
}

class AIVideoGenerator {
  constructor(credentials, options = {}) {
    this.logger = new Logger('AIVideoGenerator');
    const resolvedCredentials = credentials?.credentials || credentials || {};
    this.db = options.db || null;
    this.getMediaDuration = options.getMediaDuration || getMediaDuration;
    this.runFFmpeg = options.runFFmpeg || runFFmpeg;
    this.lastVideoResult = null;
    this.lastNarrationResult = null;
    
    // Initialize AI services with graceful fallback
    const openaiKey = resolvedCredentials.openai?.apiKey || process.env.OPENAI_API_KEY;
    const replicateKey = resolvedCredentials.replicate?.apiKey || process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY;
    
    if (openaiKey) {
      this.openai = new OpenAI({ apiKey: openaiKey });
      this.logger.info('OpenAI service initialized');
    } else {
      this.logger.warn('OpenAI API key not found - AI features will be simulated');
    }
    
    if (replicateKey) {
      this.replicate = new Replicate({ auth: replicateKey });
      this.logger.info('Replicate service initialized');
    } else {
      this.logger.warn('Replicate API key not found - advanced video generation unavailable');
    }

    // Gemini media generation (images + native TTS) — free-tier alternative to OpenAI
    const geminiKey = resolvedCredentials.gemini?.apiKey || process.env.GEMINI_API_KEY;
    if (geminiKey) {
      try {
        const { GoogleGenAI } = require('@google/genai');
        this.gemini = new GoogleGenAI({ apiKey: geminiKey });
        this.logger.info('Gemini media service initialized (images + TTS)');
      } catch (error) {
        this.logger.warn('Failed to initialize Gemini media service:', error.message);
      }
    }
    
    // ElevenLabs configuration
    this.elevenLabsApiKey = resolvedCredentials.elevenLabs?.apiKey || process.env.ELEVENLABS_API_KEY;
    this.elevenLabsVoiceId = resolvedCredentials.elevenLabs?.voiceId || process.env.ELEVENLABS_VOICE_ID;
    this.elevenLabsModel = process.env.ELEVENLABS_TTS_MODEL || 'eleven_v3';
    
    // Azure Speech configuration
    this.azureSpeechKey = resolvedCredentials.azure?.speechKey || process.env.AZURE_SPEECH_KEY;
    this.azureSpeechRegion = resolvedCredentials.azure?.speechRegion || process.env.AZURE_SPEECH_REGION;
    this.mediaGeneration = options.mediaGeneration || (this.db
      ? new MediaGenerationService(this.db, resolvedCredentials, { logger: this.logger })
      : null);
    this.cineCodeRenderer = options.cineCodeRenderer || new CineCodeRenderer({ logger: this.logger });
  }

  async generateTTSAudio(text, outputPath, options = {}) {
    this.logger.info('Generating TTS audio...');
    this.lastNarrationResult = null;
    let provider = 'simulation';
    let model = null;
    const direction = options.direction && typeof options.direction === 'object' ? options.direction : {};
    const hasVoiceDirection = Boolean(direction.narration || direction.pacing);
    let directionApplication = {
      appliedFields: [],
      unsupportedFields: ['music'],
      note: 'The selected TTS provider does not expose a supported voice-direction control.'
    };

    try {
      let generatedPath;
      if (this.elevenLabsApiKey && this.elevenLabsVoiceId) {
        provider = 'elevenlabs';
        model = this.elevenLabsModel;
        generatedPath = await this.generateElevenLabsTTS(text, outputPath, direction);
        directionApplication = hasVoiceDirection
          ? { appliedFields: ['narration', 'pacing'], unsupportedFields: ['music'], method: 'ElevenLabs voice_settings mapped from approved direction' }
          : { appliedFields: [], unsupportedFields: ['music'], note: 'No narration or pacing direction was supplied.' };
      } else if (this.openai) {
        provider = 'openai';
        model = 'gpt-4o-mini-tts';
        generatedPath = await this.generateOpenAITTS(text, outputPath, direction);
        directionApplication = hasVoiceDirection
          ? { appliedFields: ['narration', 'pacing'], unsupportedFields: ['music'], method: 'OpenAI TTS instructions' }
          : { appliedFields: [], unsupportedFields: ['music'], note: 'No narration or pacing direction was supplied.' };
      } else if (this.gemini) {
        provider = 'gemini';
        model = process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-tts';
        generatedPath = await this.generateGeminiTTS(text, outputPath);
        directionApplication = {
          appliedFields: [],
          unsupportedFields: ['narration', 'pacing', 'music'],
          note: 'Gemini TTS currently uses the configured voice only; approved delivery direction is retained but not applied.'
        };
      } else {
        generatedPath = await this.simulateTTSGeneration(text, outputPath);
        directionApplication = {
          appliedFields: [],
          unsupportedFields: ['narration', 'pacing', 'music'],
          note: 'Simulation does not apply audio direction.'
        };
      }

      const usable = await this.isUsableAudioFile(generatedPath);
      this.lastNarrationResult = {
        status: usable ? 'ready' : 'unavailable',
        path: generatedPath,
        provider,
        model,
        externalTaskId: null,
        generatedAt: new Date().toISOString(),
        simulated: !usable,
        directionApplied: usable && directionApplication.appliedFields.length > 0,
        directionApplication,
        cost: { provider, amount: null, currency: null, invoiceRequired: provider !== 'simulation' }
      };
      return generatedPath;
    } catch (error) {
      this.lastNarrationResult = {
        status: 'failed', path: null, provider, model, externalTaskId: null,
        generatedAt: new Date().toISOString(), simulated: false, error: error.message,
        directionApplied: false, directionApplication,
        cost: { provider, amount: null, currency: null, invoiceRequired: provider !== 'simulation' }
      };
      this.logger.error('TTS generation failed:', error);
      throw error;
    }
  }

  async generateElevenLabsTTS(text, outputPath, direction = {}) {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${this.elevenLabsVoiceId}`;
    
    const data = {
      text: text,
      model_id: this.elevenLabsModel,
      voice_settings: {
        stability: /calm|gentle|soothing|measured|documentary|serious|sakin|yumuşak|belgesel|ölçülü|ciddi/i.test(`${direction.narration || ''} ${direction.pacing || ''}`) ? 0.7
          : /excited|energetic|dramatic|enthusiastic|playful|animated|heyecanlı|enerjik|dramatik|coşkulu|oyuncu|canlı/i.test(`${direction.narration || ''} ${direction.pacing || ''}`) ? 0.35 : 0.5,
        similarity_boost: 0.8,
        style: /excited|energetic|dramatic|enthusiastic|playful|animated|heyecanlı|enerjik|dramatik|coşkulu|oyuncu|canlı/i.test(`${direction.narration || ''} ${direction.pacing || ''}`) ? 0.55 : 0.15,
        use_speaker_boost: true
      }
    };

    const response = await axios({
      method: 'POST',
      url: url,
      data: data,
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': this.elevenLabsApiKey
      },
      responseType: 'stream'
    });

    const writer = require('fs').createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        this.logger.info('ElevenLabs TTS generation complete');
        resolve(outputPath);
      });
      writer.on('error', reject);
    });
  }

  async generateOpenAITTS(text, outputPath, direction = {}) {
    const voiceDirection = [direction.narration, direction.pacing].filter(Boolean).join('. ');
    const response = await this.openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "coral",
      input: text,
      speed: 1.0,
      ...(voiceDirection ? { instructions: `Apply this delivery direction without speaking it aloud: ${voiceDirection}` } : {})
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(outputPath, buffer);

    this.logger.info('OpenAI TTS generation complete');
    return outputPath;
  }

  async generateGeminiTTS(text, outputPath) {
    const model = process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-tts';
    const voiceName = process.env.GEMINI_TTS_VOICE || 'Kore';

    const response = await this.gemini.models.generateContent({
      model,
      contents: [{ parts: [{ text }] }],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName }
          }
        }
      }
    });

    const audioData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!audioData) {
      throw new Error('Gemini TTS returned no audio data');
    }

    // Gemini returns raw PCM (24kHz, mono, 16-bit); encode to the requested container via FFmpeg
    const pcmPath = outputPath + '.pcm';
    try {
      await fs.writeFile(pcmPath, Buffer.from(audioData, 'base64'));
      await this.runFFmpeg(['-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', pcmPath, outputPath]);
    } finally {
      await fs.unlink(pcmPath).catch(() => {});
    }

    this.logger.info('Gemini TTS generation complete');
    return outputPath;
  }

  async generateVisualAssets(prompt, style = "ethereal", count = 1) {
    this.logger.info(`Generating ${count} visual assets with style: ${style}`);
    const attemptPaths = [];

    try {
      if (!this.openai && !this.gemini) {
        return await this.simulateVisualAssets(prompt, style, count);
      }

      const enhancedPrompt = this.enhanceVisualPrompt(prompt, style);

      for (let i = 0; i < count; i++) {
        const imagePath = path.join(__dirname, '..', 'data', 'assets', `visual_${Date.now()}_${crypto.randomUUID()}_${i}.png`);
        attemptPaths.push(imagePath);
        await this.generateImage(enhancedPrompt, imagePath);
      }

      this.logger.info(`Generated ${attemptPaths.length} visual assets`);
      return attemptPaths;
    } catch (error) {
      for (const imagePath of attemptPaths) await fs.unlink(imagePath).catch(() => {});
      this.logger.error('Visual asset generation failed:', error);
      return await this.simulateVisualAssets(prompt, style, count);
    }
  }

  async generateImage(prompt, imagePath) {
    await fs.mkdir(path.dirname(imagePath), { recursive: true });

    const providers = [];
    if (this.openai) {
      providers.push({
        name: 'OpenAI',
        model: OPENAI_IMAGE_MODEL,
        run: outputPath => this.generateOpenAIImage(prompt, outputPath)
      });
    }
    if (this.gemini) {
      providers.push({
        name: 'Gemini',
        model: this.geminiImageModel(),
        run: outputPath => this.generateGeminiImage(prompt, outputPath)
      });
    }
    if (!providers.length) {
      throw new Error('No image generation provider configured');
    }

    // Isolate each provider attempt so a partial response can never corrupt
    // another provider's output or become visible as a completed image.
    const extension = path.extname(imagePath) || '.png';
    const basename = path.basename(imagePath, path.extname(imagePath));
    const failures = [];
    for (const [index, provider] of providers.entries()) {
      const attemptPath = path.join(
        path.dirname(imagePath),
        '.' + basename + '.' + crypto.randomUUID() + '.' + provider.name.toLowerCase() + extension
      );
      try {
        await provider.run(attemptPath);
        const metadata = await sharp(attemptPath, { failOn: 'error' }).metadata();
        if (!metadata.width || !metadata.height) {
          throw new Error(provider.name + ' returned an invalid image asset');
        }
        // Same-directory rename publishes only a complete, validated image.
        await fs.rename(attemptPath, imagePath);
        return imagePath;
      } catch (error) {
        await fs.unlink(attemptPath).catch(() => {});
        const description = describeImageProviderError(provider.name, provider.model, error);
        failures.push(description);
        if (index < providers.length - 1) {
          this.logger.warn(description + ' Trying ' + providers[index + 1].name + ' instead.');
        }
      }
    }

    const error = new Error(failures.join(' | '));
    error.providerFailures = failures;
    throw error;
  }

  geminiImageModel() {
    return process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';
  }

  async generateOpenAIImage(prompt, imagePath) {
    const response = await this.openai.images.generate({
      model: OPENAI_IMAGE_MODEL,
      prompt: prompt,
      n: 1,
      size: "1536x1024",
      quality: "high",
    });

    if (response.data[0].b64_json) {
      const buffer = Buffer.from(response.data[0].b64_json, 'base64');
      await fs.writeFile(imagePath, buffer);
    } else {
      await this.downloadImage(response.data[0].url, imagePath);
    }

    return imagePath;
  }

  async generateGeminiImage(prompt, imagePath) {
    const model = this.geminiImageModel();

    const response = await this.gemini.models.generateContent({
      model,
      contents: prompt,
      config: {
        responseModalities: ['IMAGE'],
        imageConfig: {
          aspectRatio: '16:9',
          imageSize: '1K'
        }
      }
    });

    const parts = response.candidates?.[0]?.content?.parts || [];
    const imageParts = parts.filter(part =>
      part.inlineData?.data && (!part.inlineData.mimeType || part.inlineData.mimeType.startsWith('image/'))
    );
    const renderedImages = imageParts.filter(part => part.thought !== true);
    const imagePart = (renderedImages.length ? renderedImages : imageParts).at(-1);
    if (!imagePart) {
      throw new Error('Gemini image generation returned no image data');
    }

    const imageBuffer = Buffer.from(imagePart.inlineData.data, 'base64');
    const metadata = await sharp(imageBuffer, { failOn: 'error' }).metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error('Gemini image generation returned an invalid image asset');
    }

    const extension = path.extname(imagePath).toLowerCase();
    const output = sharp(imageBuffer, { failOn: 'error' });
    if (extension === '.jpg' || extension === '.jpeg') {
      await output.jpeg({ quality: 92 }).toFile(imagePath);
    } else if (extension === '.webp') {
      await output.webp({ quality: 92 }).toFile(imagePath);
    } else {
      await output.png().toFile(imagePath);
    }
    return imagePath;
  }

  enhanceVisualPrompt(prompt, style) {
    const styleEnhancements = {
      ethereal: "ethereal, dreamy, mystical, soft lighting, floating particles, cosmic background",
      modern: "modern, clean, minimalist, professional, sleek design, contemporary",
      animated: "animated style, cartoon, vibrant colors, expressive, dynamic",
      cinematic: "cinematic lighting, dramatic, movie poster style, high contrast",
      abstract: "abstract art, geometric shapes, gradient colors, artistic composition"
    };

    const normalizedStyle = String(style || '').trim().toLowerCase();
    const enhancement = styleEnhancements[normalizedStyle] || String(style || '').trim() || styleEnhancements.ethereal;
    return `${prompt}, ${enhancement}, high quality, 16:9 aspect ratio, digital art`;
  }

  async downloadImage(url, outputPath) {
    const response = await axios({
      method: 'GET',
      url,
      responseType: 'stream'
    });

    try {
      await pipeline(response.data, require('fs').createWriteStream(outputPath));
      return outputPath;
    } catch (error) {
      await fs.unlink(outputPath).catch(() => {});
      throw error;
    }
  }

  async generateVideo(script, visualAssets, audioPath, outputPath, options = {}) {
    const assertLease = typeof options.assertLease === 'function' ? options.assertLease : async () => {};
    this.logger.info('Generating video from assets...');
    this.lastVideoResult = null;
    let selectedProvider = null;
    let providerOutputPaths = [];
    const attemptId = String(options.attemptId || crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]/g, '');

    try {
      await assertLease();
      const configuredSettings = this.mediaGeneration && options.productionId
        ? await this.mediaGeneration.settings()
        : null;
      await assertLease();
      selectedProvider = configuredSettings?.provider || null;

      if (selectedProvider === 'cinecode') {
        const realImages = await this.filterLocalImageAssets(visualAssets);
        await assertLease();
        if (!realImages.length) throw new Error('CineCode requires real image-generation assets. Configure an image provider; placeholder assets are not accepted.');
        const totalDuration = options.estimatedDuration || this.calculateScriptDuration(script);
        const rendered = await this.cineCodeRenderer.renderScenes({
          visualAssets: realImages,
          concept: options.approvedVideoConcept || {},
          totalDuration,
          outputDir: path.dirname(outputPath),
          outputPrefix: path.basename(outputPath, path.extname(outputPath)),
          resolution: configuredSettings.resolution,
          aspectRatio: configuredSettings.aspectRatio,
          assertLease
        });
        providerOutputPaths = rendered.clips.map(clip => clip.path);
        await assertLease();
        const produced = await this.generateHybridVideo(
          rendered.clips,
          realImages,
          audioPath,
          outputPath,
          rendered.totalDuration,
          { width: rendered.width, height: rendered.height },
          assertLease
        );
        await assertLease();
        this.lastVideoResult = {
          requestedProvider: 'cinecode',
          actualProvider: 'cinecode',
          model: rendered.model,
          mode: 'local-cinematic',
          generatedSeconds: rendered.totalDuration,
          resolution: rendered.resolution,
          colorGrade: rendered.colorGrade,
          tasks: [],
          scenes: rendered.clips.map(clip => ({
            index: clip.index, label: clip.label, prompt: clip.prompt, duration: clip.duration,
            path: clip.path, provider: clip.provider, model: clip.model
          }))
        };
        return produced;
      }

      if (this.mediaGeneration && options.productionId) {
        const generated = await this.mediaGeneration.generateClips({
          jobId: options.jobId || null,
          productionId: options.productionId,
          script,
          visualAssets,
          outputDir: path.dirname(outputPath),
          attemptId,
          assertLease
        });
        providerOutputPaths = generated.clips.map(clip => clip.path);
        await assertLease();
        if (generated.clips.length) {
          const produced = await this.generateHybridVideo(
            generated.clips,
            visualAssets,
            audioPath,
            outputPath,
            options.estimatedDuration || this.calculateScriptDuration(script),
            {},
            assertLease
          );
          await assertLease();
          this.lastVideoResult = {
            requestedProvider: generated.requestedProvider,
            actualProvider: generated.actualProvider,
            model: generated.model,
            mode: generated.settings.mode,
            generatedSeconds: generated.clips.reduce((total, clip) => total + clip.duration, 0),
            tasks: generated.clips.map(clip => ({ scene: clip.index, taskId: clip.taskId, provider: clip.provider, model: clip.model })),
            scenes: generated.clips.map(clip => ({
              index: clip.index, label: clip.label, prompt: clip.prompt, duration: clip.duration,
              path: clip.path, taskId: clip.taskId, provider: clip.provider, model: clip.model
            }))
          };
          return produced;
        }
      }

      await assertLease();
      const produced = await this.generateSlideshowVideo(script, visualAssets, audioPath, outputPath, assertLease);
      await assertLease();
      this.lastVideoResult = { requestedProvider: selectedProvider || 'slideshow', actualProvider: 'slideshow', model: 'local-ffmpeg', mode: 'slideshow', generatedSeconds: 0, tasks: [], scenes: [] };
      return produced;
    } catch (error) {
      if (isLeaseFailure(error)) {
        await removeAttemptFiles([
          ...getVideoAttemptSidecarPaths(outputPath),
          ...providerOutputPaths,
          ...providerOutputPaths.flatMap(filePath => [filePath + '.rendering.mp4', filePath + '.render.json', filePath + '.render.json.tmp'])
        ]);
        throw error;
      }

      try {
        await assertLease();
      } catch (leaseError) {
        await removeAttemptFiles([
          ...getVideoAttemptSidecarPaths(outputPath),
          ...providerOutputPaths,
          ...providerOutputPaths.flatMap(filePath => [filePath + '.rendering.mp4', filePath + '.render.json', filePath + '.render.json.tmp'])
        ]);
        throw leaseError;
      }

      const reason = error && error.message ? error.message : String(error);
      if (selectedProvider === 'cinecode') {
        this.lastVideoResult = {
          requestedProvider: 'cinecode',
          actualProvider: 'failed',
          model: 'local-ffmpeg-camera-motion',
          mode: 'failed',
          generatedSeconds: 0,
          fallbackReason: reason,
          tasks: [],
          scenes: []
        };
        this.logger.error(`CineCode rendering failed without fallback: ${reason}`, error);
        throw error;
      }
      this.logger.error(`Video provider generation failed; using the local slideshow: ${reason}`, error);
      try {
        await assertLease();
        const produced = await this.generateSlideshowVideo(script, visualAssets, audioPath, outputPath, assertLease);
        await assertLease();
        this.lastVideoResult = {
          requestedProvider: selectedProvider || 'configured-provider',
          actualProvider: 'slideshow', model: 'local-ffmpeg', mode: 'fallback', generatedSeconds: 0,
          fallbackReason: reason, tasks: [], scenes: []
        };
        return produced;
      } catch (fallbackError) {
        if (isLeaseFailure(fallbackError)) {
          await removeAttemptFiles([
            ...getVideoAttemptSidecarPaths(outputPath),
            ...providerOutputPaths,
            ...providerOutputPaths.flatMap(filePath => [filePath + '.rendering.mp4', filePath + '.render.json', filePath + '.render.json.tmp'])
          ]);
          throw fallbackError;
        }
        this.logger.error(`Local slideshow fallback failed: ${fallbackError.message}`, fallbackError);
        await assertLease();
        const produced = await this.simulateVideoGeneration(script, visualAssets, audioPath, outputPath, assertLease);
        await assertLease();
        this.lastVideoResult = {
          requestedProvider: selectedProvider || 'configured-provider', actualProvider: 'simulation', model: null,
          mode: 'simulation', generatedSeconds: 0, fallbackReason: `${reason}; ${fallbackError.message}`, tasks: [], scenes: []
        };
        return produced;
      }
    }
  }


  async generateHybridVideo(clips, visualAssets, audioPath, outputPath, totalDuration, renderOptions = {}, assertLease = async () => {}) {
    await assertLease();
    if (!(await checkFFmpeg())) throw new Error(ffmpegInstallHint());
    await assertLease();
    const validImages = await this.filterLocalImageAssets(visualAssets);
    await assertLease();
    const segments = clips.map(clip => ({ type: 'video', path: clip.path, duration: clip.duration }));
    const generatedDuration = segments.reduce((sum, item) => sum + item.duration, 0);
    const remaining = Math.max(0, this.parseDurationSeconds(totalDuration) - generatedDuration);
    if (remaining && validImages.length) {
      const perImage = Math.max(2, remaining / validImages.length);
      for (const imagePath of validImages) segments.push({ type: 'image', path: imagePath, duration: perImage });
    }
    if (!segments.length) throw new Error('No usable provider clips or still images were generated');

    const visualPath = outputPath.replace(/\.mp4$/i, '_hybrid_visual.mp4');
    const visualTempPath = visualPath.replace(/\.mp4$/i, '_rendering.mp4');
    const visualManifestPath = visualPath + '.render.json';
    const visualManifestTempPath = visualManifestPath + '.tmp';
    const finalTempPath = outputPath.replace(/\.mp4$/i, '_finalizing.mp4');
    const assemblyManifestPath = outputPath + '.assembly.json';
    const assemblyManifestTempPath = assemblyManifestPath + '.tmp';
    const sourceFingerprint = [];
    for (const segment of segments) {
      await assertLease();
      const stats = await fs.stat(segment.path);
      await assertLease();
      if (!stats.isFile() || stats.size <= 0) throw new Error(`Hybrid video source is missing or empty: ${segment.path}`);
      const sha256 = await hashFile(segment.path);
      await assertLease();
      sourceFingerprint.push({
        type: segment.type,
        path: path.resolve(segment.path),
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        sha256,
        duration: Number(segment.duration)
      });
    }
    const visualFingerprint = crypto.createHash('sha256').update(JSON.stringify({
      segments: sourceFingerprint,
      renderOptions: { width: renderOptions.width || 1920, height: renderOptions.height || 1080, fps: 30, codec: 'libx264', pixelFormat: 'yuv420p' }
    })).digest('hex');
    const audioSha256 = await hashFile(audioPath);
    await assertLease();
    const assemblyFingerprint = crypto.createHash('sha256').update(JSON.stringify({
      visualFingerprint,
      audioSha256,
      mux: { loopVideo: true, videoCodec: 'copy', audioCodec: 'aac', shortest: true }
    })).digest('hex');

    try {
      let visualCached = false;
      try {
        const [manifest, stats] = await Promise.all([
          fs.readFile(visualManifestPath, 'utf8').then(JSON.parse),
          fs.stat(visualPath)
        ]);
        await assertLease();
        if (manifest.fingerprint === visualFingerprint && stats.isFile() && stats.size > 0) {
          await this.validateRenderedVideo(visualPath, assertLease);
          await assertLease();
          visualCached = true;
          this.logger.info('Reusing completed hybrid visual timeline; audio mux will resume.');
        }
      } catch (cacheError) {
        if (isLeaseFailure(cacheError)) throw cacheError;
        visualCached = false;
      }

      if (!visualCached) {
        await assertLease();
        await fs.rm(visualTempPath, { force: true });
        await this.renderMediaTimeline(segments, visualTempPath, renderOptions, assertLease);
        await assertLease();
        await this.validateRenderedVideo(visualTempPath, assertLease);
        await assertLease();
        await fs.rm(visualPath, { force: true });
        await fs.rename(visualTempPath, visualPath);
        await assertLease();
        await fs.writeFile(visualManifestTempPath, JSON.stringify({
          version: 1,
          fingerprint: visualFingerprint,
          sources: sourceFingerprint,
          renderedAt: new Date().toISOString()
        }, null, 2));
        await assertLease();
        await fs.rm(visualManifestPath, { force: true });
        await fs.rename(visualManifestTempPath, visualManifestPath);
        await assertLease();
      }

      let finalCached = false;
      try {
        const [manifest, stats] = await Promise.all([
          fs.readFile(assemblyManifestPath, 'utf8').then(JSON.parse),
          fs.stat(outputPath)
        ]);
        await assertLease();
        if (manifest.fingerprint === assemblyFingerprint && stats.isFile() && stats.size > 0) {
          await this.validateRenderedVideo(outputPath, assertLease);
          await assertLease();
          finalCached = true;
          this.logger.info('Reusing completed hybrid video and audio mux.');
        }
      } catch (cacheError) {
        if (isLeaseFailure(cacheError)) throw cacheError;
        finalCached = false;
      }
      if (finalCached) {
        await assertLease();
        return outputPath;
      }

      await assertLease();
      await this.addAudioToVideo(visualPath, audioPath, finalTempPath, {
        loopVideo: true,
        assertLease
      });
      await assertLease();
      await this.validateRenderedVideo(finalTempPath, assertLease);
      await assertLease();
      await fs.rm(outputPath, { force: true });
      await fs.rename(finalTempPath, outputPath);
      await assertLease();
      await fs.writeFile(assemblyManifestTempPath, JSON.stringify({
        version: 1,
        fingerprint: assemblyFingerprint,
        visualFingerprint,
        audioSha256,
        assembledAt: new Date().toISOString()
      }, null, 2));
      await assertLease();
      await fs.rm(assemblyManifestPath, { force: true });
      await fs.rename(assemblyManifestTempPath, assemblyManifestPath);
      await assertLease();
      return outputPath;
    } finally {
      // A lease-loss caller removes the whole attempt through generateVideo().
      // These per-process temps are always safe to delete here.
      await removeAttemptFiles([visualTempPath, finalTempPath, visualManifestTempPath, assemblyManifestTempPath]);
    }
  }

  async validateRenderedVideo(filePath, assertLease = async () => {}) {
    await assertLease();
    const stats = await fs.stat(filePath).catch(() => null);
    await assertLease();
    if (!stats?.isFile() || stats.size <= 0) {
      throw new Error('FFmpeg did not produce a non-empty final video file');
    }
    const duration = await this.getMediaDuration(filePath);
    await assertLease();
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('FFmpeg final video has no valid media duration');
    }
    await assertLease();
    await this.runFFmpeg(['-v', 'error', '-i', filePath, '-f', 'null', '-']);
    await assertLease();
    return { path: filePath, size: stats.size, duration };
  }

  async renderMediaTimeline(segments, outputPath, renderOptions = {}, assertLease = async () => {}) {
    await assertLease();
    const width = Number.isInteger(renderOptions.width) && renderOptions.width > 0 ? renderOptions.width : 1920;
    const height = Number.isInteger(renderOptions.height) && renderOptions.height > 0 ? renderOptions.height : 1080;
    const args = ['-y'];
    for (const segment of segments) {
      await assertLease();
      const duration = Number(segment.duration).toFixed(2);
      if (segment.type === 'image') args.push('-loop', '1', '-t', duration, '-framerate', '30', '-i', segment.path);
      // Loop short clips to fill their slot, but bound the input: an unbounded
      // -stream_loop keeps FFmpeg decoding long after trim has what it needs.
      else args.push('-stream_loop', '-1', '-t', duration, '-i', segment.path);
    }
    const filters = segments.map((segment, index) =>
      `[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,fps=30,format=yuv420p,trim=duration=${Number(segment.duration).toFixed(2)},setpts=PTS-STARTPTS[v${index}]`
    );
    filters.push(`${segments.map((_, index) => `[v${index}]`).join('')}concat=n=${segments.length}:v=1:a=0[vout]`);
    args.push('-filter_complex', filters.join(';'), '-map', '[vout]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', outputPath);
    await assertLease();
    await runFFmpeg(args);
    await assertLease();
    return outputPath;
  }

  async filterLocalImageAssets(visualAssets = []) {
    const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);
    const images = [];
    for (const asset of visualAssets) {
      if (typeof asset !== 'string' || !imageExtensions.has(path.extname(asset).toLowerCase())) continue;
      try {
        await fs.access(asset);
        images.push(asset);
      } catch (_error) { /* ignore missing assets */ }
    }
    return images;
  }

  parseDurationSeconds(value) {
    if (Number.isFinite(Number(value))) return Math.max(0, Number(value));
    const parts = String(value || '').split(':').map(Number);
    if (parts.length === 2 && parts.every(Number.isFinite)) return Math.max(0, parts[0] * 60 + parts[1]);
    if (parts.length === 3 && parts.every(Number.isFinite)) return Math.max(0, parts[0] * 3600 + parts[1] * 60 + parts[2]);
    return 0;
  }

  async generateReplicateVideo(script, visualAssets, audioPath, outputPath) {
    const output = await this.replicate.run(
      "wan-video/wan-2.7-i2v",
      {
        input: {
          image: visualAssets[0],
          prompt: script.title || "smooth cinematic motion",
          duration: 5,
          resolution: "720p"
        }
      }
    );

    // Download the generated video
    if (output && output.length > 0) {
      await this.downloadVideo(output[0], outputPath);
      
      // Add audio track
      await this.addAudioToVideo(outputPath, audioPath, outputPath);
    }

    return outputPath;
  }

  async generateSlideshowVideo(script, visualAssets, audioPath, outputPath, assertLease = async () => {}) {
    await assertLease();
    this.logger.info('Creating slideshow video...');

    if (!(await checkFFmpeg())) throw new Error(ffmpegInstallHint());
    await assertLease();

    const { chromium } = require('playwright');
    const browser = await chromium.launch();
    const outputStem = path.basename(outputPath, path.extname(outputPath));
    const slidesDir = path.join(path.dirname(outputPath), `${outputStem}_slides`);
    const videoPath = outputPath.replace('.mp4', '_visual.mp4');

    try {
      await assertLease();
      const page = await browser.newPage();
      await page.setViewportSize({ width: 1920, height: 1080 });

      const imageAssets = await this.filterImageAssets(visualAssets);
      await assertLease();
      await page.setContent(this.createSlideshowHTML(script, imageAssets));
      await assertLease();

      await page.addStyleTag({ content: '* { transition: none !important; animation: none !important; }' });
      await page.waitForTimeout(1000);
      await assertLease();

      const slideCount = await page.evaluate(() => document.querySelectorAll('.slide').length);
      await fs.mkdir(slidesDir, { recursive: true });

      const stills = [];
      for (let i = 0; i < slideCount; i++) {
        await assertLease();
        await page.evaluate((index) => {
          document.querySelectorAll('.slide').forEach((slide, s) => {
            slide.classList.toggle('active', s === index);
          });
        }, i);

        const stillPath = path.join(slidesDir, `slide_${String(i).padStart(3, '0')}.png`);
        await page.screenshot({ path: stillPath });
        stills.push(stillPath);
        await assertLease();
      }

      const duration = await this.resolveSlideshowDuration(script, audioPath);
      await assertLease();
      await this.renderSlidesToVideo(stills, duration, videoPath, assertLease);
      await assertLease();
      await this.addAudioToVideo(videoPath, audioPath, outputPath, { assertLease });
      await assertLease();
      return outputPath;
    } catch (error) {
      await removeAttemptFiles([videoPath, outputPath + '.info']);
      throw error;
    } finally {
      await browser.close().catch(() => {});
      await this.cleanupDirectory(slidesDir);
    }
  }


  async resolveSlideshowDuration(script, audioPath) {
    try {
      return (await this.getMediaDuration(audioPath)) + 0.5;
    } catch (error) {
      this.logger.warn(`Could not read narration duration, falling back to word-count estimate: ${error.message}`);
      return this.calculateScriptDuration(script);
    }
  }

  async renderSlidesToVideo(stills, totalDuration, videoPath, assertLease = async () => {}) {
    await assertLease();
    if (stills.length === 0) throw new Error('No slides to render');

    const fade = 0.5;
    const overlapDuration = fade * Math.max(0, stills.length - 1);
    const perSlide = Math.max(2, (totalDuration + overlapDuration) / stills.length);

    const args = ['-y'];
    for (const still of stills) {
      await assertLease();
      args.push('-loop', '1', '-t', perSlide.toFixed(2), '-framerate', '30', '-i', still);
    }

    if (stills.length === 1) {
      args.push('-vf', 'format=yuv420p', '-c:v', 'libx264', videoPath);
    } else {
      const filters = [];
      let prev = '[0:v]';
      for (let i = 1; i < stills.length; i++) {
        const out = `[v${i}]`;
        const offset = (i * (perSlide - fade)).toFixed(2);
        filters.push(`${prev}[${i}:v]xfade=transition=fade:duration=${fade}:offset=${offset}${out}`);
        prev = out;
      }
      filters.push(`${prev}format=yuv420p[vfinal]`);
      args.push(
        '-filter_complex', filters.join(';'),
        '-map', '[vfinal]',
        '-c:v', 'libx264',
        '-r', '30',
        videoPath
      );
    }

    await assertLease();
    await runFFmpeg(args);
    await assertLease();
    return videoPath;
  }


  async filterImageAssets(visualAssets = []) {
    const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);
    const mimeTypes = {
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp'
    };
    const images = [];

    for (const asset of visualAssets) {
      if (typeof asset !== 'string' || !imageExtensions.has(path.extname(asset).toLowerCase())) {
        continue;
      }

      try {
        const imageBuffer = await fs.readFile(asset);
        const metadata = await sharp(imageBuffer, { failOn: 'error' }).metadata();
        const mimeType = mimeTypes[metadata.format];
        if (mimeType && metadata.width && metadata.height) {
          images.push(`data:${mimeType};base64,${imageBuffer.toString('base64')}`);
        }
      } catch (_error) {
        // Skip missing or invalid image files
      }
    }

    return images;
  }

  createSlideshowHTML(script, visualAssets) {
    return `
<!DOCTYPE html>
<html>
<head>
    <style>
        body {
            margin: 0;
            padding: 0;
            width: 1920px;
            height: 1080px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            font-family: 'Arial', sans-serif;
            overflow: hidden;
        }
        
        .slide {
            position: absolute;
            width: 100%;
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0;
            transition: opacity 2s ease-in-out;
        }
        
        .slide.active {
            opacity: 1;
        }
        
        .content {
            position: relative;
            z-index: 2;
            text-align: center;
            color: white;
            max-width: 80%;
        }
        
        h1 {
            font-size: 72px;
            margin-bottom: 30px;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.5);
        }
        
        h2 {
            font-size: 48px;
            margin-bottom: 20px;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.5);
        }
        
        p {
            font-size: 36px;
            line-height: 1.4;
            text-shadow: 1px 1px 2px rgba(0,0,0,0.5);
        }
        
        .background-image {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            object-fit: cover;
            z-index: 0;
        }

        /* Darkens the image just enough to keep the slide text readable */
        .scrim {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: linear-gradient(180deg, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.6) 100%);
            z-index: 1;
        }

        .particles {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
            z-index: -1;
        }
        
        .particle {
            position: absolute;
            background: rgba(255,255,255,0.8);
            border-radius: 50%;
            animation: float 6s ease-in-out infinite;
        }
        
        @keyframes float {
            0%, 100% { transform: translateY(0px); }
            50% { transform: translateY(-20px); }
        }
    </style>
</head>
<body>
    <div class="particles"></div>
    
    <!-- Title Slide -->
    <div class="slide active">
        ${visualAssets[0] ? `<img class="background-image" src="${visualAssets[0]}" /><div class="scrim"></div>` : ''}
        <div class="content">
            <h1>${script.title}</h1>
        </div>
    </div>

    ${this.generateContentSlides(script, visualAssets).join('')}

    <!-- Subscribe Slide -->
    <div class="slide">
        <div class="content">
            <h2>Thanks for watching</h2>
            <p>Subscribe for more videos like this</p>
        </div>
    </div>
    
    <script>
        // Create floating particles
        function createParticles() {
            const container = document.querySelector('.particles');
            for (let i = 0; i < 20; i++) {
                const particle = document.createElement('div');
                particle.className = 'particle';
                particle.style.left = Math.random() * 100 + '%';
                particle.style.top = Math.random() * 100 + '%';
                particle.style.width = (Math.random() * 4 + 2) + 'px';
                particle.style.height = particle.style.width;
                particle.style.animationDelay = Math.random() * 6 + 's';
                container.appendChild(particle);
            }
        }
        
        let currentSlide = 0;
        const slides = document.querySelectorAll('.slide');
        
        function advanceAnimation() {
            slides[currentSlide].classList.remove('active');
            currentSlide = (currentSlide + 1) % slides.length;
            slides[currentSlide].classList.add('active');
        }
        
        window.advanceAnimation = advanceAnimation;
        createParticles();
    </script>
</body>
</html>`;
  }

  generateContentSlides(script, visualAssets) {
    const slides = [];
    
    if (script.mainContent && script.mainContent.sections) {
      script.mainContent.sections.forEach((section, index) => {
        const assetIndex = Math.min(index + 1, visualAssets.length - 1);
        
        slides.push(`
        <div class="slide">
            ${visualAssets[assetIndex] ? `<img class="background-image" src="${visualAssets[assetIndex]}" /><div class="scrim"></div>` : ''}
            <div class="content">
                <h2>${section.title}</h2>
                ${this.formatSectionContent(section)}
            </div>
        </div>`);
      });
    }
    
    return slides;
  }

  formatSectionContent(section) {
    if (section.items && Array.isArray(section.items)) {
      return section.items.slice(0, 3).map(item => 
        `<p>${item.number}. ${item.title}</p>`
      ).join('');
    }
    
    if (section.steps && Array.isArray(section.steps)) {
      return section.steps.slice(0, 3).map(step => 
        `<p>${step.title}</p>`
      ).join('');
    }
    
    // Script writers store spoken lines as an array of strings
    if (Array.isArray(section.content)) {
      return section.content
        .filter(line => typeof line === 'string' && line.trim())
        .slice(0, 3)
        .map(line => `<p>${line.slice(0, 120)}${line.length > 120 ? '...' : ''}</p>`)
        .join('');
    }

    if (typeof section.content === 'string') {
      return `<p>${section.content.slice(0, 200)}${section.content.length > 200 ? '...' : ''}</p>`;
    }

    return '';
  }

  calculateScriptDuration(script) {
    // Estimate duration based on word count (average 150 words per minute)
    let totalWords = 0;
    
    if (script.hook) totalWords += script.hook.text.split(' ').length;
    if (script.introduction) {
      totalWords += (script.introduction.greeting || '').split(' ').length;
      totalWords += (script.introduction.topicIntro || '').split(' ').length;
    }
    
    if (script.mainContent && script.mainContent.sections) {
      script.mainContent.sections.forEach(section => {
        if (typeof section.content === 'string') {
          totalWords += section.content.split(' ').length;
        }
        if (section.items) {
          section.items.forEach(item => {
            totalWords += (item.title + ' ' + item.description).split(' ').length;
          });
        }
        if (section.steps) {
          section.steps.forEach(step => {
            totalWords += (step.title + ' ' + step.description).split(' ').length;
          });
        }
      });
    }
    
    if (script.conclusion) {
      totalWords += script.conclusion.finalThought.split(' ').length;
    }
    
    // Convert to duration (150 words per minute)
    return Math.max(30, Math.ceil((totalWords / 150) * 60));
  }

  async addAudioToVideo(videoPath, audioPath, outputPath, options = {}) {
    const assertLease = typeof options.assertLease === 'function' ? options.assertLease : async () => {};
    await assertLease();
    const hasRealAudio = await this.isUsableAudioFile(audioPath);
    await assertLease();

    if (!hasRealAudio) {
      if (options.allowSilent === true) {
        this.logger.warn('Creating an intentionally silent video from an operator-confirmed override.');
        if (videoPath !== outputPath) {
          await assertLease();
          await fs.copyFile(videoPath, outputPath);
          await assertLease();
        }
        return outputPath;
      }
      const error = new Error('Narration audio is required. Regenerate narration or explicitly confirm an intentional silent video.');
      error.code = 'NARRATION_REQUIRED';
      throw error;
    }

    const muxPath = outputPath === videoPath
      ? outputPath.replace(/\.mp4$/i, '_muxed.mp4')
      : outputPath;
    const videoInput = options.loopVideo ? ['-stream_loop', '-1', '-i', videoPath] : ['-i', videoPath];
    try {
      await assertLease();
      await runFFmpeg(['-y', ...videoInput, '-i', audioPath, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-shortest', muxPath]);
      await assertLease();
      if (muxPath !== outputPath) {
        await fs.rename(muxPath, outputPath);
        await assertLease();
      }
      this.logger.info('Audio added to video successfully');
      return outputPath;
    } catch (error) {
      await removeAttemptFiles([muxPath, outputPath === videoPath ? null : outputPath]);
      throw error;
    }
  }


  async isUsableAudioFile(audioPath) {
    if (typeof audioPath !== 'string' || audioPath.endsWith('.info')) {
      return false;
    }

    try {
      const stats = await fs.stat(audioPath);
      return stats.isFile() && stats.size > 0;
    } catch (error) {
      return false;
    }
  }

  async downloadVideo(url, outputPath) {
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream'
    });

    const writer = require('fs').createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  }

  async cleanupDirectory(dirPath) {
    try {
      const files = await fs.readdir(dirPath);
      for (const file of files) {
        await fs.unlink(path.join(dirPath, file));
      }
      await fs.rmdir(dirPath);
    } catch (error) {
      this.logger.warn('Cleanup failed:', error.message);
    }
  }

  async generateThumbnail(script, style = "ethereal") {
    this.logger.info('Generating custom thumbnail...');

    try {
      if (!this.openai && !this.gemini) {
        return await this.simulateThumbnailGeneration(script, style);
      }

      const prompt = `YouTube thumbnail for "${script.title}", ${style} style, eye-catching, high contrast text, professional design, clickable, engaging`;
      const thumbnailPath = path.join(__dirname, '..', 'uploads', 'thumbnails', `thumbnail_${Date.now()}.png`);

      await this.generateImage(prompt, thumbnailPath);
      const metadata = await sharp(thumbnailPath).metadata();

      return {
        path: thumbnailPath,
        dimensions: { width: metadata.width, height: metadata.height },
        fileSize: await this.getFileSize(thumbnailPath)
      };
    } catch (error) {
      this.logger.error('Thumbnail generation failed:', error);
      return await this.simulateThumbnailGeneration(script, style);
    }
  }

  async getFileSize(filePath) {
    const stats = await fs.stat(filePath);
    return stats.size;
  }

  // Simulation methods for when APIs are not available
  async simulateTTSGeneration(text, outputPath) {
    this.logger.info('Simulating TTS generation...');
    
    const infoPath = outputPath + '.info';
    await fs.writeFile(infoPath, JSON.stringify({
      message: 'AI TTS audio would be generated here',
      text: text.substring(0, 100) + '...',
      timestamp: new Date().toISOString()
    }, null, 2));
    
    return infoPath;
  }

  async simulateVisualAssets(prompt, style, count) {
    this.logger.info(`Simulating ${count} visual assets...`);
    
    const paths = [];
    for (let i = 0; i < count; i++) {
      const assetPath = path.join(__dirname, '..', 'data', 'assets', `visual_sim_${Date.now()}_${crypto.randomUUID()}_${i}.info`);
      
      await fs.writeFile(assetPath, JSON.stringify({
        message: 'AI visual asset would be generated here',
        prompt: prompt,
        style: style,
        timestamp: new Date().toISOString()
      }, null, 2));
      
      paths.push(assetPath);
    }
    
    return paths;
  }

  async simulateVideoGeneration(script, visualAssets, audioPath, outputPath, assertLease = async () => {}) {
    await assertLease();
    this.logger.info('Simulating video generation...');

    const infoPath = outputPath + '.info';
    try {
      await fs.writeFile(infoPath, JSON.stringify({
        message: 'AI video would be generated here',
        script: script.title,
        visualAssets: visualAssets.length,
        audioPath: audioPath,
        timestamp: new Date().toISOString()
      }, null, 2));
      await assertLease();
      return infoPath;
    } catch (error) {
      await removeAttemptFiles([infoPath]);
      throw error;
    }
  }


  async simulateThumbnailGeneration(script, style) {
    this.logger.info('Simulating thumbnail generation...');
    
    const thumbnailPath = path.join(__dirname, '..', 'uploads', 'thumbnails', `thumbnail_sim_${Date.now()}.info`);
    await fs.mkdir(path.dirname(thumbnailPath), { recursive: true });
    
    await fs.writeFile(thumbnailPath, JSON.stringify({
      message: 'AI thumbnail would be generated here',
      title: script.title,
      style: style,
      timestamp: new Date().toISOString()
    }, null, 2));
    
    return {
      path: thumbnailPath,
      dimensions: { width: 1792, height: 1024 },
      fileSize: 1024,
      simulated: true
    };
  }
}

module.exports = { AIVideoGenerator, describeImageProviderError };
