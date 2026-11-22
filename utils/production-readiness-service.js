const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { AITextService } = require('./ai-text-service');
const { AIVideoGenerator } = require('./ai-video-generator');
const { checkFFmpeg, runFFmpeg, getFFmpegPath, getFFprobePath, getMediaInfo, getAudioInfo } = require('./ffmpeg');
const { validateYouTubeMetadata } = require('./youtube-metadata-validator');
const { Logger } = require('./logger');
const { MediaGenerationService } = require('./media-generation-service');
const { YOUTUBE_SCOPES } = require('../modern-auth');

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

function isSupportedNodeVersion(version) {
  const major = Number(String(version || '').split('.')[0]);
  return Number.isInteger(major) && major >= 22;
}

class ProductionReadinessService {
  constructor(db, credentialManager, options = {}) {
    this.db = db;
    this.credentialManager = credentialManager;
    this.logger = options.logger || new Logger('ProductionReadiness');
    this.probes = options.probes || {};
    this.now = options.now || (() => new Date());
    this.activeRun = null;
  }

  async getSummary() {
    const latest = await this.db.getLatestReadinessRun();
    if (!latest) {
      return {
        status: 'unverified',
        stale: false,
        blockingFailures: [],
        checks: [],
        message: 'Run the verified readiness check before relying on autonomous production.'
      };
    }
    const age = this.now().getTime() - new Date(latest.completed_at || latest.created_at).getTime();
    return {
      ...latest,
      stale: age > STALE_AFTER_MS,
      blockingFailures: latest.checks.filter(check => check.blocking && check.status === 'failed').map(check => check.id)
    };
  }

  async assertReady(action) {
    const summary = await this.getSummary();
    let reason = null;
    if (summary.status === 'unverified') {
      reason = 'Run the verified production readiness check before continuing';
    } else if (summary.stale) {
      reason = 'The production readiness check is older than 24 hours; run it again';
    } else if (summary.status === 'failed') {
      reason = `Fix ${summary.blockingFailures.join(', ')} and run the check again`;
    } else if (!['passed', 'warning'].includes(summary.status)) {
      reason = `Resolve the readiness status (${summary.status || 'unknown'}) and run the check again`;
    }
    if (reason) {
      const error = new Error(`${action} is blocked by the production readiness gate. ${reason}.`);
      error.status = 409;
      error.readiness = summary;
      throw error;
    }
    return summary;
  }

  async run(options = {}) {
    if (this.activeRun) {
      const error = new Error('A production readiness check is already running');
      error.status = 409;
      throw error;
    }

    this.activeRun = this.executeRun(options).finally(() => {
      this.activeRun = null;
    });
    return this.activeRun;
  }

