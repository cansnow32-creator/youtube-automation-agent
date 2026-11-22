require('dotenv').config();

const express = require('express');
const { buildContentReviewAfterEdit } = require('./utils/content-review-edit');
const path = require('path');
const fs = require('fs').promises;
const { Logger } = require('./utils/logger');
const { Database } = require('./database/db');
const { CredentialManager } = require('./utils/credential-manager');
const { ContentStrategyAgent } = require('./agents/content-strategy-agent');
const { ScriptWriterAgent } = require('./agents/script-writer-agent');
const { ThumbnailDesignerAgent } = require('./agents/thumbnail-designer-agent');
const { SEOOptimizerAgent } = require('./agents/seo-optimizer-agent');
const { ProductionManagementAgent } = require('./agents/production-management-agent');
const { PublishingSchedulingAgent } = require('./agents/publishing-scheduling-agent');
const { AnalyticsOptimizationAgent } = require('./agents/analytics-optimization-agent');
const { DailyAutomation } = require('./schedules/daily-automation');
const { OperatorService } = require('./utils/operator-service');
const { AutonomousChannelOperator } = require('./utils/autonomous-channel-operator');
const { ActivationMetrics } = require('./utils/activation-metrics');
const { AnonymousTelemetry } = require('./utils/anonymous-telemetry');
const { ProductionReadinessService } = require('./utils/production-readiness-service');
const { GenerationRecoveryService, GENERATION_STAGES } = require('./utils/generation-recovery-service');
const { acquireGenerationJobLease } = require('./utils/generation-job-lease');
const { ProvenanceService } = require('./utils/provenance-service');
const { SceneRepairService } = require('./utils/scene-repair-service');
const { ShortsRepurposingService } = require('./utils/shorts-repurposing-service');
const { AudienceEngagementService } = require('./utils/audience-engagement-service');
const { GrowthExperimentService } = require('./utils/growth-experiment-service');
const { AITextService } = require('./utils/ai-text-service');
const { VideoConceptService } = require('./utils/video-concept-service');
const { requireApprovedVideoConcept } = require('./utils/approved-video-concept-gate');
const { getAppliedPackagingLearning } = require('./utils/packaging-learning');
const { ReferenceVideoService } = require('./utils/reference-video-service');
const { DiscoverabilityService } = require('./utils/discoverability-service');
const { version } = require('./package.json');
const chalk = require('chalk');

function isLoopbackHost(host) {
  return ['127.0.0.1', '::1', 'localhost'].includes(String(host).toLowerCase()) || /^127\./.test(String(host));
}

function validateHostConfiguration(host) {
  if (!isLoopbackHost(host)) {
    throw new Error('Refusing to expose the dashboard beyond loopback: read-only API routes do not yet have session authentication. Bind HOST to 127.0.0.1.');
  }
  return true;
}

class YouTubeAutomationAgent {
  constructor() {
    this.logger = new Logger('MainAgent');
    this.db = null;
    this.credentials = null;
    this.agents = {};
    this.app = express();
    this.isInitialized = false;
    this.activeJobs = new Map();
    this.operator = null;
    this.autonomous = null;
    this.activation = null;
    this.telemetry = null;
    this.readiness = null;
    this.recovery = null;
    this.provenance = null;
    this.scenes = null;
    this.shorts = null;
    this.engagement = null;
    this.experiments = null;
    this.discoverability = null;
    this.setupRequired = false;
    this.references = null;
  }

  async initialize() {
    try {
      console.log(chalk.cyan.bold(`\n🎬 YouTube Automation Agent v${version}`));
      console.log(chalk.gray('─'.repeat(50)));
      
      // Initialize database
      this.logger.info('Initializing database...');
      this.db = new Database();
      await this.db.initialize();
      await this.db.markInterruptedJobs();
      this.recovery = new GenerationRecoveryService(this.db, {
        logger: this.logger,
        updateJobStage: (...args) => this.updateJobStage(...args)
      });
      this.operator = new OperatorService(this.db);
      this.provenance = new ProvenanceService(this.db);
      this.discoverability = new DiscoverabilityService(this.db, { logger: this.logger });
      this.autonomous = new AutonomousChannelOperator(this.db, {
        researchAndPlan: strategy => {
          if (!this.agents.strategy) throw new Error('The strategy agent is not configured');
          return this.agents.strategy.researchAndPlanChannel(strategy);
        },
        startGenerationJob: input => this.startGenerationJob(input),
        resumeGenerationJob: (jobId, options) => this.resumeGenerationJob(jobId, options),
        waitForGenerationJob: jobId => this.waitForGenerationJob(jobId),
        notify: notification => this.operator.notify(notification)
      });
      this.activation = new ActivationMetrics(this.db);
      this.telemetry = new AnonymousTelemetry(this.db, this.logger);
      
      // Load credentials
      this.logger.info('Loading credentials...');
      this.credentials = new CredentialManager();
      const credentialsValid = await this.credentials.validateAll();
      this.readiness = new ProductionReadinessService(this.db, this.credentials);
      
      if (!credentialsValid) {
        console.log(chalk.yellow('\n⚠️  Some credentials are missing or invalid.'));
        console.log(chalk.yellow('Run: npm run credentials:setup'));
        this.setupRequired = true;
        this.setupAPI();
        this.isInitialized = true;
        this.logger.warn('Dashboard started in setup mode; generation and publishing are disabled');
        return true;
      }
      
      // Initialize agents
      this.logger.info('Initializing agents...');
      await this.initializeAgents();
      this.scenes = this.agents.production?.sceneRepair || new SceneRepairService(
        this.db,
        this.agents.production?.aiVideoGenerator,
        { logger: this.logger }
      );
      this.shorts = new ShortsRepurposingService(this.db, this.agents.publishing, { logger: this.logger });
      this.engagement = new AudienceEngagementService(
        this.db,
        this.credentials,
        new AITextService(this.credentials?.credentials || {}),
        { logger: this.logger }
      );
      this.experiments = new GrowthExperimentService(
        this.db,
        this.agents.analytics,
        this.agents.publishing,
        { logger: this.logger }
      );

      // Show which pipeline stages will run for real vs. be simulated
      const capabilities = await this.logCapabilitySummary();
      if (capabilities.hasText && capabilities.hasFFmpeg && capabilities.hasUpload) {
        await this.activation.markSetupReady(capabilities);
      }
      
      // Setup API endpoints
      this.setupAPI();
      
      // Initialize scheduler
      this.logger.info('Setting up automation scheduler...');
      this.scheduler = new DailyAutomation(this.agents, this.db, {
        generateContent: input => this.queueScheduledContent(input),
        engagement: this.engagement,
        experiments: this.experiments
      });
      await this.scheduler.initialize();

      if (await this.db.getSetting('automation_paused') === 'true') {
        await this.scheduler.pauseAutomation();
      }
      
      this.isInitialized = true;
      this.logger.success('YouTube Automation Agent initialized successfully!');
      
      return true;
    } catch (error) {
      this.logger.error('Failed to initialize:', error);
      return false;
    }
  }

  async initializeAgents() {
    this.agents = {
      strategy: new ContentStrategyAgent(this.db, this.credentials),
      scriptWriter: new ScriptWriterAgent(this.db, this.credentials),
      thumbnailDesigner: new ThumbnailDesignerAgent(this.db, this.credentials),
      seoOptimizer: new SEOOptimizerAgent(this.db, this.credentials),
      production: new ProductionManagementAgent(this.db, this.credentials),
      publishing: new PublishingSchedulingAgent(this.db, this.credentials),
      analytics: new AnalyticsOptimizationAgent(this.db, this.credentials)
    };

    // Initialize each agent
    for (const [name, agent] of Object.entries(this.agents)) {
      await agent.initialize();
      this.logger.info(`✓ ${name} agent initialized`);
    }
  }

  async logCapabilitySummary() {
    const { checkFFmpeg, ffmpegInstallHint } = require('./utils/ffmpeg');
    const creds = this.credentials.credentials || {};

    const hasText = this.credentials.hasAITextProvider();
    const hasGemini = Boolean(creds.gemini?.apiKey || process.env.GEMINI_API_KEY);
    const hasImages = Boolean(creds.openai?.apiKey || process.env.OPENAI_API_KEY || hasGemini);
    const hasTTS = Boolean(
      creds.openai?.apiKey || process.env.OPENAI_API_KEY ||
      creds.elevenLabs?.apiKey || process.env.ELEVENLABS_API_KEY ||
      creds.azureSpeech?.subscriptionKey || process.env.AZURE_SPEECH_KEY ||
      hasGemini
    );
    const hasFFmpeg = await checkFFmpeg();
    const hasUpload = Boolean(creds.youtube && this.credentials.tokens?.youtube);

    const capabilities = [
      { name: 'Script & strategy generation', ok: hasText, hint: 'configure an AI provider (npm run credentials:setup)' },
      { name: 'Image generation (visuals/thumbnails)', ok: hasImages, hint: 'requires an OpenAI or Gemini API key — otherwise gradient slides are used' },
      { name: 'Voice narration (TTS)', ok: hasTTS, hint: 'configure OpenAI, Gemini, ElevenLabs, or Azure Speech — otherwise videos are silent' },
      { name: 'Video assembly (FFmpeg)', ok: hasFFmpeg, hint: ffmpegInstallHint() },
      { name: 'YouTube upload', ok: hasUpload, hint: 'run: npm run credentials:setup' }
    ];

    console.log(chalk.cyan('\n🔎 Capability check:'));
    for (const cap of capabilities) {
      if (cap.ok) {
        console.log(chalk.green(`  ✓ ${cap.name}`));
      } else {
        console.log(chalk.yellow(`  ✗ ${cap.name} — ${cap.hint}`));
      }
    }

    if (!hasFFmpeg) {
      this.logger.warn('FFmpeg is missing: no .mp4 files can be produced until it is installed.');
    }
    console.log('');
    return { hasText, hasImages, hasTTS, hasFFmpeg, hasUpload };
  }