  async executeRun(options) {
    const startedAt = this.now().toISOString();
    const id = this.db.generateId ? this.db.generateId('readiness') : `readiness_${Date.now()}`;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-readiness-'));
    const checks = [];

    try {
      checks.push(await this.executeCheck('local_runtime', 'Local Windows / Node runtime', true, () => this.probeLocalRuntime()));
      checks.push(await this.executeCheck('text_provider', 'AI text provider', true, () => this.probeText()));
      if (process.env.QUALITY_PIPELINE_ENABLED === 'true') {
        checks.push(await this.executeCheck('quality_pipeline', 'Local-first script quality pipeline', true, () => this.probes.qualityPipeline ? this.probes.qualityPipeline() : this.probeQualityPipeline()));
      }
      checks.push(await this.executeCheck('image_provider', 'Image provider', false, () => this.probeImage(tempDir, Boolean(options.includePaidMedia))));
      checks.push(await this.executeCheck('video_provider', 'AI video provider', true, () => this.probeVideoProvider(tempDir, Boolean(options.includePaidVideo))));
      checks.push(await this.executeCheck('voice_narration', 'Voice narration', true, () => this.probeNarration(tempDir)));
      checks.push(await this.executeCheck('video_assembly', 'Audio/video assembly', true, () => this.probeVideoAssembly(tempDir)));
      checks.push(await this.executeCheck('youtube_access', 'YouTube channel access', true, () => this.probeYouTube()));
      checks.push(await this.executeCheck('upload_metadata', 'Upload metadata', true, () => this.probeMetadata()));

      const blockingFailures = checks.filter(check => check.blocking && check.status === 'failed');
      const warnings = checks.filter(check =>
        ['warning', 'skipped'].includes(check.status) || (!check.blocking && check.status === 'failed')
      );
      const status = blockingFailures.length ? 'failed' : warnings.length ? 'warning' : 'passed';
      const completedAt = this.now().toISOString();
      const result = {
        id,
        status,
        checks,
        summary: {
          passed: checks.filter(check => check.status === 'passed').length,
          warnings: warnings.length,
          failed: checks.filter(check => check.status === 'failed').length,
          blockingFailures: blockingFailures.map(check => check.id)
        },
        startedAt,
        completedAt
      };
      await this.db.saveReadinessRun(result);
      return { ...result, stale: false, blockingFailures: result.summary.blockingFailures };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async executeCheck(id, label, blocking, probe) {
    const started = Date.now();
    try {
      const result = await probe();
      return {
        id,
        label,
        blocking,
        status: result.status || 'passed',
        message: result.message,
        remediation: result.remediation || null,
        details: result.details || {},
        durationMs: Date.now() - started
      };
    } catch (error) {
      const safeMessage = this.safeError(error);
      this.logger.warn(`${label} readiness probe failed: ${safeMessage}`);
      return {
        id,
        label,
        blocking,
        status: 'failed',
        message: safeMessage,
        remediation: this.remediationFor(id),
        details: {},
        durationMs: Date.now() - started
      };
    }
  }

  async probeLocalRuntime() {
    if (!isSupportedNodeVersion(process.versions.node)) {
      throw new Error(`Node.js 22 or newer is required; detected ${process.versions.node}`);
    }

    const dataDirectory = path.resolve(__dirname, '..', 'data');
    await fs.mkdir(dataDirectory, { recursive: true });
    const writableProbe = await fs.mkdtemp(path.join(dataDirectory, '.readiness-write-'));
    let tempDirectory;
    try {
      tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-runtime-write-'));
      const dataProbeFile = path.join(writableProbe, 'write-test.tmp');
      const tempProbeFile = path.join(tempDirectory, 'write-test.tmp');
      await Promise.all([
        fs.writeFile(dataProbeFile, 'AgentTube local data write check', { flag: 'wx' }),
        fs.writeFile(tempProbeFile, 'AgentTube temporary directory write check', { flag: 'wx' })
      ]);
      await Promise.all([fs.access(dataProbeFile), fs.access(tempProbeFile)]);
      return {
        message: 'Node.js version and local data / temporary directory read-write permissions are valid.',
        details: {
          nodeVersion: process.versions.node,
          platform: process.platform,
          architecture: process.arch,
          workingDirectory: process.cwd(),
          dataDirectory,
          dataDirectoryWritable: true,
          temporaryDirectory: os.tmpdir(),
          temporaryDirectoryWritable: true,
          temporaryDirectoryWriteVerified: true
        }
      };
    } finally {
      await fs.rm(writableProbe, { recursive: true, force: true }).catch(() => {});
      if (tempDirectory) await fs.rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
    }
  }

  async probeQualityPipeline() {
    const remoteReviewEnabled = process.env.QUALITY_ALLOW_REMOTE_REVIEW === 'true';
    const credentials = this.credentialManager.credentials || {};
    const geminiKey = credentials.gemini?.apiKey || process.env.GEMINI_API_KEY;
    const groqKey = process.env.GROQ_API_KEY;
    if (remoteReviewEnabled && !geminiKey) throw new Error('Remote review is enabled but Gemini reviewer is not configured');
    if (remoteReviewEnabled && !groqKey) throw new Error('Remote review is enabled but Groq reviewer is not configured');

    let baseUrl = String(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434');
    while (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);
    const model = process.env.OLLAMA_MODEL || 'qwen3.5:4b';
    const response = await fetch(`${baseUrl}/api/tags`, { signal: globalThis.AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Ollama model check failed: HTTP ${response.status}`);
    const data = await response.json();
    const installed = (data.models || []).map(item => String(item.name || item.model || ''));
    if (!installed.some(name => name === model || name.startsWith(`${model}:`))) {
      throw new Error(`Ollama model ${model} is not installed`);
    }
    return {
      message: remoteReviewEnabled
        ? 'Local Ollama reviewer is installed; explicitly enabled Gemini/Groq reviewers are configured.'
        : 'Local Ollama generation and review model is installed; no paid remote reviewers are required.',
      details: { ollamaModel: model, localReviewEnabled: true, remoteReviewEnabled, geminiConfigured: Boolean(geminiKey), groqConfigured: Boolean(groqKey) }
    };
  }
  async probeText() {
    if (this.probes.text) return this.probes.text();
    const service = new AITextService(this.credentialManager.credentials || {});
    if (!service.isAvailable()) throw new Error('No AI text provider is configured');
    // Thinking models use ~100 output tokens on thoughts even for a one-word
    // reply, so the budget must leave room beyond the answer itself.
    const response = await service.generateText('Reply with exactly READY.', { maxTokens: 256, temperature: 0 });
    return { message: `${service.providerName} returned a live response.`, details: { provider: service.providerName, responseReceived: Boolean(response) } };
  }

  async probeImage(tempDir, includePaidMedia) {
    if (this.probes.image) return this.probes.image({ tempDir, includePaidMedia });
    const generator = new AIVideoGenerator(this.credentialManager.credentials || {});
    if (!generator.openai && !generator.gemini) {
      return { status: 'warning', message: 'No AI image provider is configured; gradient visuals will be used.', remediation: 'Configure OpenAI or Gemini image access if generated visuals are required.' };
    }
    if (!includePaidMedia) {
      return { status: 'skipped', message: 'Provider is configured; the paid live image probe was not requested.', remediation: 'Enable “Include paid image probe” on the next readiness run to verify image generation.' };
    }
    const outputPath = path.join(tempDir, 'readiness-image.png');
    await generator.generateImage('Simple red circle centered on a plain dark background, no text', outputPath);
    const stats = await fs.stat(outputPath);
    if (stats.size < 100) throw new Error('Image provider returned an empty or invalid asset');
    return { message: 'Image provider created a real test asset.', details: { bytes: stats.size } };
  }

  async probeNarration(tempDir) {
    if (this.probes.narration) return this.probes.narration({ tempDir });
    const generator = new AIVideoGenerator(this.credentialManager.credentials || {});
    const outputPath = path.join(tempDir, 'readiness-narration.mp3');
    const resultPath = await generator.generateTTSAudio('Production readiness audio check.', outputPath);
    if (path.extname(resultPath).toLowerCase() === '.info') throw new Error('No live narration provider is available; the pipeline returned a simulation');
    const stats = await fs.stat(resultPath);
    if (stats.size < 100) throw new Error('Narration provider returned an empty audio file');
    return { message: 'A live narration sample was generated.', details: { bytes: stats.size } };
  }

  async probeVideoProvider(tempDir, includePaidVideo) {
    if (this.probes.videoProvider) return this.probes.videoProvider({ tempDir, includePaidVideo });
    const service = new MediaGenerationService(this.db, this.credentialManager.credentials || {});
    const settings = await service.settings();
    const requested = settings.provider;
    const configured = requested === 'auto' ? service.registry.select('auto', settings.order) : service.registry.get(requested);
    if (!configured || !configured.isAvailable()) {
      if (requested === 'slideshow') {
        return { message: 'Local slideshow video generation is selected; no paid AI video provider is required.', details: { provider: 'slideshow' } };
      }
      throw new Error(`${requested} is selected but its credentials are not configured`);
    }
    if (configured.id === 'slideshow') {
      return { message: 'Local slideshow video generation is selected; no paid AI video provider is required.', details: { provider: 'slideshow' } };
    }
    if (!includePaidVideo) {
      return {
        status: 'skipped',
        message: `${configured.id} is configured; the paid live video probe was not requested.`,
        remediation: 'Enable “Include paid video probe” on the next readiness run to verify the selected model.',
        details: { provider: configured.id, model: configured.model }
      };
    }
    const outputPath = path.join(tempDir, 'readiness-provider.mp4');
    const result = await service.generateClip({
      jobId: null,
      productionId: `readiness_${Date.now()}`,
      scene: { index: Date.now() },
      provider: configured,
      outputPath,
      request: {
        prompt: 'A small red ball rolls slowly across a plain dark studio floor, static camera, no text.',
        duration: configured.capabilities.minDuration || 4,
        resolution: settings.resolution,
        aspectRatio: settings.aspectRatio,
        generateAudio: false
      }
    });
    const stats = await fs.stat(result.outputPath);
    return {
      message: `${configured.id} created and returned a decodable MP4.`,
      details: { provider: configured.id, model: configured.model, bytes: stats.size, taskId: result.task.external_task_id }
    };
  }

  async probeVideoAssembly(tempDir) {
    if (this.probes.videoAssembly) return this.probes.videoAssembly({ tempDir });
    if (!await checkFFmpeg()) throw new Error('FFmpeg is not available');
    const ffmpegPath = getFFmpegPath();
    const ffprobePath = getFFprobePath();
    const versionResult = await runFFmpeg(['-version']);
    const versionOutput = String(versionResult.stdout || versionResult.stderr || '');
    const ffmpegVersion = versionOutput.split('\n')[0].trim() || 'Version not reported';
    const encoderResult = await runFFmpeg(['-hide_banner', '-encoders']);
    const encoderOutput = String(encoderResult.stdout || '') + String(encoderResult.stderr || '');
    const filterResult = await runFFmpeg(['-hide_banner', '-filters']);
    const filterOutput = String(filterResult.stdout || '') + String(filterResult.stderr || '');

    const missingEncoders = ['libx264', 'aac'].filter(name => !encoderOutput.includes(name));
    const missingFilters = ['zoompan', 'vignette'].filter(name => !filterOutput.includes(name));
    if (missingEncoders.length) throw new Error(`FFmpeg is missing required encoders: ${missingEncoders.join(', ')}. Install a full FFmpeg build with libx264 and AAC support.`);
    if (missingFilters.length) throw new Error(`FFmpeg is missing required CineCode filters: ${missingFilters.join(', ')}. Install a full FFmpeg build with zoompan and vignette filters.`);

    let ffprobeAvailable = false;
    let ffprobeVersion = null;
    try {
      const probe = await execFileAsync(ffprobePath, ['-version'], { timeout: 5000, windowsHide: true });
      ffprobeVersion = String(probe.stdout || probe.stderr || '').split('\n')[0].trim() || null;
      ffprobeAvailable = true;
    } catch (_error) {
      // The ffmpeg metadata fallback remains supported when ffprobe is not installed.
    }

    const outputPath = path.join(tempDir, 'readiness-av.mp4');
    await runFFmpeg([
      '-y', '-f', 'lavfi', '-i', 'color=c=0x111827:s=640x360:d=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-vf', "scale=640:360:force_original_aspect_ratio=increase,crop=640:360,zoompan=z='min(zoom+0.00004,1.08)':d=1:s=320x180:fps=30,vignette=PI/5,format=yuv420p",
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
      '-c:a', 'aac', '-shortest', '-movflags', '+faststart', outputPath
    ]);
    const buffer = await fs.readFile(outputPath);
    if (buffer.length < 1000 || buffer.subarray(4, 12).toString('ascii').indexOf('ftyp') === -1) {
      throw new Error('FFmpeg did not produce a valid MP4 container');
    }
    await runFFmpeg(['-v', 'error', '-i', outputPath, '-f', 'null', '-']);
    const [videoInfo, audioInfo] = await Promise.all([
      getMediaInfo(outputPath),
      getAudioInfo(outputPath)
    ]);
    if (!videoInfo.hasAudio || !audioInfo.duration) throw new Error('The test MP4 is missing a readable audio stream');
    if (videoInfo.width !== 320 || videoInfo.height !== 180) {
      throw new Error(`FFmpeg returned unexpected test dimensions: ${videoInfo.width}x${videoInfo.height}`);
    }

    return {
      status: ffprobeAvailable ? 'passed' : 'warning',
      message: ffprobeAvailable
        ? 'FFmpeg, FFprobe, CineCode motion filters, H.264 and AAC all rendered and decoded a real local MP4.'
        : 'FFmpeg rendered and decoded the real MP4. FFprobe is unavailable; the built-in FFmpeg metadata fallback was verified.',
      remediation: ffprobeAvailable ? null : 'Install FFprobe or configure FFPROBE_PATH alongside FFmpeg for faster and more reliable media inspection.',
      details: {
        ffmpegPath,
        ffmpegVersion,
        ffprobePath,
        ffprobeAvailable,
        ffprobeVersion,
        videoEncoder: 'libx264',
        audioEncoder: 'aac',
        filters: ['zoompan', 'vignette'],
        outputBytes: buffer.length,
        outputWidth: videoInfo.width,
        outputHeight: videoInfo.height,
        outputDurationSeconds: Number(videoInfo.duration.toFixed(3)),
        audioCodec: audioInfo.codec
      }
    };
  }

  async probeYouTube() {
    if (this.probes.youtube) return this.probes.youtube();
    const grantedScopes = new Set(
      String(this.credentialManager.tokens?.youtube?.scope || '').split(/\s+/).filter(Boolean)
    );
    const missingScopes = YOUTUBE_SCOPES.filter(scope => !grantedScopes.has(scope));
    if (missingScopes.length) {
      const names = missingScopes.map(scope => scope.split('/').pop()).join(', ');
      throw new Error(`YouTube authorization is missing required OAuth scopes: ${names}. Reconnect the channel and approve the requested permissions.`);
    }
    const youtube = this.credentialManager.getYouTubeClient();
    const response = await youtube.channels.list({ part: 'snippet,status', mine: true, maxResults: 1 });
    const channel = response.data?.items?.[0];
    if (!channel) throw new Error('The authorized Google account does not expose a YouTube channel');
    return {
      message: `Authorized channel access verified for ${channel.snippet?.title || 'the connected channel'}.`,
      details: { channelId: channel.id, channelTitle: channel.snippet?.title || null }
    };
  }

  async probeMetadata() {
    if (this.probes.metadata) return this.probes.metadata();
    const queue = await this.db.getPublishQueue();
    const candidates = queue.length ? queue : [{ title: 'Production readiness test', metadata: { seo: { title: 'Production readiness test', description: 'A safe local metadata validation sample for YouTube upload readiness.', tags: ['readiness', 'youtube', 'automation'], metadata: { category: 22, language: 'en' } } } }];
    const invalid = [];
    let warnings = 0;
    for (const item of candidates) {
      const result = validateYouTubeMetadata(item.metadata?.seo || item.metadata || { title: item.title });
      warnings += result.warnings.length;
      if (!result.valid) invalid.push({ productionId: item.productionId || null, title: item.title, errors: result.errors });
    }
    if (invalid.length) {
      const error = new Error(`${invalid.length} queued upload(s) have invalid YouTube metadata`);
      error.invalid = invalid;
      throw error;
    }
    return {
      status: warnings ? 'warning' : 'passed',
      message: queue.length ? `${queue.length} queued upload(s) passed metadata validation.` : 'Metadata rules passed with a safe local sample.',
      remediation: warnings ? 'Review queued descriptions and tags before publishing.' : null,
      details: { validated: candidates.length, queued: queue.length, warnings }
    };
  }

  safeError(error) {
    return String(error?.message || 'Probe failed')
      .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
      .replace(/AIza[A-Za-z0-9_-]+/g, '[redacted]')
      .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
      .replace(/(access_token|refresh_token|api[_-]?key|token)=([^\s&]+)/gi, '$1=[redacted]')
      .slice(0, 500);
  }

  remediationFor(id) {
    const messages = {
      text_provider: 'Run npm run walkthrough, verify the selected model, and confirm provider credits or quota.',
      quality_pipeline: 'Start Ollama and pull the configured model. Remote Gemini/Groq reviewers are optional and require QUALITY_ALLOW_REMOTE_REVIEW=true.',
      image_provider: 'Verify paid image access or rely on the built-in gradient visual fallback.',
      video_provider: 'Configure the selected provider credentials, choose local slideshow, or rerun with the paid video probe enabled.',
      voice_narration: 'Configure OpenAI, Gemini TTS, ElevenLabs with a voice ID, or Azure Speech, then rerun.',
      local_runtime: 'Install Node.js 22 or newer, close apps that may lock the data folder, verify write permissions, and rerun the check.',
      video_assembly: 'Install a full FFmpeg build with libx264, AAC, zoompan and vignette support. On Windows, run winget install Gyan.FFmpeg, restart the terminal, and configure FFMPEG_PATH / FFPROBE_PATH if needed.',
      youtube_access: 'Reconnect YouTube in npm run walkthrough and ensure the Google account owns a channel.',
      upload_metadata: 'Edit the queued title, description, category, language, and tags before publishing.'
    };
    return messages[id] || 'Correct the configuration and rerun the readiness check.';
  }
}

module.exports = { ProductionReadinessService, STALE_AFTER_MS, isSupportedNodeVersion };