  requireAPIKey() {
    return (req, res, next) => {
      if (!process.env.API_KEY) {
        return next();
      }

      if (req.get('x-api-key') !== process.env.API_KEY) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }

      return next();
    };
  }

  validateGenerateRequestBody(body = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { valid: false, status: 400, error: 'Request body must be a JSON object' };
    }

    const value = {
      topic: null,
      style: null,
      length: typeof body.length === 'string' ? body.length.toLowerCase() : 'medium',
      strategyContext: null
    };

    // JSON has no `undefined`, so clients send `null` to mean "no value provided".
    // Both are treated as "not set" here: topic/style are optional and default to
    // auto-selection, which is exactly what `null` already represents internally.
    if (body.topic !== undefined && body.topic !== null) {
      if (typeof body.topic !== 'string') {
        return { valid: false, status: 400, error: 'topic must be a string' };
      }

      const topic = body.topic.trim();
      if (topic.length > 200) {
        return { valid: false, status: 400, error: 'topic must be 200 characters or less' };
      }
      value.topic = topic || null;
    }

    if (body.style !== undefined && body.style !== null) {
      if (typeof body.style !== 'string') {
        return { valid: false, status: 400, error: 'style must be a string' };
      }

      const allowedStyles = new Set([
        'tutorial',
        'explainer',
        'list',
        'review',
        'story',
        'educational',
        'informative',
        'engaging',
        'professional',
        'ethereal'
      ]);
      const style = body.style.trim();

      if (style.length > 50) {
        return { valid: false, status: 400, error: 'style must be 50 characters or less' };
      }

      value.style = allowedStyles.has(style.toLowerCase()) ? style.toLowerCase() : style || null;
    }

    if (!['short', 'medium', 'long'].includes(value.length)) {
      return { valid: false, status: 400, error: 'length must be short, medium, or long' };
    }

    if (body.strategyContext !== undefined && body.strategyContext !== null) {
      if (typeof body.strategyContext !== 'object' || Array.isArray(body.strategyContext)) {
        return { valid: false, status: 400, error: 'strategyContext must be an object' };
      }
      const limits = { angle: 500, rationale: 1000, audience: 500, objective: 1000, valueProposition: 1000, constraints: 2000, pillar: 100 };
      value.strategyContext = {};
      for (const [key, max] of Object.entries(limits)) {
        if (body.strategyContext[key] === undefined || body.strategyContext[key] === null) continue;
        if (typeof body.strategyContext[key] !== 'string' || body.strategyContext[key].length > max) {
          return { valid: false, status: 400, error: `strategyContext.${key} must be a string of ${max} characters or less` };
        }
        value.strategyContext[key] = body.strategyContext[key].trim();
      }
    }

    return { valid: true, value };
  }

  validateChannelStrategy(body = {}, current = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('Channel strategy must be a JSON object');
    }
    const text = (key, fallback, max) => {
      const value = String(body[key] ?? fallback ?? '').trim();
      if (value.length > max) throw new Error(`${key} must be ${max} characters or less`);
      return value;
    };
    const objective = text('objective', current.objective, 1000);
    const audience = text('audience', current.audience, 500);
    if (!objective) throw new Error('A channel objective is required');
    if (!audience) throw new Error('A target audience is required');

    const rawPillars = body.contentPillars ?? current.contentPillars ?? [];
    if (!Array.isArray(rawPillars)) throw new Error('contentPillars must be an array');
    const contentPillars = rawPillars.map(value => String(value).trim()).filter(Boolean);
    if (!contentPillars.length || contentPillars.length > 8 || contentPillars.some(value => value.length > 100)) {
      throw new Error('Provide 1 to 8 content pillars, each 100 characters or less');
    }

    const integer = (key, fallback, min, max) => {
      const value = Number(body[key] ?? fallback);
      if (!Number.isInteger(value) || value < min || value > max) {
        throw new Error(`${key} must be an integer from ${min} to ${max}`);
      }
      return value;
    };
    const defaultFormat = text('defaultFormat', current.default_format || 'explainer', 20).toLowerCase();
    const defaultLength = text('defaultLength', current.default_length || 'medium', 20).toLowerCase();
    const status = text('status', current.status || 'draft', 20).toLowerCase();
    const primaryKpi = text('primaryKpi', current.primary_kpi || 'views', 30).toLowerCase();
    const outcomeCurrency = text('outcomeCurrency', current.outcome_currency || 'USD', 3).toUpperCase();
    if (!['explainer', 'tutorial', 'list', 'review', 'story'].includes(defaultFormat)) {
      throw new Error('defaultFormat is not supported');
    }
    if (!['short', 'medium', 'long'].includes(defaultLength)) throw new Error('defaultLength is not supported');
    if (!['draft', 'active', 'paused'].includes(status)) throw new Error('status must be draft, active, or paused');
    if (!['views', 'watch_hours', 'subscribers', 'engagement', 'revenue'].includes(primaryKpi)) {
      throw new Error('primaryKpi is not supported');
    }
    if (!/^[A-Z]{3}$/.test(outcomeCurrency)) throw new Error('outcomeCurrency must be a three-letter currency code');
    const optionalNumber = (key, fallback, min, max) => {
      const raw = body[key] ?? fallback;
      if (raw === undefined || raw === null || raw === '') return null;
      const value = Number(raw);
      if (!Number.isFinite(value) || value < min || value > max) {
        throw new Error(`${key} must be a number from ${min} to ${max}`);
      }
      return value;
    };

    return {
      objective,
      audience,
      valueProposition: text('valueProposition', current.value_proposition, 1000),
      contentPillars,
      cadencePerWeek: integer('cadencePerWeek', current.cadence_per_week || 1, 1, 7),
      videosPerRun: integer('videosPerRun', current.videos_per_run || 1, 1, 5),
      defaultFormat,
      defaultLength,
      successMetric: text('successMetric', current.success_metric, 300),
      primaryKpi,
      targetValue: optionalNumber('targetValue', current.target_value, 0.01, 1000000000),
      targetWindowDays: integer('targetWindowDays', current.target_window_days || 28, 7, 365),
      monthlyBudget: optionalNumber('monthlyBudget', current.monthly_budget, 0, 10000000),
      outcomeCurrency,
      constraints: text('constraints', current.constraints, 2000),
      status
    };
  }
  setupAPI() {
    this.app.use(express.json({ limit: '1mb' }));
    this.app.use(express.static(path.join(__dirname, 'dashboard')));

    if (!process.env.API_KEY) {
      this.logger.warn('API_KEY is not set; mutating API routes are unprotected');
    }
    
    // Main dashboard route
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
    });
    
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        status: this.setupRequired ? 'setup_required' : 'healthy',
        version,
        initialized: this.isInitialized,
        setupRequired: this.setupRequired,
        agents: Object.keys(this.agents),
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
      });
    });

    // Local-first video concept proposal, revision and approval.
    this.concepts = new VideoConceptService(this.db);
    this.references = new ReferenceVideoService(this.db);
    this.app.post(
      '/api/concepts/reference-videos',
      this.requireAPIKey(),
      express.raw({ type: ['video/mp4', 'video/quicktime', 'video/webm'], limit: '200mb' }),
      async (req, res) => {
        let record = null;
        try {
          let fileName = req.get('x-file-name') || 'reference-video';
          try { fileName = decodeURIComponent(fileName); } catch (_error) { /* retain the supplied safe fallback */ }
          record = await this.references.upload(req.body, fileName, req.get('content-type'));
          let analysisError = null;
          try {
            record = await this.concepts.analyzeReferenceVideo(record.id);
          } catch (error) {
            analysisError = error.message;
            record = await this.db.updateReferenceVideoAnalysis(record.id, { error: error.message }, 'failed');
          }
          return res.status(201).json({
            success: true,
            referenceVideo: this.references.toPublicRecord(record),
            analysisError
          });
        } catch (error) {
          return res.status(error.status || 400).json({ success: false, error: error.message });
        }
      }
    );
    this.app.get('/api/concepts/reference-videos/:referenceId/frames/:frameIndex', this.requireAPIKey(), async (req, res) => {
      try {
        const framePath = await this.references.getFrame(req.params.referenceId, req.params.frameIndex);
        if (!framePath) return res.status(404).json({ success: false, error: 'Reference frame not found' });
        return res.sendFile(framePath);
      } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
      }
    });
    this.app.get('/api/concepts', this.requireAPIKey(), async (_req, res) => {
      try {
        return res.json({ success: true, concepts: await this.db.listVideoConcepts(30) });
      } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/concepts/propose', this.requireAPIKey(), async (req, res) => {
      try {
        const topic = typeof req.body?.topic === 'string' ? req.body.topic.trim() : '';
        const direction = typeof req.body?.direction === 'string' ? req.body.direction.trim() : '';
        const referenceNotes = typeof req.body?.referenceNotes === 'string' ? req.body.referenceNotes.trim().slice(0, 3000) : '';
        const referenceVideoId = typeof req.body?.referenceVideoId === 'string' ? req.body.referenceVideoId : null;
        if (!topic) return res.status(400).json({ success: false, error: 'Topic is required' });
        const profile = await this.db.getChannelProfile();
        const concept = await this.concepts.propose({ topic, direction, profile, referenceNotes, referenceVideoId });
        return res.status(201).json({ success: true, concept });
      } catch (error) {
        return res.status(503).json({ success: false, error: error.message });
      }
    });

    this.app.get('/api/concepts/:conceptId', this.requireAPIKey(), async (req, res) => {
      try {
        const concept = await this.concepts.get(req.params.conceptId);
        return concept ? res.json({ success: true, concept }) : res.status(404).json({ success: false, error: 'Video concept not found' });
      } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post(
      '/api/concepts/:conceptId/music',
      this.requireAPIKey(),
      express.raw({
        type: ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/ogg', 'audio/flac', 'audio/x-flac', 'audio/webm'],
        limit: '50mb'
      }),
      async (req, res) => {
        try {
          const headerText = name => {
            const value = req.get(name) || '';
            try { return decodeURIComponent(value); } catch (_error) { return value; }
          };
          const concept = await this.concepts.attachMusicAsset(req.params.conceptId, req.body, {
            mimeType: req.get('content-type'),
            title: headerText('x-music-title'),
            creator: headerText('x-music-creator'),
            licenseType: req.get('x-license-type'),
            rightsConfirmed: req.get('x-rights-confirmed') === 'true',
            attribution: headerText('x-music-attribution'),
            licenseName: headerText('x-license-name'),
            licenseUrl: headerText('x-license-url'),
            sourceUrl: headerText('x-source-url'),
            volume: req.get('x-music-volume') === undefined ? 0.18 : Number(req.get('x-music-volume')),
            loop: req.get('x-music-loop') !== 'false',
            fadeInSeconds: req.get('x-music-fade-in') === undefined ? 2 : Number(req.get('x-music-fade-in')),
            fadeOutSeconds: req.get('x-music-fade-out') === undefined ? 3 : Number(req.get('x-music-fade-out'))
          });
          return res.json({ success: true, concept });
        } catch (error) {
          const status = /not found/i.test(error.message) ? 404
            : /immutable|before concept approval/i.test(error.message) ? 409 : 400;
          return res.status(status).json({ success: false, error: error.message });
        }
      }
    );

    this.app.post('/api/concepts/:conceptId/revise', this.requireAPIKey(), async (req, res) => {
      try {
        const concept = await this.concepts.revise({
          conceptId: req.params.conceptId,
          feedback: req.body?.feedback,
          direction: req.body?.direction
        });
        return res.status(201).json({ success: true, concept });
      } catch (error) {
        const status = /not found/i.test(error.message) ? 404 : /Approved concepts|Describe what/i.test(error.message) ? 409 : 503;
        return res.status(status).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/concepts/:conceptId/approve', this.requireAPIKey(), async (req, res) => {
      try {
        const concept = await this.concepts.approve(req.params.conceptId);
        return concept ? res.json({ success: true, concept }) : res.status(404).json({ success: false, error: 'Video concept not found' });
      } catch (error) {
        return res.status(409).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/concepts/:conceptId/generate', this.requireAPIKey(), async (req, res) => {
      try {
        const concept = await this.db.getVideoConcept(req.params.conceptId);
        if (!concept) return res.status(404).json({ success: false, error: 'Video concept not found' });
        if (concept.status !== 'approved') return res.status(409).json({ success: false, error: 'Approve the video concept before production can start' });
        const result = await this.startGenerationJob({
          topic: concept.topic,
          style: req.body?.style || null,
          length: req.body?.length || 'medium',
          source: 'manual',
          requireApprovedConcept: true,
          approvedConceptId: concept.id
        });
        return res.status(202).json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 500).json({ success: false, error: error.message });
      }
    });

    // Manual content generation
    this.app.post('/generate', this.requireAPIKey(), async (req, res) => {
      try {
        if (this.setupRequired) {
          return res.status(503).json({ success: false, error: 'Finish setup with npm run walkthrough before generating content' });
        }
        const validation = this.validateGenerateRequestBody(req.body);
        if (!validation.valid) {
          return res.status(validation.status).json({ success: false, error: validation.error });
        }

        const { topic, style, length } = validation.value;
        const result = await this.startGenerationJob({ topic, style, length, source: 'manual' });
        res.status(202).json({ success: true, result });
      } catch (error) {
        res.status(error.status || 500).json({ success: false, error: error.message });
      }
    });

    // Get analytics
    this.app.get('/analytics', async (req, res) => {
      try {
        if (!this.agents.analytics) return res.json({ totalVideos: 0, averagePerformanceScore: 0, topPerformers: [], insights: [], learning: null });
        const analytics = await this.agents.analytics.getRecentAnalytics();
        const learning = await this.agents.analytics.getLearningSummary();
        res.json({ ...analytics, learning });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get('/api/analytics/channel', async (req, res) => {
      try {
        if (!this.agents.analytics?.getChannelSnapshot) {
          return res.json({ success: true, result: { available: false, reason: 'Connect YouTube with npm run walkthrough to see channel statistics.' } });
        }
        const result = await this.agents.analytics.getChannelSnapshot({ refresh: req.query.refresh === '1' });
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.get('/api/outcomes', async (_req, res) => {
      try {
        const learning = this.agents.analytics?.getLearningSummary
          ? await this.agents.analytics.getLearningSummary()
          : { outcome: null };
        return res.json({ success: true, result: learning.outcome || null });
      } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
      }
    });

    // Get upcoming schedule
    this.app.get('/schedule', async (req, res) => {
      try {
        const schedule = await this.db.getUpcomingSchedule();
        res.json(schedule);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Manual publish
    this.app.post('/publish/:contentId', this.requireAPIKey(), async (req, res) => {
      try {
        if (!this.agents.publishing) return res.status(503).json({ success: false, error: 'YouTube publishing is not configured' });
        const { contentId } = req.params;
        const bundle = await this.db.getProductionBundle(contentId);
        const short = bundle ? null : await this.db.getShortClip(contentId);
        if ((!bundle || bundle.review_status !== 'approved') && (!short || !['scheduled', 'failed', 'uploading', 'reconciliation_required'].includes(short.status))) {
          return res.status(409).json({ success: false, error: 'Content must pass review and be approved before publishing' });
        }
        const result = await this.agents.publishing.publishContent(contentId);
        res.json({ success: true, result });
      } catch (error) {
        res.status(error.status || 500).json({ success: false, error: error.message });
      }
    });

    this.setupOperatorAPI();
  }

  setupOperatorAPI() {
    const protect = this.requireAPIKey();

    this.app.get('/api/publishing/unresolved', protect, async (req, res) => {
      try {
        const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 100));
        if (typeof this.db.listUnresolvedPublishScheduleEntries !== 'function') {
          return res.status(503).json({ success: false, error: 'Publishing reconciliation storage is unavailable' });
        }
        const entries = await this.db.listUnresolvedPublishScheduleEntries(limit);
        return res.json({
          success: true,
          entries: entries.map(entry => ({
            id: entry.id,
            productionId: entry.productionId,
            title: entry.title,
            publishTime: entry.publishTime,
            uploadStartedAt: entry.uploadStartedAt || null,
            status: entry.status,
            youtubeId: entry.youtubeId || null,
            error: entry.error || null,
            contentType: entry.metadata?.contentType || (entry.metadata?.shortClipId ? 'short' : 'long_form'),
            shortClipId: entry.metadata?.shortClipId || null,
            createdAt: entry.created_at || null
          }))
        });
      } catch (error) {
        return res.status(error.status || 500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/publishing/:scheduleId/reconcile', protect, async (req, res) => {
      try {
        if (!this.agents.publishing) {
          return res.status(503).json({ success: false, error: 'YouTube publishing is not configured' });
        }
        const result = await this.agents.publishing.reconcileUnresolvedUpload(
          req.params.scheduleId,
          req.body?.videoId
        );
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 500).json({
          success: false,
          error: error.message,
          code: error.code || null
        });
      }
    });

    this.app.post('/api/publishing/:scheduleId/resolve-no-upload', protect, async (req, res) => {
      try {
        if (!this.agents.publishing) {
          return res.status(503).json({ success: false, error: 'YouTube publishing is not configured' });
        }
        const result = await this.agents.publishing.resolveUnresolvedUploadAsAbsent(
          req.params.scheduleId,
          req.body?.confirmedAbsent
        );
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 500).json({
          success: false,
          error: error.message,
          code: error.code || null
        });
      }
    });

    this.app.get('/api/media-generation/tasks/unresolved', protect, async (req, res) => {
      try {
        const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 100));
        const tasks = await this.db.listUnresolvedMediaGenerationTasks(limit);
        return res.json({
          success: true,
          tasks: tasks.map(task => ({
            id: task.id,
            jobId: task.job_id,
            productionId: task.production_id,
            sceneIndex: task.scene_index,
            provider: task.provider,
            model: task.model,
            status: task.status,
            externalTaskId: task.external_task_id,
            providerTaskType: task.providerData?.taskType || null,
            updatedAt: task.updated_at,
            error: task.error
          }))
        });
      } catch (error) {
        return res.status(error.status || 500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/media-generation/tasks/:taskId/reconcile', protect, async (req, res) => {
      try {
        const mediaGeneration = this.agents.production?.aiVideoGenerator?.mediaGeneration;
        if (!mediaGeneration) {
          return res.status(503).json({ success: false, error: 'Media generation service is not initialized' });
        }
        const task = await mediaGeneration.reconcileTaskSubmission(
          req.params.taskId,
          req.body?.externalTaskId,
          { providerTaskType: req.body?.providerTaskType }
        );
        return res.json({
          success: true,
          task: {
            id: task.id,
            jobId: task.job_id,
            productionId: task.production_id,
            sceneIndex: task.scene_index,
            provider: task.provider,
            model: task.model,
            status: task.status,
            externalTaskId: task.external_task_id,
            providerTaskType: task.providerData?.taskType || null,
            updatedAt: task.updated_at,
            error: task.error
          }
        });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/media-generation/tasks/:taskId/resolve-no-task', protect, async (req, res) => {
      try {
        const mediaGeneration = this.agents.production?.aiVideoGenerator?.mediaGeneration;
        if (!mediaGeneration) {
          return res.status(503).json({ success: false, error: 'Media generation service is not initialized' });
        }
        const task = await mediaGeneration.resolveAmbiguousSubmissionAsAbsent(
          req.params.taskId,
          req.body?.confirmedNoRemoteTask
        );
        return res.json({
          success: true,
          task: {
            id: task.id,
            jobId: task.job_id,
            productionId: task.production_id,
            sceneIndex: task.scene_index,
            provider: task.provider,
            model: task.model,
            status: task.status,
            externalTaskId: task.external_task_id,
            updatedAt: task.updated_at,
            error: task.error
          }
        });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message });
      }
    });

    this.app.get('/api/script-quality-reviews', protect, async (req, res) => {
      try {
        const status = ['pending', 'human_approved', 'rejected', 'revision_requested', 'all'].includes(req.query.status)
          ? req.query.status
          : 'pending';
        const reviews = await this.db.listScriptQualityReviews(status, Number(req.query.limit) || 50);
        return res.json({ success: true, reviews });
      } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/script-quality-reviews/:reviewId/revise', protect, async (req, res) => {
      try {
        const draft = typeof req.body?.draft === 'string' ? req.body.draft.trim() : '';
        if (!draft || draft.length > 100000) {
          return res.status(400).json({ success: false, error: 'Revised draft must contain 1 to 100000 characters' });
        }
        const existing = await this.db.getScriptQualityReview(req.params.reviewId);
        if (!existing) return res.status(404).json({ success: false, error: 'Quality review not found' });
        if (!['pending', 'revision_requested'].includes(existing.status)) {
          return res.status(409).json({ success: false, error: 'Only open quality reviews can be revised' });
        }
        const pipeline = this.agents.scriptWriter?.qualityPipeline;
        if (!pipeline?.enabled) {
          return res.status(503).json({ success: false, error: 'Enable the local quality pipeline before re-reviewing drafts' });
        }
        const reviews = await pipeline.reviewDraft(draft);
        const reviewerResults = Object.values(reviews);
        const score = reviewerResults.length
          ? Math.min(...reviewerResults.map(result => Number(result.score)))
          : 0;
        const blockers = reviewerResults.flatMap(result => result.blockers || []);
        const approved = reviewerResults.length > 0 &&
          reviewerResults.every(result => result.approved === true && Number(result.score) >= pipeline.minimumScore) &&
          blockers.length === 0;
        const qualityReport = {
          status: approved ? 'awaiting_human_approval' : 'human_review_required',
          score,
          minimumScore: pipeline.minimumScore,
          revisions: Number(existing.quality_report?.revisions || 0) + 1,
          reviewers: Object.keys(reviews),
          remoteReviewEnabled: pipeline.allowRemoteReview,
          attempts: [{ revision: Number(existing.quality_report?.revisions || 0) + 1, score, reviewers: reviews, approved }]
        };
        const review = await this.db.updateScriptQualityReviewDraft(req.params.reviewId, draft, qualityReport);
        return res.json({ success: true, review, automatedReviewPassed: approved, humanDecisionRequired: true });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/script-quality-reviews/:reviewId/continue', protect, async (req, res) => {
      try {
        const result = await this.continueApprovedScriptReview(req.params.reviewId);
        return res.status(202).json({ success: true, result, message: 'Production resumed using the saved human-approved script. Publishing remains disabled.' });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.post('/api/script-quality-reviews/:reviewId/decision', protect, async (req, res) => {
      try {
        const decision = req.body?.decision;
        if (!['human_approved', 'rejected', 'revision_requested'].includes(decision)) {
          return res.status(400).json({ success: false, error: 'Decision must be human_approved, rejected, or revision_requested' });
        }
        const review = await this.db.decideScriptQualityReview(
          req.params.reviewId,
          decision,
          req.body?.notes || ''
        );
        if (!review) return res.status(404).json({ success: false, error: 'Quality review not found' });
        return res.json({ success: true, review });
      } catch (error) {
        return res.status(400).json({ success: false, error: error.message });
      }
    });

    this.app.get('/api/dashboard', async (_req, res) => {
      try {
        const [stats, jobs, pipeline, schedule, events, notifications, profile, settings, ideas, analytics, learning, activation, channelStrategy, operatorRuns, readiness, engagement, experiments] = await Promise.all([
          this.db.getStats(),
          this.db.listGenerationJobs(20),
          this.db.getPipelineOverview(50),
          this.db.getUpcomingSchedule(30),
          this.db.getRecentAutomationEvents(20),
          this.db.listNotifications(20),
          this.db.getChannelProfile(),
          this.db.getAllSettings(),
          this.db.listContentIdeas(),
          this.agents.analytics
            ? this.agents.analytics.getRecentAnalytics(30)
            : Promise.resolve({ totalVideos: 0, averagePerformanceScore: 0, topPerformers: [], insights: [] }),
          this.agents.analytics?.getLearningSummary
            ? this.agents.analytics.getLearningSummary()
            : Promise.resolve({ measuredVideos: 0, snapshotCount: 0, baseline: {}, recommendations: [], approvedCount: 0, pendingCount: 0 }),
          this.activation
            ? this.activation.getSummary()
            : Promise.resolve({ privacy: 'local-only', counts: {}, milestones: {} }),
          this.db.getChannelStrategy(),
          this.db.listOperatorRuns(10),
          this.readiness
            ? this.readiness.getSummary()
            : Promise.resolve({ status: 'unverified', stale: false, blockingFailures: [], checks: [] }),
          this.engagement
            ? this.engagement.getSummary()
            : Promise.resolve({
                videosTracked: 0, pendingDrafts: 0, postedToday: 0, needsAttentionCount: 0,
                pendingAudienceIdeas: 0, postingEnabled: false, postingDisabledReason: 'setup_required',
                insights: [], recentThemes: [],
                evidencePolicy: 'Comments are fetched read-only from YouTube. Replies post only after operator approval, and fallback analysis never proposes drafts or ideas.'
              }),
          this.experiments
            ? this.experiments.getSummary()
            : Promise.resolve({ experiments: [], candidates: [], activeCount: 0, awaitingDecisionCount: 0, evidencePolicy: 'Finish setup to create a controlled growth experiment.' })
        ]);
        if (this.telemetry) void this.telemetry.sync(activation);
        res.json({
          stats, jobs, pipeline, schedule, events, notifications, profile, settings, ideas, analytics, learning, activation,
          channelStrategy, operatorRuns, readiness, engagement, experiments,
          system: {
            version,
            initialized: this.isInitialized,
            setupRequired: this.setupRequired,
            uptime: process.uptime(),
            activeJobs: this.activeJobs.size,
            automationPaused: this.scheduler ? !this.scheduler.isEnabled : true,
            agents: Object.keys(this.agents),
            autonomousRunning: Boolean(await this.db.getActiveOperatorRun()),
            videoProviders: this.agents.production?.aiVideoGenerator?.mediaGeneration?.listProviders() || []
          }
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get('/api/jobs/:jobId', async (req, res) => {
      const job = await this.db.getGenerationJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: 'Job not found' });
      job.checkpoints = await this.db.listGenerationCheckpoints(job.id);
      job.mediaTasks = await this.db.listMediaGenerationTasks(job.id);
      job.resumeFrom = this.recovery?.resumePoint(job.checkpoints);
      return res.json(job);
    });

    this.app.post('/api/jobs/:jobId/resume', protect, async (req, res) => {
      try {
        const result = await this.resumeGenerationJob(req.params.jobId, { stage: req.body?.stage });
        return res.status(202).json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message });
      }
    });

    this.app.get('/api/readiness', async (_req, res) => {
      if (!this.readiness) return res.status(503).json({ error: 'Readiness service is not initialized' });
      return res.json(await this.readiness.getSummary());
    });

    this.app.post('/api/readiness/run', protect, async (req, res) => {
      try {
        if (!this.readiness) return res.status(503).json({ error: 'Readiness service is not initialized' });
        const result = await this.readiness.run({
          includePaidMedia: req.body?.includePaidMedia === true,
          includePaidVideo: req.body?.includePaidVideo === true
        });
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/jobs/:jobId/cancel', protect, async (req, res) => {
      const job = await this.db.getGenerationJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: 'Job not found' });
      if (!['queued', 'running'].includes(job.status)) {
        return res.status(409).json({ error: 'Only queued or running jobs can be cancelled' });
      }
      const updated = await this.db.updateGenerationJob(job.id, { cancelRequested: true, details: { cancelReason: req.body?.reason || 'Cancelled by operator' } });
      return res.json({ success: true, result: updated });
    });

    this.app.get('/api/content/:productionId', async (req, res) => {
      let bundle = await this.db.getProductionBundle(req.params.productionId);
      if (!bundle) return res.status(404).json({ error: 'Content not found' });
      if (this.scenes && !bundle.scenes?.length) {
        await this.scenes.ensureManifest(bundle);
        bundle = await this.db.getProductionBundle(req.params.productionId);
      }
      return res.json(this.decorateContentBundle(bundle));
    });

    this.app.get('/api/content/:productionId/scenes/:sceneId/estimate', async (req, res) => {
      try {
        if (!this.scenes) return res.status(503).json({ error: 'Scene repair requires completed setup' });
        const result = await this.scenes.regenerationEstimate(req.params.productionId, req.params.sceneId, {
          provider: req.query.provider
        });
        return res.json(result);
      } catch (error) {
        return res.status(error.status || 400).json({ error: error.message, code: error.code, details: error.details });
      }
    });

    this.app.patch('/api/content/:productionId/scenes/:sceneId', protect, async (req, res) => {
      try {
        if (!this.scenes) return res.status(503).json({ error: 'Scene repair requires completed setup' });
        const result = await this.runSceneEditWithReview(
          req.params.productionId,
          assertLease => this.scenes.updateSceneUnlocked(req.params.productionId, req.params.sceneId, req.body || {}, assertLease),
          'Scene changes require review before scheduling',
          'scene edit and review invalidation'
        );
        return res.json({ success: true, result: this.scenes.decorateScene(result, req.params.productionId) });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code, details: error.details });
      }
    });

    this.app.post('/api/content/:productionId/scenes/reorder', protect, async (req, res) => {
      try {
        if (!this.scenes) return res.status(503).json({ error: 'Scene repair requires completed setup' });
        const result = await this.runSceneEditWithReview(
          req.params.productionId,
          assertLease => this.scenes.reorderUnlocked(req.params.productionId, req.body?.sceneIds, assertLease),
          'Timeline order changed; rebuild and review before scheduling',
          'scene reorder and review invalidation'
        );
        return res.json({ success: true, result: result.map(scene => this.scenes.decorateScene(scene, req.params.productionId)) });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code, details: error.details });
      }
    });

    this.app.post('/api/content/:productionId/scenes/:sceneId/regenerate', protect, async (req, res) => {
      try {
        if (!this.scenes) return res.status(503).json({ error: 'Scene repair requires completed setup' });
        const result = await this.runSceneEditWithReview(
          req.params.productionId,
          assertLease => this.scenes.regenerateUnlocked(req.params.productionId, req.params.sceneId, req.body || {}, assertLease),
          'Regenerated scene must be rebuilt and reviewed',
          'scene regeneration and review invalidation'
        );
        return res.status(202).json({ success: true, result: {
          ...result,
          scene: this.scenes.decorateScene(result.scene, req.params.productionId)
        } });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code, details: error.details });
      }
    });

    this.app.post('/api/content/:productionId/shorts/propose', protect, async (req, res) => {
      try {
        if (!this.shorts) return res.status(503).json({ error: 'Shorts repurposing requires completed setup' });
        const result = await this.shorts.propose(req.params.productionId, req.body || {});
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.patch('/api/content/:productionId/shorts/:clipId', protect, async (req, res) => {
      try {
        if (!this.shorts) return res.status(503).json({ error: 'Shorts repurposing requires completed setup' });
        if (typeof this.scenes?.withProductionOperationLease !== 'function') {
          return res.status(503).json({ error: 'Production operation lease is required to edit Shorts safely' });
        }
        const result = await this.scenes.withProductionOperationLease(
          req.params.productionId,
          assertLease => this.shorts.update(req.params.productionId, req.params.clipId, req.body || {}, { assertLease }),
          'Short edit'
        );
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.post('/api/content/:productionId/shorts/:clipId/render', protect, async (req, res) => {
      try {
        if (!this.shorts) return res.status(503).json({ error: 'Shorts repurposing requires completed setup' });
        const result = await this.renderShortClip(req.params.productionId, req.params.clipId);
        return res.status(202).json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.post('/api/content/:productionId/shorts/:clipId/approve', protect, async (req, res) => {
      try {
        if (!this.shorts) return res.status(503).json({ error: 'Shorts repurposing requires completed setup' });
        const result = await this.approveShortClip(req.params.productionId, req.params.clipId, req.body || {});
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.get('/api/content/:productionId/shorts/:clipId/asset/:kind', async (req, res) => {
      try {
        const clip = await this.db.getShortClip(req.params.clipId);
        if (!clip || clip.productionId !== req.params.productionId) return res.status(404).json({ error: 'Short asset not found' });
        const filePath = req.params.kind === 'video' ? clip.outputPath : req.params.kind === 'captions' ? clip.captionsPath : null;
        if (!filePath) return res.status(404).json({ error: 'Short asset not found' });
        const resolved = path.resolve(filePath);
        const shortsRoot = path.resolve(__dirname, 'data', 'shorts');
        if (!resolved.startsWith(`${shortsRoot}${path.sep}`)) return res.status(403).json({ error: 'Short asset path is not allowed' });
        await fs.access(resolved);
        return res.sendFile(resolved);
      } catch (_error) {
        return res.status(404).json({ error: 'Short asset not found' });
      }
    });

    this.app.post('/api/content/:productionId/scenes/:sceneId/narration', protect, async (req, res) => {
      try {
        if (!this.scenes) return res.status(503).json({ error: 'Narration recovery requires completed setup' });
        const result = await this.scenes.regenerateNarration(req.params.productionId, req.params.sceneId, req.body || {});
        await this.refreshContentReview(req.params.productionId, 'Narration regenerated; rebuild the final video before approval');
        return res.status(202).json({ success: true, result: this.scenes.decorateScene(result, req.params.productionId) });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code, details: error.details });
      }
    });

    this.app.post('/api/content/:productionId/narration/silence', protect, async (req, res) => {
      try {
        if (!this.scenes) return res.status(503).json({ error: 'Narration recovery requires completed setup' });
        const result = await this.scenes.setSilenceOverride(req.params.productionId, req.body || {});
        await this.refreshContentReview(
          req.params.productionId,
          result.enabled ? 'Intentional silence recorded; rebuild and review before approval' : 'Narration is required again; regenerate it before approval'
        );
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code, details: error.details });
      }
    });

    this.app.put(
      '/api/content/:productionId/scenes/:sceneId/asset',
      protect,
      express.raw({ type: ['image/*', 'video/*'], limit: '100mb' }),
      async (req, res) => {
        try {
          if (!this.scenes) return res.status(503).json({ error: 'Scene repair requires completed setup' });
          const result = await this.scenes.replaceAsset(req.params.productionId, req.params.sceneId, {
            buffer: req.body,
            contentType: req.get('content-type'),
            filename: req.get('x-file-name'),
            rightsConfirmed: req.get('x-rights-confirmed') === 'true',
            containsSyntheticMedia: req.get('x-synthetic-media') === 'true'
          });
          await this.refreshContentReview(req.params.productionId, 'Replacement scene asset must be rebuilt and reviewed');
          return res.json({ success: true, result: this.scenes.decorateScene(result, req.params.productionId) });
        } catch (error) {
          return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code, details: error.details });
        }
      }
    );

    this.app.post('/api/content/:productionId/scenes/rebuild', protect, async (req, res) => {
      try {
        if (!this.scenes) return res.status(503).json({ error: 'Scene repair requires completed setup' });
        const result = await this.scenes.rebuild(req.params.productionId);
        await this.refreshContentReview(req.params.productionId, 'Scene repair rebuilt; final approval is required');
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code, details: error.details });
      }
    });

    this.app.get('/api/content/:productionId/scenes/:sceneId/asset', async (req, res) => {
      try {
        const scene = await this.db.getProductionScene(req.params.productionId, req.params.sceneId);
        if (!scene?.assetPath) return res.status(404).json({ error: 'Scene asset not found' });
        const resolved = path.resolve(scene.assetPath);
        const dataRoot = path.resolve(__dirname, 'data');
        if (!resolved.startsWith(`${dataRoot}${path.sep}`)) return res.status(403).json({ error: 'Scene asset path is not allowed' });
        await fs.access(resolved);
        return res.sendFile(resolved);
      } catch (_error) {
        return res.status(404).json({ error: 'Scene asset not found' });
      }
    });

    this.app.patch('/api/content/:productionId', protect, async (req, res) => {
      try {
        const bundle = await this.db.getProductionBundle(req.params.productionId);
        if (!bundle) return res.status(404).json({ error: 'Content not found' });
        if (bundle.review_status === 'approved' && bundle.schedule?.status === 'published') {
          return res.status(409).json({ error: 'Published content cannot be edited here' });
        }
        if (typeof this.scenes?.withProductionOperationLease !== 'function') {
          return res.status(503).json({ error: 'Production operation lock is required for safe content edits' });
        }
        const result = await this.scenes.withProductionOperationLease(bundle.id, async assertLease => {
          await assertLease();
          const current = await this.db.getProductionBundle(bundle.id);
          if (!current) return null;
          if (current.schedule?.status === 'published' ||
              current.schedule?.youtubeId ||
              ['uploading', 'uploaded', 'reconciliation_required'].includes(current.schedule?.status)) {
            return { conflict: true };
          }
          const editorData = this.validateEditorData(req.body, current.editorData);
          await assertLease();
          return this.db.saveContentReview(
            current.id,
            buildContentReviewAfterEdit(current, editorData, req.body.reviewNotes),
            assertLease.lease
          );
        }, 'content edit');
        if (result?.conflict) return res.status(409).json({ error: 'Content with a published or unresolved upload cannot be edited' });
        return res.json({ success: true, result: this.decorateContentBundle(result) });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.post('/api/content/:productionId/approve', protect, async (req, res) => {
      try {
        const result = await this.approveContent(req.params.productionId, req.body || {});
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, quality: error.quality });
      }
    });

    this.app.post('/api/content/:productionId/reject', protect, async (req, res) => {
      try {
        const bundle = await this.db.getProductionBundle(req.params.productionId);
        if (!bundle) return res.status(404).json({ error: 'Content not found' });
        if (typeof this.scenes?.withProductionOperationLease !== 'function') {
          return res.status(503).json({ error: 'Production operation lock is required for safe review changes' });
        }
        const result = await this.scenes.withProductionOperationLease(bundle.id, async assertLease => {
          await assertLease();
          const current = await this.db.getProductionBundle(bundle.id);
          if (!current) return { missing: true };
          if (current.schedule?.youtubeId ||
              ['uploading', 'uploaded', 'published', 'reconciliation_required'].includes(current.schedule?.status)) {
            return { conflict: true };
          }
          await this.db.saveContentReview(bundle.id, {
            status: 'rejected',
            editorData: current.editorData,
            qualityChecks: current.qualityChecks,
            reviewNotes: req.body?.notes || 'Rejected by operator',
            reviewedAt: new Date().toISOString()
          }, assertLease.lease);
          await this.db.updateProductionStatus(bundle.id, 'rejected', assertLease.lease);
          return { rejected: true };
        }, 'content rejection');
        if (result?.missing) return res.status(404).json({ error: 'Content not found' });
        if (result?.conflict) return res.status(409).json({ error: 'Content with a published or unresolved upload cannot be rejected' });
        return res.json({ success: true });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.post('/api/content/:productionId/retry', protect, async (req, res) => {
      const bundle = await this.db.getProductionBundle(req.params.productionId);
      if (!bundle) return res.status(404).json({ error: 'Content not found' });
      const approvedConceptId = bundle.strategy?.approvedVideoConceptId;
      if (!approvedConceptId) {
        return res.status(409).json({ success: false, code: 'APPROVED_CONCEPT_REQUIRED', error: 'This production has no approved concept linked to it. Create and approve a concept before retrying.' });
      }
      try {
        if (
          bundle.timeline?.productionWorkflow &&
          ['failed', 'processing'].includes(bundle.status) &&
          this.agents.production?.resumeProduction
        ) {
          const result = await this.agents.production.resumeProduction(req.params.productionId);
          return res.json({ success: true, resumed: true, result });
        }
        const job = await this.startGenerationJob({
          topic: bundle.strategy.topic || bundle.editorData.title || null,
          style: bundle.strategy.requestedStyle || bundle.strategy.contentType || null,
          length: bundle.strategy.requestedLengthKey || 'medium',
          source: 'retry',
          approvedConceptId
        });
        return res.status(202).json({ success: true, resumed: false, result: job });
      } catch (error) {
        return res.status(error.status || 500).json({ success: false, error: error.message, code: error.code || null });
      }
    });

    this.app.get('/api/content/:productionId/asset/:kind', async (req, res) => {
      try {
        const bundle = await this.db.getProductionBundle(req.params.productionId);
        if (!bundle) return res.status(404).json({ error: 'Content not found' });
        const allowed = {
          video: bundle.assets?.finalVideo?.path,
          thumbnail: bundle.assets?.thumbnail?.path,
          captions: bundle.assets?.captions?.path,
          script: bundle.assets?.script?.originalPath
        };
        const experimentMatch = req.params.kind.match(/^experiment-thumbnail-(\d+)$/);
        const experimentPath = experimentMatch
          ? bundle.editorData?.packagingExperiment?.thumbnailVariants?.[Number(experimentMatch[1])]?.path
          : null;
        const filePath = allowed[req.params.kind] || experimentPath;
        if (!filePath) return res.status(404).json({ error: 'Asset not found' });
        const resolved = path.resolve(filePath);
        const dataRoot = path.resolve(__dirname, 'data');
        const experimentRoot = path.resolve(__dirname, 'uploads', 'thumbnails');
        const allowedPath = [dataRoot, experimentRoot]
          .some(root => resolved.startsWith(`${root}${path.sep}`));
        if (!allowedPath) return res.status(403).json({ error: 'Asset path is not allowed' });
        await fs.access(resolved);
        return res.sendFile(resolved);
      } catch (_error) {
        return res.status(404).json({ error: 'Asset not found' });
      }
    });

    this.app.put('/api/profile', protect, async (req, res) => {
      try {
        const profile = this.validateProfile(req.body || {});
        return res.json({ success: true, result: await this.db.saveChannelProfile(profile) });
      } catch (error) {
        return res.status(400).json({ success: false, error: error.message });
      }
    });

    this.app.put('/api/operator/strategy', protect, async (req, res) => {
      try {
        const current = await this.db.getChannelStrategy() || {};
        const strategy = this.validateChannelStrategy(req.body || {}, current);
        return res.json({ success: true, result: await this.db.saveChannelStrategy(strategy) });
      } catch (error) {
        return res.status(400).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/operator/start', protect, async (req, res) => {
      try {
        if (this.setupRequired || !this.agents.strategy) {
          return res.status(503).json({ success: false, error: 'Finish setup with npm run walkthrough before activating the autonomous operator' });
        }
        if (this.activeJobs.size) {
          return res.status(409).json({ success: false, error: 'Wait for the current generation job to finish before starting an autonomous run' });
        }
        await this.readiness?.assertReady('Autonomous production');
        const current = await this.db.getChannelStrategy() || {};
        const strategy = this.validateChannelStrategy({ ...(req.body || {}), status: 'active' }, current);
        const saved = await this.db.saveChannelStrategy(strategy);
        const run = await this.autonomous.start(saved);
        return res.status(202).json({ success: true, result: run });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/operator/pause', protect, async (_req, res) => {
      const strategy = await this.db.getChannelStrategy();
      if (!strategy) return res.status(404).json({ error: 'Channel strategy not found' });
      const active = await this.db.getActiveOperatorRun();
      if (active) await this.autonomous.cancel(active.id);
      const saved = await this.db.saveChannelStrategy({ ...strategy, status: 'paused' });
      return res.json({ success: true, result: saved });
    });

    this.app.post('/api/operator/runs/:runId/cancel', protect, async (req, res) => {
      const run = await this.autonomous.cancel(req.params.runId);
      if (!run) return res.status(404).json({ error: 'Operator run not found' });
      return res.json({ success: true, result: run });
    });

    this.app.put('/api/content/:productionId/provenance', protect, async (req, res) => {
      try {
        const bundle = await this.db.getProductionBundle(req.params.productionId);
        if (!bundle) return res.status(404).json({ error: 'Content not found' });
        if (bundle.review_status === 'approved' || bundle.schedule) {
          return res.status(409).json({ error: 'Provenance is locked after content is approved or scheduled' });
        }
        if (!this.provenance) this.provenance = new ProvenanceService(this.db);
        await this.provenance.review(bundle.id, req.body || {});
        const updated = await this.db.getProductionBundle(bundle.id);
        const profile = await this.db.getChannelProfile() || {};
        const quality = await this.operator.runQualityChecks({
          ...updated,
          scheduledPublishTime: updated.scheduled_publish_time
        }, profile);
        const reviewStatus = quality.passed ? 'needs_review' : 'needs_attention';
        const result = await this.db.saveContentReview(bundle.id, {
          status: reviewStatus,
          editorData: updated.editorData,
          qualityChecks: quality.checks,
          reviewNotes: quality.passed ? null : `Blocking checks failed: ${quality.blockingFailures.join(', ')}`,
          reviewedAt: null
        });
        return res.json({ success: true, result: this.decorateContentBundle(result) });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/operator/runs/:runId/resume', protect, async (req, res) => {
      try {
        if (this.setupRequired || !this.agents.strategy) {
          return res.status(503).json({ success: false, error: 'Finish setup before resuming the autonomous operator' });
        }
        await this.readiness?.assertReady('Autonomous production recovery');
        const strategy = await this.db.getChannelStrategy();
        const run = await this.autonomous.resume(req.params.runId, strategy);
        return res.status(202).json({ success: true, result: run });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/learning/recommendations/:recommendationId/:action', protect, async (req, res) => {
      const { recommendationId, action } = req.params;
      if (!['approve', 'reject'].includes(action)) {
        return res.status(400).json({ error: 'Action must be approve or reject' });
      }
      const status = action === 'approve' ? 'approved' : 'rejected';
      const recommendation = await this.db.reviewLearningRecommendation(recommendationId, status);
      if (!recommendation) return res.status(404).json({ error: 'Learning recommendation not found' });
      await this.operator.notify({
        type: 'learning_recommendation_reviewed',
        level: action === 'approve' ? 'success' : 'info',
        title: action === 'approve' ? 'Channel learning approved' : 'Channel learning rejected',
        message: recommendation.title,
        data: { recommendationId, status }
      });
      return res.json({ success: true, result: recommendation });
    });

    this.app.post('/api/content/:productionId/discoverability/run', protect, async (req, res) => {
      try {
        const bundle = await this.db.getProductionBundle(req.params.productionId);
        if (!bundle) return res.status(404).json({ success: false, error: 'Content not found' });
        const profile = await this.db.getChannelProfile() || {};
        const audit = await this.discoverability.auditProduction(bundle, profile, req.body?.platform || 'youtube');
        if (bundle.review_status !== 'approved' && !bundle.schedule) {
          const updated = await this.db.getProductionBundle(bundle.id);
          const quality = await this.operator.runQualityChecks({
            ...updated,
            scheduledPublishTime: updated.scheduled_publish_time
          }, profile);
          await this.db.saveContentReview(bundle.id, {
            status: quality.passed ? 'needs_review' : 'needs_attention',
            editorData: updated.editorData,
            qualityChecks: quality.checks,
            reviewNotes: quality.passed ? null : `Blocking checks failed: ${quality.blockingFailures.join(', ')}`,
            reviewedAt: null
          });
        }
        const result = await this.db.getProductionBundle(bundle.id);
        return res.json({ success: true, result: this.decorateContentBundle(result), audit });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message });
      }
    });

    this.app.patch('/api/content/:productionId/schedule', protect, async (req, res) => {
      try {
        if (!this.agents.publishing) return res.status(503).json({ error: 'Publishing requires completed setup' });
        const result = await this.agents.publishing.rescheduleContent(req.params.productionId, req.body?.publishTime);
        await this.db.updateProductionStatus(req.params.productionId, 'scheduled');
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.post('/api/content/:productionId/publish-now', protect, async (req, res) => {
      try {
        if (!this.agents.publishing) return res.status(503).json({ error: 'Publishing requires completed setup' });
        const result = await this.agents.publishing.emergencyPublish(req.params.productionId);
        await this.db.updateProductionStatus(req.params.productionId, result.status);
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.post('/api/content/:productionId/retry-thumbnail', protect, async (req, res) => {
      try {
        if (!this.agents.publishing) return res.status(503).json({ error: 'YouTube publishing is not configured' });
        const result = await this.agents.publishing.retryThumbnailUpload(req.params.productionId);
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 500).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.post('/api/content/:productionId/retry-captions', protect, async (req, res) => {
      try {
        if (!this.agents.publishing) return res.status(503).json({ error: 'YouTube publishing is not configured' });
        const result = await this.agents.publishing.retryCaptionUpload(req.params.productionId);
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 500).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.delete('/api/content/:productionId/schedule', protect, async (req, res) => {
      try {
        if (!this.agents.publishing) return res.status(503).json({ error: 'Publishing requires completed setup' });
        const result = await this.agents.publishing.deleteScheduledContent(req.params.productionId);
        await this.db.updateProductionStatus(req.params.productionId, 'approved');
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.patch('/api/discoverability/findings/:findingId', protect, async (req, res) => {
      try {
        const finding = await this.discoverability.reviewFinding(req.params.findingId, req.body || {});
        const audit = await this.db.getLatestDiscoverabilityAudit(finding.production_id, finding.platform);
        return res.json({ success: true, result: { finding, audit } });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message });
      }
    });

    this.app.get('/api/experiments', async (_req, res) => {
      try {
        const summary = this.experiments
          ? await this.experiments.getSummary()
          : { experiments: [], candidates: [], activeCount: 0, awaitingDecisionCount: 0 };
        return res.json({ success: true, result: summary });
      } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/experiments', protect, async (req, res) => {
      try {
        if (!this.experiments) return res.status(503).json({ error: 'Finish setup before creating experiments' });
        const experiment = await this.experiments.create(req.body || {});
        return res.status(201).json({ success: true, result: experiment });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.post('/api/experiments/:experimentId/:action', protect, async (req, res) => {
      try {
        if (!this.experiments) return res.status(503).json({ error: 'Finish setup before controlling experiments' });
        const actions = {
          approve: () => this.experiments.approve(req.params.experimentId, req.body),
          start: () => this.experiments.start(req.params.experimentId, req.body),
          refresh: () => this.experiments.refresh(req.params.experimentId),
          adopt: () => this.experiments.adoptWinner(req.params.experimentId, req.body),
          cancel: () => this.experiments.cancel(req.params.experimentId, req.body)
        };
        if (!actions[req.params.action]) return res.status(400).json({ error: 'Unsupported experiment action' });
        const experiment = await actions[req.params.action]();
        await this.operator.notify({
          type: 'growth_experiment_updated',
          level: ['adopt', 'approve'].includes(req.params.action) ? 'success' : 'info',
          title: `Growth experiment ${req.params.action}`,
          message: experiment.title,
          data: { experimentId: experiment.id, status: experiment.status }
        });
        return res.json({ success: true, result: experiment });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.get('/api/retention/:videoId', async (req, res) => {
      const videoId = String(req.params.videoId || '').trim();
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(videoId)) {
        return res.status(400).json({ error: 'A valid YouTube video ID is required' });
      }
      const snapshots = await this.db.listRetentionSnapshots({ videoId, limit: 10 });
      return res.json({ success: true, result: snapshots });
    });

    this.app.post('/api/retention/:videoId/refresh', protect, async (req, res) => {
      try {
        const videoId = String(req.params.videoId || '').trim();
        const measurementWindow = String(req.body?.measurementWindow || 'rolling');
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(videoId)) {
          return res.status(400).json({ error: 'A valid YouTube video ID is required' });
        }
        if (!['24h', '7d', 'rolling'].includes(measurementWindow)) {
          return res.status(400).json({ error: 'Measurement window must be 24h, 7d, or rolling' });
        }
        if (!this.agents.analytics) {
          return res.status(503).json({ error: 'YouTube Analytics is not initialized' });
        }
        const report = await this.agents.analytics.analyzeVideoPerformance(videoId, { measurementWindow });
        return res.json({
          success: true,
          result: report.retentionSnapshot || null,
          retention: report.retention
        });
      } catch (error) {
        return res.status(error.status || 400).json({ error: error.message });
      }
    });

    const ENGAGEMENT_VIDEO_ID = /^[A-Za-z0-9_-]{1,100}$/;

    this.app.get('/api/engagement/:videoId', async (req, res) => {
      try {
        const videoId = String(req.params.videoId || '').trim();
        if (!ENGAGEMENT_VIDEO_ID.test(videoId)) {
          return res.status(400).json({ error: 'A valid YouTube video ID is required' });
        }
        const [insight, comments, drafts] = await Promise.all([
          this.db.getEngagementInsight(videoId),
          this.db.listAudienceComments({ videoId, limit: 200 }),
          this.db.listReplyDrafts({ videoId, limit: 100 })
        ]);
        return res.json({ success: true, result: { insight, comments, drafts } });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/engagement/:videoId/sync', protect, async (req, res) => {
      try {
        if (!this.engagement) return res.status(503).json({ error: 'Audience engagement requires completed setup' });
        const videoId = String(req.params.videoId || '').trim();
        if (!ENGAGEMENT_VIDEO_ID.test(videoId)) {
          return res.status(400).json({ error: 'A valid YouTube video ID is required' });
        }
        const sync = await this.engagement.syncVideoComments(videoId, req.body || {});
        const insight = sync.fetched > 0 || req.body?.analyze === true
          ? await this.engagement.analyzeVideo(videoId)
          : sync.insight;
        return res.status(202).json({ success: true, result: { ...sync, insight } });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.post('/api/engagement/:videoId/draft-replies', protect, async (req, res) => {
      try {
        if (!this.engagement) return res.status(503).json({ error: 'Audience engagement requires completed setup' });
        const videoId = String(req.params.videoId || '').trim();
        if (!ENGAGEMENT_VIDEO_ID.test(videoId)) {
          return res.status(400).json({ error: 'A valid YouTube video ID is required' });
        }
        const result = await this.engagement.draftReplies(videoId, req.body || {});
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.patch('/api/engagement/replies/:draftId', protect, async (req, res) => {
      try {
        if (!this.engagement) return res.status(503).json({ error: 'Audience engagement requires completed setup' });
        const result = await this.engagement.updateReplyDraft(req.params.draftId, req.body || {});
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.post('/api/engagement/replies/:draftId/approve', protect, async (req, res) => {
      try {
        if (!this.engagement) return res.status(503).json({ error: 'Audience engagement requires completed setup' });
        const result = await this.engagement.approveReplyDraft(req.params.draftId, req.body || {});
        // The reply is already live on YouTube; a notification failure must not report an error.
        try {
          await this.operator.notify({
            type: 'audience_reply_posted',
            level: 'success',
            title: 'Audience reply posted',
            message: `A reply was posted on video ${result.videoId}`,
            data: { draftId: result.id, videoId: result.videoId, postedCommentId: result.postedCommentId }
          });
        } catch (notifyError) {
          this.logger.warn(`Posted reply notification failed: ${notifyError.message}`);
        }
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.post('/api/ideas', protect, async (req, res) => {
      const topic = String(req.body?.topic || '').trim();
      if (!topic || topic.length > 200) return res.status(400).json({ error: 'A topic of 200 characters or less is required' });
      const idea = await this.db.createContentIdea({ ...req.body, topic });
      return res.status(201).json({ success: true, result: idea });
    });

    this.app.patch('/api/ideas/:ideaId', protect, async (req, res) => {
      const idea = await this.db.updateContentIdea(req.params.ideaId, req.body || {});
      if (!idea) return res.status(404).json({ error: 'Idea not found' });
      return res.json({ success: true, result: idea });
    });

    this.app.post('/api/ideas/:ideaId/generate', protect, async (req, res) => {
      const idea = await this.db.getRow('SELECT * FROM content_ideas WHERE id = ?', [req.params.ideaId]);
      if (!idea) return res.status(404).json({ error: 'Idea not found' });
      const approvedConceptId = req.body?.approvedConceptId;
      if (!approvedConceptId) {
        return res.status(409).json({ success: false, code: 'APPROVED_CONCEPT_REQUIRED', error: 'Approve a video concept in Video Concept Studio before generating this idea.' });
      }
      try {
        const job = await this.startGenerationJob({ topic: idea.topic, style: idea.style, length: req.body?.length || 'medium', source: 'idea', approvedConceptId });
        await this.db.updateContentIdea(idea.id, { status: 'generated' });
        return res.status(202).json({ success: true, result: job });
      } catch (error) {
        return res.status(error.status || 500).json({ success: false, error: error.message, code: error.code || null });
      }
    });

    this.app.post('/api/automation/:action', protect, async (req, res) => {
      if (!this.scheduler) return res.status(409).json({ error: 'Finish setup before controlling automation' });
      const { action } = req.params;
      if (action === 'pause') {
        await this.scheduler.pauseAutomation();
        await this.db.setSetting('automation_paused', 'true');
      } else if (action === 'resume') {
        await this.scheduler.resumeAutomation();
        await this.db.setSetting('automation_paused', 'false');
      } else {
        return res.status(400).json({ error: 'Action must be pause or resume' });
      }
      return res.json({ success: true, paused: !this.scheduler.isEnabled });
    });

    this.app.put('/api/settings', protect, async (req, res) => {
      const allowed = ['approval_required', 'notification_enabled', 'channel_timezone', 'max_daily_posts', 'content_buffer_days'];
      for (const key of allowed) {
        if (req.body?.[key] !== undefined) await this.db.setSetting(key, String(req.body[key]));
      }
      const provider = req.body?.video_provider;
      if (provider !== undefined) {
        const supported = ['slideshow', 'cinecode', 'auto', 'seedance', 'minimax_h3', 'google_omni', 'kling', 'wan'];
        if (!supported.includes(provider)) return res.status(400).json({ error: 'Unsupported video provider' });
        await this.db.setSetting('video_provider', provider);
      }
      const mode = req.body?.video_generation_mode;
      if (mode !== undefined) {
        if (!['hybrid', 'slideshow'].includes(mode)) return res.status(400).json({ error: 'Unsupported video generation mode' });
        await this.db.setSetting('video_generation_mode', mode);
      }
      if (req.body?.video_clip_duration !== undefined) {
        const value = Number(req.body.video_clip_duration);
        if (!Number.isInteger(value) || value < 3 || value > 30) return res.status(400).json({ error: 'Clip duration must be between 3 and 30 seconds' });
        await this.db.setSetting('video_clip_duration', String(value));
      }
      if (req.body?.video_max_generated_seconds !== undefined) {
        const value = Number(req.body.video_max_generated_seconds);
        if (!Number.isInteger(value) || value < 0 || value > 600) return res.status(400).json({ error: 'Generated seconds cap must be between 0 and 600' });
        await this.db.setSetting('video_max_generated_seconds', String(value));
      }
      return res.json({ success: true, result: await this.db.getAllSettings() });
    });

    this.app.post('/api/notifications/:notificationId/read', protect, async (req, res) => {
      await this.db.markNotificationRead(req.params.notificationId);
      return res.json({ success: true });
    });
  }

  async startGenerationJob(input = {}) {
    if (this.setupRequired || !this.agents.strategy) {
      const error = new Error('Finish setup with npm run walkthrough before generating content');
      error.status = 503;
      throw error;
    }
    if (['scheduler', 'autonomous_operator'].includes(input.source)) {
      await this.readiness?.assertReady('Automated generation');
    }
    const maxConcurrent = Math.max(1, parseInt(process.env.MAX_CONCURRENT_JOBS || '1', 10));
    if (this.activeJobs.size >= maxConcurrent) {
      const error = new Error(`Generation is busy (${this.activeJobs.size}/${maxConcurrent} active jobs). Try again when the current job finishes.`);
      error.status = 429;
      throw error;
    }

    const validation = this.validateGenerateRequestBody(input);
    if (!validation.valid) {
      const error = new Error(validation.error);
      error.status = validation.status;
      throw error;
    }

    const requestedConceptId = input.approvedConceptId || input.approvedVideoConceptId || input.strategyContext?.approvedVideoConceptId;
    const approvedConcept = await requireApprovedVideoConcept(this.db, requestedConceptId);
    validation.value.strategyContext = {
      ...(validation.value.strategyContext || {}),
      approvedVideoConcept: approvedConcept.concept,
      approvedVideoConceptId: approvedConcept.id
    };

    const job = await this.db.createGenerationJob({
      ...validation.value,
      source: input.source || 'manual'
    });

    const work = this.runGenerationJob(job.id, validation.value)
      .catch(error => this.logger.error(`Generation job ${job.id} failed:`, error))
      .finally(() => this.activeJobs.delete(job.id));
    this.activeJobs.set(job.id, work);
    return job;
  }

  async continueApprovedScriptReview(reviewId) {
    const review = await this.db.getScriptQualityReview(reviewId);
    if (!review) {
      const error = new Error('Script quality review not found');
      error.status = 404;
      throw error;
    }
    if (review.status !== 'human_approved') {
      const error = new Error('Only a human-approved script draft can continue production');
      error.status = 409;
      throw error;
    }
    const jobId = review.job_id;
    if (!jobId) {
      const error = new Error('This review is not linked to a generation job');
      error.status = 409;
      throw error;
    }
    if (this.activeJobs.has(jobId)) {
      const error = new Error('This generation job is already running');
      error.status = 409;
      throw error;
    }

    const lease = await acquireGenerationJobLease(this.db, jobId);
    let transferred = false;
    try {
      await lease.assertLease();
      const currentReview = await this.db.getScriptQualityReview(reviewId);
      const job = await this.db.getGenerationJob(jobId);
      await lease.assertLease();
      if (!currentReview || currentReview.status !== 'human_approved') {
        const error = new Error('The linked script review is no longer human-approved');
        error.status = 409;
        throw error;
      }
      if (!job || !['failed', 'interrupted'].includes(job.status) || job.stage !== 'script') {
        const error = new Error('The linked job must be failed or interrupted at the script stage');
        error.status = 409;
        throw error;
      }

      const strategyCheckpoint = await this.db.getGenerationCheckpoint(jobId, 'strategy');
      await lease.assertLease();
      if (strategyCheckpoint?.status !== 'completed' || !strategyCheckpoint.artifact?.topic) {
        const error = new Error('The strategy checkpoint is missing; refusing to continue with an unlinked draft');
        error.status = 409;
        throw error;
      }
      let parsed;
      try {
        parsed = this.agents.scriptWriter.parseAIJsonResponse(currentReview.draft);
      } catch (_error) {
        const error = new Error('The saved draft is not valid JSON. Edit and re-review it before continuing.');
        error.status = 422;
        throw error;
      }
      const strategy = { ...strategyCheckpoint.artifact, ...(currentReview.strategy || {}), jobId };
      const writer = this.agents.scriptWriter;
      const sections = writer.normalizeAISections(parsed.sections, strategy);
      if (!parsed.title || String(parsed.title).trim().length > 100 || !parsed.hook ||
          !sections.length || !parsed.introduction || !parsed.conclusion) {
        const error = new Error('The approved draft is missing required title, hook, introduction, sections, or conclusion fields');
        error.status = 422;
        throw error;
      }
      const report = currentReview.quality_report || {};
      const script = {
        title: String(parsed.title).trim(),
        hook: writer.normalizeAIHook(parsed.hook),
        introduction: writer.normalizeAIIntroduction(parsed.introduction),
        mainContent: { sections, totalDuration: writer.calculateSectionsDuration(sections) },
        conclusion: writer.normalizeAIConclusion(parsed.conclusion),
        callToAction: writer.normalizeAICTA(parsed.cta, strategy),
        duration: writer.estimateDuration({ sections }),
        tone: writer.templates[(strategy.contentType || 'explainer').toLowerCase()]?.tone || 'informative',
        pacing: writer.templates[(strategy.contentType || 'explainer').toLowerCase()]?.pacing || 'steady',
        keywords: strategy.keywords || [],
        claims: writer.normalizeAIClaims(parsed.claims, strategy.researchSources || []),
        metadata: {
          strategy,
          generatedAt: new Date().toISOString(),
          version: '1.0',
          generationSource: 'human_approved_saved_draft',
          qualityGate: { ...report, status: 'human_review_required' },
          humanApproval: { reviewId: currentReview.id, decidedAt: currentReview.decided_at, notes: currentReview.decision_notes || '' }
        }
      };
      script.fullScript = writer.formatFullScript(script);
      if (!script.fullScript || script.fullScript.length < 100) {
        const error = new Error('The approved draft did not produce a usable full script');
        error.status = 422;
        throw error;
      }
      await lease.assertLease();
      await this.db.saveScript(script, lease.assertLease.lease || null);
      await lease.assertLease();
      await this.db.saveGenerationCheckpoint(jobId, 'script', {
        status: 'completed',
        artifact: script,
        error: null,
        completedAt: new Date().toISOString()
      }, lease.assertLease.lease || null);
      await lease.assertLease();
      await this.db.updateGenerationJob(jobId, {
        details: { approvedDraftReviewId: currentReview.id, approvedDraftAcceptedAt: new Date().toISOString() }
      }, lease.assertLease.lease || null);
      await lease.assertLease();
      const updated = await this.resumeGenerationJob(jobId, { forceHumanApproval: true }, lease);
      transferred = true;
      return updated;
    } finally {
      if (!transferred) await lease.release().catch(error => {
        this.logger.error('Failed to release script continuation lease:', error);
      });
    }
  }

  async resumeGenerationJob(jobId, options = {}, inheritedLease = null) {
    if (this.setupRequired || !this.agents.strategy) {
      const error = new Error('Finish setup with npm run walkthrough before resuming content generation');
      error.status = 503;
      throw error;
    }
    const lease = inheritedLease || await acquireGenerationJobLease(this.db, jobId);
    let transferred = false;
    try {
      await lease.assertLease();
      const job = await this.db.getGenerationJob(jobId);
      await lease.assertLease();
      if (!job) {
        const error = new Error('Generation job not found');
        error.status = 404;
        throw error;
      }
      if (!['failed', 'interrupted'].includes(job.status)) {
        const error = new Error('Only failed or interrupted generation jobs can be resumed');
        error.status = 409;
        throw error;
      }
      const linkedQualityReview = job.details?.qualityReviewId
        ? await this.db.getScriptQualityReview(job.details.qualityReviewId)
        : await this.db.getScriptQualityReviewByJobId(job.id);
      await lease.assertLease();
      if (linkedQualityReview) {
        const review = linkedQualityReview;
        if (review && ['pending', 'revision_requested'].includes(review.status)) {
          const error = new Error('This generation job is waiting for a human script-review decision. Resolve the saved draft in the Script review queue before retrying.');
          error.status = 409;
          error.code = 'SCRIPT_QUALITY_REVIEW_PENDING';
          error.qualityReviewId = review.id;
          throw error;
        }
        if (review && review.status === 'human_approved') {
          const approvedCheckpoint = await this.db.getGenerationCheckpoint(job.id, 'script');
          await lease.assertLease();
          const accepted = job.details?.approvedDraftReviewId === review.id &&
            approvedCheckpoint?.status === 'completed' &&
            approvedCheckpoint.artifact?.metadata?.humanApproval?.reviewId === review.id;
          if (!accepted) {
            const error = new Error('The human-approved draft must be explicitly accepted as the script checkpoint before resuming.');
            error.status = 409;
            error.code = 'APPROVED_DRAFT_CONTINUATION_REQUIRED';
            error.qualityReviewId = review.id;
            throw error;
          }
        }
      }
      const approvedConceptId = job.details?.strategyContext?.approvedVideoConceptId;
      await requireApprovedVideoConcept(this.db, approvedConceptId);
      await lease.assertLease();
      if (this.activeJobs.has(job.id)) {
        const error = new Error('This generation job is already running');
        error.status = 409;
        throw error;
      }
      const maxConcurrent = Math.max(1, parseInt(process.env.MAX_CONCURRENT_JOBS || '1', 10));
      if (this.activeJobs.size >= maxConcurrent) {
        const error = new Error(`Generation is busy (${this.activeJobs.size}/${maxConcurrent} active jobs). Try again when the current job finishes.`);
        error.status = 429;
        throw error;
      }
      if (['scheduler', 'autonomous_operator'].includes(job.source)) {
        await this.readiness?.assertReady('Automated generation recovery');
        await lease.assertLease();
      }

      if (!this.recovery) {
        this.recovery = new GenerationRecoveryService(this.db, {
          logger: this.logger,
          updateJobStage: (...args) => this.updateJobStage(...args)
        });
      }
      const checkpoints = await this.db.listGenerationCheckpoints(job.id);
      await lease.assertLease();
      const resumeFrom = options.stage || this.recovery.resumePoint(checkpoints);
      if (!GENERATION_STAGES.includes(resumeFrom)) {
        const error = new Error('Resume stage is not supported');
        error.status = 400;
        throw error;
      }
      if (options.stage) await this.recovery.resetFrom(job.id, resumeFrom, lease.assertLease);
      await lease.assertLease();
      const input = {
        topic: job.topic,
        style: job.style,
        length: job.length || 'medium',
        strategyContext: job.details?.strategyContext || {},
        forceHumanApproval: options.forceHumanApproval === true
      };
      const updated = await this.db.updateGenerationJob(job.id, {
        status: 'queued',
        stage: resumeFrom,
        error: null,
        cancelRequested: false,
        completedAt: null,
        details: {
          resumeCount: Number(job.details?.resumeCount || 0) + 1,
          resumeFrom,
          failedStage: null
        }
      }, lease.assertLease.lease || null);
      await lease.assertLease();
      const work = this.runGenerationJob(job.id, input, lease)
        .catch(error => this.logger.error(`Resumed generation job ${job.id} failed:`, error))
        .finally(() => this.activeJobs.delete(job.id));
      this.activeJobs.set(job.id, work);
      transferred = true;
      return updated;
    } finally {
      if (!transferred && !inheritedLease) {
        await lease.release().catch(error => {
          this.logger.error('Failed to release generation resume lease:', error);
        });
      }
    }
  }

  async waitForGenerationJob(jobId) {
    const work = this.activeJobs.get(jobId);
    if (work) await work;
    const job = await this.db.getGenerationJob(jobId);
    if (!job) throw new Error(`Generation job ${jobId} was not found after it ran`);
    return job;
  }

  async queueScheduledContent(input = {}) {
    const strategy = await this.db.getChannelStrategy();
    if (strategy?.status === 'active') {
      const weeklyOutput = await this.db.getRow(
        `SELECT COUNT(*) AS count FROM generation_jobs
         WHERE source = 'autonomous_operator' AND status = 'completed'
         AND created_at >= datetime('now', '-7 days')`
      );
      const remaining = Math.max(1, strategy.cadence_per_week - Number(weeklyOutput?.count || 0));
      return this.autonomous.start({
        ...strategy,
        approvedVideoConcept: input.approvedVideoConcept || null,
        approvedVideoConceptId: input.approvedVideoConceptId || null,
        videos_per_run: Math.min(strategy.videos_per_run, remaining)
      });
    }
    return this.startGenerationJob(input);
  }

  async runGenerationJob(jobId, input, inheritedLease = null) {
    const lease = inheritedLease || await acquireGenerationJobLease(this.db, jobId);
    try {
      return await this.runGenerationJobUnlocked(jobId, input, lease.assertLease);
    } finally {
      await lease.release().catch(error => {
        this.logger.error('Failed to release generation job lease:', error);
      });
    }
  }

  async runGenerationJobUnlocked(jobId, input, assertLease = async () => {}) {
    try {
      await assertLease();
      await this.db.updateGenerationJob(jobId, { status: 'running', progress: 2, error: null, completedAt: null }, assertLease.lease || null);
      await assertLease();
      const result = await this.generateContent(input.topic, input.style, input.length, {
        jobId,
        strategyContext: input.strategyContext,
        forceHumanApproval: input.forceHumanApproval === true,
        assertLease
      });
      await assertLease();
      await this.db.updateGenerationJob(jobId, {
        status: 'completed',
        stage: result.reviewStatus === 'approved' ? 'scheduled' : result.reviewStatus,
        progress: 100,
        productionId: result.contentId,
        title: result.title,
        details: { reviewStatus: result.reviewStatus, qualityScore: result.qualityScore },
        completedAt: new Date().toISOString()
      }, assertLease.lease || null);
      await assertLease();
      await this.db.setSetting('last_content_generation', new Date().toISOString());
      await assertLease();
      return result;
    } catch (error) {
      // Lease loss is not an ordinary job failure: a stale worker must not
      // overwrite the state written by the current owner.
      await assertLease();
      const cancelled = error.code === 'JOB_CANCELLED';
      const current = await this.db.getGenerationJob(jobId);
      await assertLease();
      const failedStage = current?.stage || 'starting';
      await this.db.updateGenerationJob(jobId, {
        status: cancelled ? 'cancelled' : 'failed',
        stage: failedStage,
        error: error.message,
        details: {
          failedStage,
          ...(error.code === 'QUALITY_REVIEW_REQUIRED' && error.qualityReviewId
            ? {
                qualityReviewId: error.qualityReviewId,
                qualityReviewStatus: 'pending',
                qualityReviewCode: error.code
              }
            : {})
        },
        completedAt: new Date().toISOString()
      }, assertLease.lease || null);
      await assertLease();
      await this.operator.notify({
        type: cancelled ? 'generation_cancelled' : 'generation_failure',
        level: cancelled ? 'warning' : 'error',
        title: cancelled ? 'Generation cancelled' : 'Generation failed',
        message: error.message,
        data: { jobId }
      });
      throw error;
    }
  }

  async updateJobStage(jobId, stage, progress, details = {}, assertLease = async () => {}) {
    if (!jobId) return;
    const job = await this.db.getGenerationJob(jobId);
    if (job?.cancelRequested) {
      const error = new Error(job.details?.cancelReason || 'Generation cancelled by operator');
      error.code = 'JOB_CANCELLED';
      throw error;
    }
    await assertLease();
    await this.db.updateGenerationJob(jobId, { stage, progress, details }, assertLease.lease || null);
    await assertLease();
  }

  async generateContent(topic = null, style = null, length = 'medium', options = {}) {
    this.logger.info('Starting content generation pipeline...');
    const { jobId = null, strategyContext: rawStrategyContext = {}, forceHumanApproval = false, assertLease = async () => {} } = options;
    await assertLease();
    const strategyContext = rawStrategyContext || {};
    const approvedConcept = await requireApprovedVideoConcept(
      this.db,
      strategyContext.approvedVideoConceptId
    );
    await assertLease();
    strategyContext.approvedVideoConcept = approvedConcept.concept;
    strategyContext.approvedVideoConceptId = approvedConcept.id;
    const profile = await this.db.getChannelProfile() || {};
    await assertLease();
    const lengthLabels = { short: '2-4 minutes', medium: '8-12 minutes', long: '15-20 minutes' };

    // Step 1: Strategy
    const strategy = await this.runGenerationStage(jobId, 'strategy', 10, async stageAssertLease => {
      await stageAssertLease();
      const generated = await this.agents.strategy.generateContentStrategy(topic, stageAssertLease);
      await stageAssertLease();
      const { getApprovedPackagingLearning, getApprovedScriptLearnings } = require('./utils/packaging-learning');
      // Use the same measured application feedback shown in the learning summary.
      // A fresh negative signal blocks reuse only; it never changes operator approval.
      let learningSummary = null;
      try {
        learningSummary = this.agents.analytics?.getLearningSummary
          ? await this.agents.analytics.getLearningSummary()
          : null;
      } catch (error) {
        this.logger.warn('Applied-learning feedback is unavailable; continuing generation without learned recommendations:', error.message);
      }
      await stageAssertLease();
      // Never fall back to raw approvals here: doing so would bypass fresh
      // negative application feedback. Missing analytics only disables reuse;
      // it does not block the production itself or alter approval records.
      const approvedLearnings = Array.isArray(learningSummary?.recommendations)
        ? learningSummary.recommendations.filter(item => item?.status === 'approved')
        : [];
      generated.packagingLearning = getApprovedPackagingLearning(approvedLearnings);
      generated.approvedScriptLearnings = getApprovedScriptLearnings(approvedLearnings);
      generated.jobId = jobId;
      if (strategyContext.approvedVideoConcept) {
        generated.approvedVideoConcept = strategyContext.approvedVideoConcept;
        generated.approvedVideoConceptId = strategyContext.approvedVideoConceptId || null;
      }
      const contentStyles = new Set(['tutorial', 'explainer', 'list', 'review', 'story']);
      const requestedStyle = style || profile.default_style || null;
      if (requestedStyle && contentStyles.has(requestedStyle.toLowerCase())) {
        generated.contentType = requestedStyle.charAt(0).toUpperCase() + requestedStyle.slice(1).toLowerCase();
      }
      generated.requestedStyle = requestedStyle;
      generated.requestedLengthKey = length;
      generated.requestedLength = lengthLabels[length] || lengthLabels.medium;
      generated.angle = strategyContext.angle || generated.angle;
      generated.planRationale = strategyContext.rationale || null;
      generated.targetAudience = strategyContext.audience || profile.target_audience || generated.targetAudience;
      generated.brandVoice = profile.brand_voice || null;
      generated.channelGoal = strategyContext.objective || profile.goal || null;
      generated.channelValueProposition = strategyContext.valueProposition || null;
      generated.channelConstraints = strategyContext.constraints || null;
      generated.contentPillar = strategyContext.pillar || null;
      generated.callToAction = profile.call_to_action || null;
      generated.researchSources = Array.isArray(strategyContext.researchSources)
        ? strategyContext.researchSources
        : [];
      await stageAssertLease();
      return generated;
    }, assertLease);
    this.logger.info(`Strategy generated: ${strategy.topic}`);

    // Step 2: Script Writing
    const script = await this.runGenerationStage(
      jobId,
      'script',
      25,
      async stageAssertLease => {
        await stageAssertLease();
        const result = await this.agents.scriptWriter.generateScript(strategy, stageAssertLease);
        await stageAssertLease();
        return result;
      },
      assertLease
    );
    this.logger.info(`Script generated: ${script.title}`);

    // Step 3: Thumbnail Design
    const thumbnail = await this.runGenerationStage(
      jobId,
      'thumbnail',
      40,
      async stageAssertLease => {
        await stageAssertLease();
        const result = await this.agents.thumbnailDesigner.generateThumbnail(script, strategy.packagingLearning, stageAssertLease);
        await stageAssertLease();
        return result;
      },
      assertLease
    );
    this.logger.info('Thumbnail generated');

    // Step 4: SEO Optimization
    const seoData = await this.runGenerationStage(
      jobId,
      'seo',
      52,
      async stageAssertLease => {
        await stageAssertLease();
        const result = await this.agents.seoOptimizer.optimize(script, strategy, stageAssertLease);
        await stageAssertLease();
        return result;
      },
      assertLease
    );
    this.logger.info('SEO optimization complete');

    // Step 5: Production Management
    const productionData = await this.runGenerationStage(
      jobId,
      'production',
      62,
      async stageAssertLease => {
        await stageAssertLease();
        const result = await this.agents.production.processContent({ strategy, script, thumbnail, seo: seoData, jobId, assertLease: stageAssertLease });
        await stageAssertLease();
        return result;
      },
      assertLease
    );
    this.logger.info('Production processing complete');

    // Re-persist reused production artifacts in case a restart happened between checkpointing and persistence.
    await assertLease();
    const contentId = await this.db.saveProductionData(productionData, assertLease.lease || null);
    await assertLease();
    await this.db.saveProductionSnapshot(productionData, assertLease.lease || null);
    await assertLease();
    if (!this.provenance) this.provenance = new ProvenanceService(this.db);
    productionData.provenance = await this.provenance.initialize(contentId, productionData, assertLease.lease || null);
    await assertLease();
    productionData.discoverability = this.discoverability
      ? await this.discoverability.auditProduction(productionData, profile, 'youtube', assertLease)
      : null;
    await assertLease();
    this.logger.info(`Content saved with ID: ${contentId}`);

    // Step 6: Quality and approval gate
    return this.runGenerationStage(jobId, 'quality_review', 90, async stageAssertLease => {
      await stageAssertLease();
      const approvalRequired = forceHumanApproval || await this.db.getSetting('approval_required') !== 'false';
      const packagingExperiment = approvalRequired
        ? await this.preparePackagingExperiment(thumbnail, productionData, seoData, script, stageAssertLease)
        : null;
      try {
        await stageAssertLease();
      } catch (error) {
        for (const variant of packagingExperiment?.thumbnailVariants || []) {
          if (variant.path && variant.path !== productionData.assets?.thumbnail?.path) {
            await fs.unlink(variant.path).catch(() => {});
          }
        }
        throw error;
      }
      const quality = await this.operator.runQualityChecks(productionData, profile);
      await stageAssertLease();
      const reviewStatus = quality.passed
        ? (approvalRequired ? 'needs_review' : 'approved')
        : 'needs_attention';
      await stageAssertLease();
      await this.db.saveContentReview(contentId, {
        status: reviewStatus,
        qualityChecks: quality.checks,
        editorData: packagingExperiment ? {
          packagingExperiment,
          selectedTitleVariant: 0,
          selectedThumbnailVariant: 0
        } : {},
        reviewNotes: quality.passed ? null : `Blocking checks failed: ${quality.blockingFailures.join(', ')}`,
        reviewedAt: approvalRequired ? null : new Date().toISOString()
      }, stageAssertLease.lease || null);
      await stageAssertLease();

      let scheduleEntry = null;
      if (reviewStatus === 'approved') {
        await stageAssertLease();
        scheduleEntry = await this.agents.publishing.scheduleContent(productionData, { assertLease: stageAssertLease });
        await stageAssertLease();
        await this.db.updateProductionStatus(contentId, scheduleEntry ? 'scheduled' : productionData.status, stageAssertLease.lease || null);
        await stageAssertLease();
      } else {
        await stageAssertLease();
        await this.db.updateProductionStatus(contentId, reviewStatus, stageAssertLease.lease || null);
        await stageAssertLease();
        await stageAssertLease();
        await this.operator.notify({
          type: 'review_required',
          level: quality.passed ? 'info' : 'warning',
          title: quality.passed ? 'Content ready for review' : 'Content needs attention',
          message: `${script.title} ${quality.passed ? 'is ready for approval' : 'failed one or more quality checks'}`,
          data: { contentId, qualityScore: quality.score }
        });
        await stageAssertLease();
      }

      return {
        contentId,
        title: script.title,
        status: productionData.status,
        reviewStatus,
        qualityScore: quality.score,
        scheduledFor: scheduleEntry ? scheduleEntry.publishTime : null
      };
    }, assertLease);
  }

  async runGenerationStage(jobId, stage, progress, producer, assertLease = async () => {}) {
    await assertLease();
    if (!jobId) {
      await this.updateJobStage(jobId, stage, progress);
      await assertLease();
      const result = await producer(assertLease);
      await assertLease();
      return result;
    }
    if (!this.recovery) {
      this.recovery = new GenerationRecoveryService(this.db, {
        logger: this.logger,
        updateJobStage: (...args) => this.updateJobStage(...args)
      });
    }
    return this.recovery.run(jobId, stage, progress, producer, { assertLease });
  }

  validateEditorData(input = {}, existing = {}) {
    const output = { ...existing };
    if (input.title !== undefined) {
      const title = String(input.title).trim();
      if (!title || title.length > 100) throw new Error('Title must be between 1 and 100 characters');
      output.title = title;
    }
    if (input.description !== undefined) {
      const description = String(input.description).trim();
      if (description.length > 5000) throw new Error('Description must be 5,000 characters or less');
      output.description = description;
    }
    if (input.tags !== undefined) {
      const tags = Array.isArray(input.tags)
        ? input.tags
        : String(input.tags).split(',');
      output.tags = tags.map(tag => String(tag).trim()).filter(Boolean).slice(0, 30);
    }
    if (input.publishTime !== undefined) {
      const date = new Date(input.publishTime);
      if (Number.isNaN(date.getTime())) throw new Error('Publish time must be a valid date');
      output.publishTime = date.toISOString();
    }
    if (input.privacyStatus !== undefined) {
      if (!['private', 'unlisted', 'public'].includes(input.privacyStatus)) throw new Error('Invalid privacy status');
      output.privacyStatus = input.privacyStatus;
    }
    if (input.factChecked !== undefined) output.factChecked = input.factChecked === true;
    if (input.rightsConfirmed !== undefined) output.rightsConfirmed = input.rightsConfirmed === true;
    const experiment = output.packagingExperiment;
    if (input.selectedTitleVariant !== undefined) {
      const selected = Number(input.selectedTitleVariant);
      if (!Number.isInteger(selected) || !experiment?.titleVariants?.[selected]) {
        throw new Error('Selected title variant is invalid');
      }
      output.selectedTitleVariant = selected;
    }
    if (input.selectedThumbnailVariant !== undefined) {
      const selected = Number(input.selectedThumbnailVariant);
      if (!Number.isInteger(selected) || !experiment?.thumbnailVariants?.[selected]) {
        throw new Error('Selected thumbnail variant is invalid');
      }
      output.selectedThumbnailVariant = selected;
    }
    return output;
  }

  buildTitleExperimentVariants(title) {
    const control = String(title || '').trim().slice(0, 100);
    const withoutPunctuation = control.replace(/[.!?]+$/, '');
    return [
      { label: 'Control', title: control },
      { label: 'Step-by-step + Color contrast', title: `${withoutPunctuation}: Step-by-Step`.slice(0, 100) },
      { label: 'Curiosity + Alternate promise', title: `${withoutPunctuation}: What Most People Miss`.slice(0, 100) },
      { label: 'Benefit + Centered composition', title: `${withoutPunctuation}: What You Can Achieve`.slice(0, 100) }
    ];
  }

  async preparePackagingExperiment(thumbnail, productionData, seoData, script, assertLease = async () => {}) {
    await assertLease();
    const approved = await this.db.listLearningRecommendations({ status: 'approved', limit: 25 });
    await assertLease();
    const { isApprovedPackagingLearning } = require('./utils/packaging-learning');
    const recommendation = approved.find(isApprovedPackagingLearning);
    if (!recommendation) return null;

    let generated = [];
    try {
      await assertLease();
      generated = await this.agents.thumbnailDesigner.generateABVariants(thumbnail.concept, assertLease);
      await assertLease();
      return {
        sourceRecommendationId: recommendation.id,
        hypothesis: recommendation.title,
        learning: {
          rationale: recommendation.rationale || '',
          confidence: recommendation.confidence || 'unknown',
          winningTitle: recommendation.proposedChange?.winningTitle || null,
          winningThumbnailPattern: recommendation.proposedChange?.winningThumbnailPattern || null,
          winningArmLabel: recommendation.proposedChange?.winningArmLabel || null,
          evidence: recommendation.evidence || {}
        },
        status: 'draft',
        titleVariants: this.buildTitleExperimentVariants(seoData.title || script.title),
        thumbnailVariants: [
          {
            label: 'Control',
            path: productionData.assets?.thumbnail?.path,
            thumbnailRecordId: productionData.assets?.thumbnail?.thumbnailRecordId || thumbnail.id || null,
            concept: thumbnail.concept
          },
          ...generated
        ],
        createdAt: new Date().toISOString()
      };
    } catch (error) {
      for (const variant of generated) {
        if (variant.path && variant.path !== productionData.assets?.thumbnail?.path) {
          await fs.unlink(variant.path).catch(() => {});
        }
      }
      if (String(error.code || '').includes('LEASE')) throw error;
      this.logger.warn(`Packaging experiment preparation failed without blocking production: ${error.message}`);
      return null;
    }
  }

  validateProfile(input) {
    const textFields = ['channelName', 'goal', 'targetAudience', 'brandVoice', 'defaultStyle', 'callToAction', 'visualStyle', 'timezone'];
    const result = {};
    for (const field of textFields) {
      if (input[field] !== undefined) {
        const value = String(input[field]).trim();
        if (value.length > 500) throw new Error(`${field} is too long`);
        result[field] = value;
      }
    }
    if (input.bannedTopics !== undefined) {
      const topics = Array.isArray(input.bannedTopics) ? input.bannedTopics : String(input.bannedTopics).split(',');
      result.bannedTopics = topics.map(topic => String(topic).trim()).filter(Boolean).slice(0, 50);
    }
    return result;
  }

  decorateContentBundle(bundle) {
    const experiment = bundle.editorData?.packagingExperiment;
    const sceneLabels = new Map((bundle.scenes || []).map(scene => [scene.id, scene.label]));
    return {
      ...bundle,
      scenes: (bundle.scenes || []).map(scene => this.scenes
        ? this.scenes.decorateScene(scene, bundle.id)
        : scene),
      shorts: (bundle.shorts || []).map(clip => ({
        ...clip,
        sourceSceneLabels: clip.sourceSceneIds.map(id => sceneLabels.get(id)).filter(Boolean),
        assetUrls: {
          video: clip.outputPath ? `/api/content/${bundle.id}/shorts/${clip.id}/asset/video` : null,
          captions: clip.captionsPath ? `/api/content/${bundle.id}/shorts/${clip.id}/asset/captions` : null
        }
      })),
      assetUrls: {
        video: bundle.assets?.finalVideo?.path && !bundle.assets?.finalVideo?.simulated ? `/api/content/${bundle.id}/asset/video` : null,
        thumbnail: bundle.assets?.thumbnail?.path && !bundle.assets?.thumbnail?.simulated ? `/api/content/${bundle.id}/asset/thumbnail` : null,
        experimentThumbnails: (experiment?.thumbnailVariants || []).map((_variant, index) =>
          `/api/content/${bundle.id}/asset/experiment-thumbnail-${index}`
        ),
        captions: bundle.assets?.captions?.path ? `/api/content/${bundle.id}/asset/captions` : null,
        script: bundle.assets?.script?.originalPath ? `/api/content/${bundle.id}/asset/script` : null
      }
    };
  }

  async renderShortClip(productionId, clipId) {
    if (!this.shorts) {
      const error = new Error('Shorts repurposing requires completed setup');
      error.status = 503;
      throw error;
    }
    if (typeof this.scenes?.withProductionOperationLease !== 'function') {
      const error = new Error('Production operation lease is required to render Shorts safely');
      error.status = 503;
      error.code = 'SHORTS_RENDER_LOCK_UNAVAILABLE';
      throw error;
    }
    return this.scenes.withProductionOperationLease(
      productionId,
      assertLease => this.shorts.render(productionId, clipId, { assertLease }),
      'Shorts render'
    );
  }

  async approveShortClip(productionId, clipId, input = {}) {
    if (!this.shorts) {
      const error = new Error('Shorts repurposing requires completed setup');
      error.status = 503;
      throw error;
    }
    if (typeof this.scenes?.withProductionOperationLease !== 'function') {
      const error = new Error('Production operation lease is required to approve Shorts safely');
      error.status = 503;
      error.code = 'SHORTS_APPROVAL_LOCK_UNAVAILABLE';
      throw error;
    }
    return this.scenes.withProductionOperationLease(
      productionId,
      assertLease => this.shorts.approve(productionId, clipId, input, { assertLease }),
      'Short approval'
    );
  }

  async runSceneEditWithReview(productionId, edit, reviewNotes, label = 'scene edit and review refresh') {
    if (typeof this.scenes?.withProductionOperationLease !== 'function') {
      const error = new Error('Scene operation lease is required to edit content and invalidate its review atomically');
      error.status = 503;
      error.code = 'SCENE_EDIT_LOCK_UNAVAILABLE';
      throw error;
    }
    return this.scenes.withProductionOperationLease(productionId, async assertLease => {
      const result = await edit(assertLease);
      await this.refreshContentReviewUnlocked(productionId, reviewNotes, assertLease);
      return result;
    }, label);
  }

  async refreshContentReview(productionId, reviewNotes) {
    if (typeof this.scenes?.withProductionOperationLease !== 'function') {
      throw new Error('Scene operation lease is required to refresh content review safely');
    }
    return this.scenes.withProductionOperationLease(
      productionId,
      assertLease => this.refreshContentReviewUnlocked(productionId, reviewNotes, assertLease),
      'content review refresh'
    );
  }

  async refreshContentReviewUnlocked(productionId, reviewNotes, assertLease = async () => {}) {
    await assertLease();
    const bundle = await this.db.getProductionBundle(productionId);
    if (!bundle) return null;
    const profile = await this.db.getChannelProfile() || {};
    const quality = await this.operator.runQualityChecks({
      ...bundle,
      scheduledPublishTime: bundle.scheduled_publish_time
    }, profile);
    await assertLease();
    const status = quality.passed ? 'needs_review' : 'needs_attention';
    return this.db.saveContentReview(productionId, {
      status,
      editorData: { ...(bundle.editorData || {}), factChecked: false, rightsConfirmed: false },
      qualityChecks: quality.checks,
      reviewNotes: reviewNotes || (quality.passed ? null : `Blocking checks failed: ${quality.blockingFailures.join(', ')}`),
      reviewedAt: null
    }, assertLease.lease);
  }

  async approveContent(productionId, input) {
    if (typeof this.scenes?.withProductionOperationLease !== 'function') {
      const error = new Error('Production operation lock is required for safe content approval');
      error.status = 503;
      error.code = 'CONTENT_APPROVAL_LOCK_UNAVAILABLE';
      throw error;
    }
    return this.scenes.withProductionOperationLease(
      productionId,
      assertLease => this.approveContentUnlocked(productionId, input, assertLease),
      'content approval'
    );
  }

  async approveContentUnlocked(productionId, input, assertLease = async () => {}) {
    await assertLease();
    const bundle = await this.db.getProductionBundle(productionId);
    if (!bundle) {
      const error = new Error('Content not found');
      error.status = 404;
      throw error;
    }
    if (bundle.schedule?.status === 'published') {
      const error = new Error('Content is already published');
      error.status = 409;
      throw error;
    }
    if (bundle.schedule?.youtubeId || ['uploading', 'uploaded', 'reconciliation_required'].includes(bundle.schedule?.status)) {
      const error = new Error(
        'This content may already have reached YouTube. Reconcile the existing upload before changing its approval or schedule state.'
      );
      error.status = 409;
      error.code = 'UPLOAD_OUTCOME_UNKNOWN';
      throw error;
    }

    const editorData = this.validateEditorData(input, bundle.editorData);
    const packagingExperiment = editorData.packagingExperiment;
    const thumbnailVariant = packagingExperiment?.thumbnailVariants?.[editorData.selectedThumbnailVariant];
    const titleVariant = packagingExperiment?.titleVariants?.[editorData.selectedTitleVariant];
    if (titleVariant && input.title === undefined) editorData.title = titleVariant.title;
    const appliedPackagingLearning = getAppliedPackagingLearning(
      packagingExperiment,
      editorData.selectedTitleVariant,
      editorData.selectedThumbnailVariant,
      input.title !== undefined && String(input.title).trim() !== String(titleVariant?.title || '').trim()
    );
    editorData.appliedLearnings = appliedPackagingLearning ? [appliedPackagingLearning] : [];
    if (!editorData.factChecked || !editorData.rightsConfirmed) {
      const error = new Error('Confirm the factual review and media rights checks before approval');
      error.status = 409;
      throw error;
    }
    const productionData = {
      id: bundle.id,
      status: bundle.status,
      strategy: bundle.strategy,
      script: { ...bundle.script, title: editorData.title || bundle.script.title },
      thumbnail: bundle.thumbnail,
      seo: {
        ...bundle.seo,
        title: editorData.title || bundle.seo.title,
        description: editorData.description || bundle.seo.description,
        tags: editorData.tags || bundle.seo.tags
      },
      assets: thumbnailVariant
        ? { ...bundle.assets, thumbnail: { ...bundle.assets.thumbnail, path: thumbnailVariant.path } }
        : bundle.assets,
      timeline: bundle.timeline,
      scheduledPublishTime: editorData.publishTime || input.publishTime || bundle.scheduled_publish_time,
      priority: bundle.priority,
      estimatedDuration: bundle.estimated_duration,
      privacyStatus: editorData.privacyStatus || process.env.DEFAULT_PRIVACY_STATUS || 'private',
      provenance: bundle.provenance,
      containsSyntheticMedia: bundle.provenance?.containsSyntheticMedia === true,
      scenes: bundle.scenes || []
    };
    const profile = await this.db.getChannelProfile() || {};
    await assertLease();
    const quality = await this.operator.runQualityChecks(productionData, profile);
    await assertLease();
    if (!quality.passed) {
      await this.db.saveContentReview(bundle.id, {
        status: 'needs_attention', editorData, qualityChecks: quality.checks,
        reviewNotes: `Blocking checks failed: ${quality.blockingFailures.join(', ')}`
      }, assertLease.lease);
      const error = new Error('Content still has blocking quality failures');
      error.status = 409;
      error.quality = quality;
      throw error;
    }

    let scheduleEntry = bundle.schedule;
    if (!scheduleEntry) {
      scheduleEntry = await this.agents.publishing.scheduleContent(productionData, { assertLease, lease: assertLease.lease });
    } else if (scheduleEntry.status !== 'published') {
      scheduleEntry.title = productionData.script.title;
      scheduleEntry.publishTime = productionData.scheduledPublishTime;
      scheduleEntry.status = 'scheduled';
      scheduleEntry.metadata = {
        ...scheduleEntry.metadata,
        seo: productionData.seo,
        thumbnail: productionData.assets.thumbnail,
        video: productionData.assets.finalVideo,
        audio: productionData.assets.audio,
        captions: productionData.assets.captions,
        privacyStatus: editorData.privacyStatus || process.env.DEFAULT_PRIVACY_STATUS || 'private',
        containsSyntheticMedia: productionData.containsSyntheticMedia
      };
      await assertLease();
      await this.db.updateScheduleEntry(scheduleEntry, assertLease.lease, bundle.id);
      await this.agents.publishing.loadPublishQueue();
    }
    if (!scheduleEntry) {
      const error = new Error('A real MP4 is required before content can be approved for scheduling');
      error.status = 409;
      throw error;
    }

    await assertLease();
    await this.db.saveContentReview(bundle.id, {
      status: 'approved', editorData, qualityChecks: quality.checks,
      reviewNotes: input.reviewNotes || 'Approved by operator', reviewedAt: new Date().toISOString()
    }, assertLease.lease);
    await this.db.updateProductionStatus(bundle.id, 'scheduled', assertLease.lease);
    await this.operator.notify({
      type: 'content_approved', level: 'success', title: 'Content approved',
      message: `${productionData.script.title} is scheduled for ${scheduleEntry.publishTime}`,
      data: { productionId, publishTime: scheduleEntry.publishTime }
    });
    return { productionId, reviewStatus: 'approved', qualityScore: quality.score, schedule: scheduleEntry };
  }

  async start() {
    const initialized = await this.initialize();
    
    if (!initialized) {
      console.log(chalk.red('\n❌ Failed to initialize. Please check your configuration.'));
      process.exit(1);
    }
    
    const PORT = process.env.PORT || 3456;
    // Loopback by default: mutating routes are open whenever API_KEY is unset,
    // so the dashboard must not be reachable from the network unless asked.
    const HOST = process.env.HOST || '127.0.0.1';
    validateHostConfiguration(HOST);
    this.app.listen(PORT, HOST, () => {
      console.log(chalk.green(`\n✅ YouTube Automation Agent running on ${HOST}:${PORT}`));
      console.log(chalk.gray('─'.repeat(50)));
      console.log(chalk.white('📊 Dashboard: ') + chalk.cyan(`http://localhost:${PORT}`));
      console.log(chalk.white('🔧 API Health: ') + chalk.cyan(`http://localhost:${PORT}/health`));
      console.log(chalk.white('📅 Schedule: ') + chalk.cyan(`http://localhost:${PORT}/schedule`));
      console.log(chalk.white('📈 Analytics: ') + chalk.cyan(`http://localhost:${PORT}/analytics`));
      console.log(chalk.gray('─'.repeat(50)));
      if (this.setupRequired) {
        console.log(chalk.yellow('\n⚙️  Setup is required. The dashboard is available; run npm run walkthrough to enable generation.'));
      } else {
        console.log(chalk.yellow('\n🤖 Automation is active. Approved content will be published on schedule.'));
      }
    });
  }
}

// Start the agent
if (require.main === module) {
  const agent = new YouTubeAutomationAgent();
  agent.start().catch(error => {
    console.error(chalk.red('Fatal error:'), error);
    process.exit(1);
  });
}

module.exports = { YouTubeAutomationAgent, isLoopbackHost, validateHostConfiguration };
