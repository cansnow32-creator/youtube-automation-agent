const { google } = require('googleapis');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { Logger } = require('../utils/logger');
const { assertValidYouTubeMetadata } = require('../utils/youtube-metadata-validator');

class PublishingSchedulingAgent {
  constructor(db, credentials, options = {}) {
    this.db = db;
    this.credentials = credentials;
    this.logger = new Logger('PublishingScheduling');
    this.youtube = null;
    this.publishQueue = [];
    // Queue-driven uploads are opt-in. Manual publish actions remain available
    // after the existing content-review and readiness checks.
    this.autoPublishEnabled = options.autoPublishEnabled === undefined
      ? String(process.env.AUTO_PUBLISH_ENABLED || '').trim().toLowerCase() === 'true'
      : options.autoPublishEnabled === true;
    // Prevent overlapping publish requests for the same item in this process.
    this.activePublishes = new Map();
  }

  async initialize() {
    this.logger.info('Initializing Publishing & Scheduling Agent...');
    await this.setupYouTubeAPI();
    await this.loadPublishQueue();
    return true;
  }

  async setupYouTubeAPI() {
    try {
      const auth = this.credentials.getYouTubeAuth();
      this.youtube = google.youtube({ version: 'v3', auth });
      this.logger.info('YouTube API initialized');
    } catch (error) {
      this.logger.error('Failed to initialize YouTube API:', error);
      throw error;
    }
  }

  async loadPublishQueue() {
    try {
      const queue = await this.db.getPublishQueue();
      this.publishQueue = Array.isArray(queue) ? queue : [];
      this.logger.info(`Loaded ${this.publishQueue.length} items in publish queue`);
      return true;
    } catch (error) {
      // Never fall back to a stale in-memory queue after a database read failure.
      this.publishQueue = [];
      this.logger.error('Failed to reload publish queue from database:', error);
      return false;
    }
  }

  async scheduleContent(productionData, options = {}) {
    const assertLease = typeof options.assertLease === 'function' ? options.assertLease : async () => {};
    const lease = options.lease || assertLease.lease || null;
    const leaseProductionId = options.leaseProductionId || productionData.id;
    await assertLease();
    try {
      const finalVideo = productionData.assets?.finalVideo;
      if (!finalVideo || finalVideo.simulated || path.extname(finalVideo.path || '').toLowerCase() !== '.mp4') {
        this.logger.warn(`Not scheduling ${productionData.id}: no real video file was produced (placeholder/simulated output). Fix your AI provider keys and FFmpeg, then regenerate.`);
        return null;
      }
      if (!await this.isNarrationReady(productionData.assets?.audio)) {
        this.logger.warn(`Not scheduling ${productionData.id}: narration is missing. Regenerate narration or explicitly confirm an intentional silent video.`);
        return null;
      }

      this.logger.info(`Scheduling content: ${productionData.id}`);
      await assertLease();
      const existing = await this.db.getLatestScheduleEntry?.(productionData.id);
      await assertLease();
      if (existing) {
        if (['scheduled', 'paused'].includes(existing.status) && !this.publishQueue.some(entry => entry.id === existing.id)) {
          this.publishQueue.push(existing);
          this.publishQueue.sort((a, b) => new Date(a.publishTime) - new Date(b.publishTime));
        }
        this.logger.info(`Reusing existing ${existing.status} schedule entry for: ${productionData.id}`);
        return existing;
      }

      const scheduleEntry = {
        productionId: productionData.id,
        title: productionData.script.title,
        publishTime: productionData.scheduledPublishTime,
        status: 'scheduled',
        priority: productionData.priority,
        metadata: {
          seo: productionData.seo,
          thumbnail: productionData.assets.thumbnail,
          video: productionData.assets.finalVideo,
          audio: productionData.assets.audio,
          captions: productionData.assets.captions,
          privacyStatus: productionData.privacyStatus || process.env.DEFAULT_PRIVACY_STATUS || 'private',
          containsSyntheticMedia: productionData.containsSyntheticMedia === true,
          contentType: productionData.contentType || 'long_form',
          sourceProductionId: productionData.sourceProductionId || productionData.id,
          shortClipId: productionData.shortClipId || null
        },
        createdAt: new Date().toISOString()
      };
      
      await assertLease();
      const saved = await this.db.saveScheduleEntry(scheduleEntry, lease, leaseProductionId) || scheduleEntry;
      await assertLease();
      this.publishQueue.push(saved);
      this.publishQueue.sort((a, b) => new Date(a.publishTime) - new Date(b.publishTime));
      
      this.logger.info(`Content scheduled for: ${saved.publishTime}`);
      return saved;
    } catch (error) {
      this.logger.error('Failed to schedule content:', error);
      throw error;
    }
  }

  async publishContent(contentId, options = {}) {
    const key = String(contentId);
    const active = this.activePublishes.get(key);
    if (active) return active;

    const operation = this.publishContentOnce(contentId, options);
    this.activePublishes.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.activePublishes.get(key) === operation) {
        this.activePublishes.delete(key);
      }
    }
  }

  async publishContentOnce(contentId, options = {}) {
    try {
      let productionBundle = null;
      if (this.db.getProductionBundle) {
        productionBundle = await this.db.getProductionBundle(contentId);
        if (productionBundle && !['verified', 'not_required'].includes(productionBundle.provenance?.status || 'not_required')) {
          const error = new Error('Publishing is blocked until every factual claim is supported or explicitly waived');
          error.status = 409;
          error.code = 'PROVENANCE_BLOCKED';
          throw error;
        }

        // Enforce operator approval in the publishing service itself. This protects
        // every caller, including scheduled jobs and the emergency "publish now" path.
        if (productionBundle) {
          if (productionBundle.review_status !== 'approved') {
            const error = new Error('Publishing is blocked until the production has explicit operator approval');
            error.status = 409;
            error.code = 'CONTENT_NOT_APPROVED';
            throw error;
          }
        } else {
          const shortClip = this.db.getShortClip ? await this.db.getShortClip(contentId) : null;
          const approvedShort = shortClip &&
            ['scheduled', 'failed', 'uploading', 'reconciliation_required', 'published'].includes(shortClip.status) &&
            Boolean(shortClip.approvedAt) &&
            shortClip.inheritedEvidence?.ready === true;
          if (!approvedShort) {
            const error = new Error('Publishing is blocked until the Short has explicit approval and verified source evidence');
            error.status = 409;
            error.code = 'SHORT_NOT_APPROVED';
            throw error;
          }
        }
      }
      if (this.db.getLatestReadinessRun) {
        const readiness = await this.db.getLatestReadinessRun();
        const completedAt = readiness?.completed_at || readiness?.completedAt || readiness?.created_at;
        const ageMs = completedAt ? Date.now() - new Date(completedAt).getTime() : NaN;
        const stale = !Number.isFinite(ageMs) || ageMs < 0 || ageMs > 24 * 60 * 60 * 1000;
        const blockingFailures = (readiness?.checks || [])
          .filter(check => check.blocking && check.status === 'failed')
          .map(check => check.id);
        let reason = null;
        if (!readiness) reason = 'Run the verified production readiness check before publishing';
        else if (stale) reason = 'The production readiness check is missing a valid timestamp or is older than 24 hours; run it again';
        else if (readiness.status === 'failed') reason = `Fix ${blockingFailures.join(', ') || 'the blocking readiness checks'} and run the check again`;
        else if (!['passed', 'warning'].includes(readiness.status)) reason = `Resolve the readiness status (${readiness.status || 'unknown'}) and run the check again`;
        if (reason) {
          const error = new Error(`Publishing is blocked by the production readiness gate. ${reason}.`);
          error.status = 409;
          error.code = 'READINESS_BLOCKED';
          throw error;
        }
      }
      this.logger.info(`Publishing content: ${contentId}`);
      
      let scheduleEntry = this.publishQueue.find(entry =>
        entry.productionId === contentId || entry.id === contentId
      );
      if (!scheduleEntry && this.db.getLatestScheduleEntry) {
        scheduleEntry = await this.db.getLatestScheduleEntry(contentId);
      }
      
      if (!scheduleEntry) {
        throw new Error(`Content not found in queue: ${contentId}`);
      }
      if (scheduleEntry.status === 'published') return scheduleEntry;
      // A durable YouTube ID always takes precedence over local asset readiness:
      // verify the existing remote upload rather than attempting another upload.
      if (scheduleEntry.youtubeId) {
        return this.reconcileUploadedVideo(scheduleEntry);
      }
      if (!await this.isNarrationReady(scheduleEntry.metadata?.audio || productionBundle?.assets?.audio)) {
        const error = new Error('Publishing is blocked because narration is missing or the intentional-silence override is incomplete');
        error.status = 409;
        error.code = 'NARRATION_REQUIRED';
        throw error;
      }
      if (['uploading', 'reconciliation_required'].includes(scheduleEntry.status)) {
        const error = new Error('A previous upload may have reached YouTube without returning a video ID. Reconcile the channel before attempting another upload.');
        error.status = 409;
        error.code = 'UPLOAD_OUTCOME_UNKNOWN';
        throw error;
      }

      if (typeof this.db.claimScheduleEntryForUpload !== 'function') {
        const error = new Error('Atomic publish claim support is required to prevent duplicate YouTube uploads');
        error.status = 503;
        error.code = 'PUBLISH_CLAIM_UNAVAILABLE';
        throw error;
      }
      const claimedEntry = await this.db.claimScheduleEntryForUpload(scheduleEntry.id);
      if (!claimedEntry) {
        const latest = await this.db.getLatestScheduleEntry?.(scheduleEntry.productionId);
        if (latest?.youtubeId) return this.reconcileUploadedVideo(latest);
        if (latest?.status === 'published') return latest;
        const error = new Error('Another publisher claimed this schedule or its state changed. Reconcile before retrying.');
        error.status = 409;
        error.code = ['uploading', 'reconciliation_required'].includes(latest?.status)
          ? 'UPLOAD_OUTCOME_UNKNOWN'
          : 'PUBLISH_CLAIM_CONFLICT';
        throw error;
      }
      scheduleEntry = claimedEntry;
      const uploadAttemptId = scheduleEntry.uploadAttemptId;
      if (!uploadAttemptId) {
        const error = new Error('The durable upload claim did not return an attempt ID; refusing to upload without stale-worker fencing');
        error.status = 503;
        error.code = 'PUBLISH_ATTEMPT_ID_MISSING';
        throw error;
      }
      const queuedEntry = this.publishQueue.find(entry => entry.id === scheduleEntry.id);
      if (queuedEntry) Object.assign(queuedEntry, scheduleEntry);
      await this.syncShortStatus(scheduleEntry, 'uploading');

      let uploadResult;
      try {
        uploadResult = await this.uploadToYouTube(scheduleEntry, options);
      } catch (error) {
        if (scheduleEntry.uploadAttempted && this.isUploadOutcomeUnknown(error)) {
          scheduleEntry.status = 'reconciliation_required';
          scheduleEntry.error = 'Upload outcome is unknown; verify the YouTube channel before retrying';
          const saved = await this.db.updateScheduleEntryForUpload?.(scheduleEntry, uploadAttemptId);
          if (!saved) {
            const stale = new Error('The upload attempt was superseded before its uncertain outcome could be recorded; reconcile the YouTube channel');
            stale.status = 409;
            stale.code = 'PUBLISH_ATTEMPT_SUPERSEDED';
            throw stale;
          }
          Object.assign(scheduleEntry, saved);
          await this.syncShortStatus(scheduleEntry, 'reconciliation_required', scheduleEntry.error);
          error.code = 'UPLOAD_OUTCOME_UNKNOWN';
          error.status = 409;
        } else {
          scheduleEntry.status = 'failed';
          scheduleEntry.error = error.message;
          const saved = await this.db.updateScheduleEntryForUpload?.(scheduleEntry, uploadAttemptId);
          if (!saved) {
            const stale = new Error('The failed upload attempt is no longer current; its state was not overwritten');
            stale.status = 409;
            stale.code = 'PUBLISH_ATTEMPT_SUPERSEDED';
            throw stale;
          }
          Object.assign(scheduleEntry, saved);
          await this.syncShortStatus(scheduleEntry, 'failed', error.message);
        }
        throw error;
      }
      
      // Update database
      scheduleEntry.status = 'published';
      scheduleEntry.publishedAt = new Date().toISOString();
      scheduleEntry.youtubeId = uploadResult.id;
      scheduleEntry.youtubeUrl = `https://www.youtube.com/watch?v=${uploadResult.id}`;
      
      const saved = await this.db.updateScheduleEntryForUpload?.(scheduleEntry, uploadAttemptId);
      if (!saved) {
        const error = new Error('The YouTube upload completed, but this publish attempt is no longer current; the recorded video ID must be reconciled without overwriting the newer schedule');
        error.status = 409;
        error.code = 'PUBLISH_ATTEMPT_SUPERSEDED';
        throw error;
      }
      Object.assign(scheduleEntry, saved);
      await this.syncShortStatus(scheduleEntry, 'published');
      
      // Remove from queue
      this.publishQueue = this.publishQueue.filter(entry => entry.productionId !== scheduleEntry.productionId);
      
      this.logger.success(`Content published: ${scheduleEntry.youtubeUrl}`);
      return scheduleEntry;
    } catch (error) {
      this.logger.error('Failed to publish content:', error);
      throw error;
    }
  }

  async uploadToYouTube(scheduleEntry, options = {}) {
    const { metadata } = scheduleEntry;
    const validation = assertValidYouTubeMetadata(metadata.seo);
    if (validation.warnings.length) {
      this.logger.warn(`YouTube metadata warnings: ${validation.warnings.join(' ')}`);
    }
    const safeMetadata = validation.value;
    
    // Prepare video metadata
    const requestedPrivacy = metadata.privacyStatus || process.env.DEFAULT_PRIVACY_STATUS || 'private';
    if (!['private', 'unlisted', 'public'].includes(requestedPrivacy)) {
      const error = new Error('Invalid YouTube privacy status. Use private, unlisted, or public.');
      error.status = 400;
      error.code = 'INVALID_PRIVACY_STATUS';
      throw error;
    }
    const scheduledFor = new Date(scheduleEntry.publishTime);
    const futureSchedule = !options.publishNow && Number.isFinite(scheduledFor.getTime()) && scheduledFor.getTime() > Date.now() + 60000;
    const videoMetadata = {
      snippet: {
        title: safeMetadata.title,
        description: safeMetadata.description,
        tags: safeMetadata.tags,
        categoryId: safeMetadata.categoryId,
        defaultLanguage: safeMetadata.defaultLanguage,
        defaultAudioLanguage: safeMetadata.defaultAudioLanguage
      },
      status: {
        privacyStatus: futureSchedule ? 'private' : requestedPrivacy,
        selfDeclaredMadeForKids: false,
        containsSyntheticMedia: metadata.containsSyntheticMedia === true
      }
    };
    if (futureSchedule) videoMetadata.status.publishAt = scheduleEntry.publishTime;
    
    // Resolve the file before marking the network upload as attempted.
    const videoStream = await this.getVideoStream(metadata.video.path);
    scheduleEntry.uploadAttempted = true;
    const videoUpload = await this.youtube.videos.insert({
      part: 'snippet,status',
      requestBody: videoMetadata,
      media: {
        body: videoStream
      }
    });
    
    const videoId = videoUpload.data.id;
    if (!videoId) {
      const error = new Error('YouTube accepted the upload request without returning a video ID; the outcome must be reconciled before retrying');
      error.status = 502;
      error.code = 'YOUTUBE_UPLOAD_ID_MISSING';
      throw error;
    }
    this.logger.info(`Video uploaded with ID: ${videoId}`);
    scheduleEntry.status = 'uploaded';
    scheduleEntry.youtubeId = videoId;
    scheduleEntry.youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
    scheduleEntry.error = null;
    if (typeof this.db.recordScheduleEntryUploadResult !== 'function') {
      const error = new Error('Atomic persistence of the accepted YouTube video ID is required; do not retry this upload');
      error.status = 503;
      error.code = 'YOUTUBE_UPLOAD_ID_PERSISTENCE_UNAVAILABLE';
      throw error;
    }
    const persistedUpload = await this.db.recordScheduleEntryUploadResult(
      scheduleEntry.id,
      videoId,
      scheduleEntry.metadata || {},
      scheduleEntry.uploadAttemptId
    );
    if (!persistedUpload) {
      const latest = await this.db.getScheduleEntry?.(scheduleEntry.id);
      if (latest?.youtubeId !== videoId) {
        const error = new Error('YouTube accepted the video, but its ID could not be atomically recorded. Reconcile this upload before any retry.');
        error.status = 409;
        error.code = 'YOUTUBE_UPLOAD_ID_PERSISTENCE_CONFLICT';
        throw error;
      }
      Object.assign(scheduleEntry, latest);
    } else {
      Object.assign(scheduleEntry, persistedUpload);
    }
    
    // Upload the thumbnail without turning a successful video upload into a retryable video failure.
    // Persist the result so a failed thumbnail is visible and can be repaired separately.
    if (metadata.thumbnail && metadata.thumbnail.path) {
      try {
        await this.uploadThumbnail(videoId, metadata.thumbnail.path);
        scheduleEntry.metadata.thumbnailUpload = { status: 'uploaded', completedAt: new Date().toISOString() };
      } catch (error) {
        scheduleEntry.metadata.thumbnailUpload = {
          status: 'failed',
          failedAt: new Date().toISOString(),
          errorCode: error.code || null,
          errorMessage: String(error.message || 'Thumbnail upload failed').slice(0, 300),
          retryRequired: true
        };
        this.logger.warn(`Video ${videoId} was uploaded, but its thumbnail failed. Repair the thumbnail separately; do not retry the video upload.`);
      }
      const saved = await this.db.updateScheduleEntryForUpload?.(scheduleEntry, scheduleEntry.uploadAttemptId);
      if (saved) Object.assign(scheduleEntry, saved);
    }
    
    // Captions are a post-upload asset. Their failure must never turn a successful
    // video upload into a retryable video publish.
    if (metadata.captions && metadata.captions.path) {
      try {
        await this.uploadCaptions(videoId, metadata.captions.path);
        scheduleEntry.metadata.captionUpload = {
          status: 'uploaded',
          completedAt: new Date().toISOString(),
          retryRequired: false
        };
      } catch (error) {
        scheduleEntry.metadata.captionUpload = {
          status: 'failed',
          failedAt: new Date().toISOString(),
          errorCode: error.code || null,
          errorMessage: String(error.message || 'Caption upload failed').slice(0, 300),
          retryRequired: true
        };
        this.logger.warn(`Video ${videoId} was uploaded, but captions failed. Repair captions separately; do not retry the video upload.`);
      }
      const saved = await this.db.updateScheduleEntryForUpload?.(scheduleEntry, scheduleEntry.uploadAttemptId);
      if (saved) Object.assign(scheduleEntry, saved);
    }
    
    return videoUpload.data;
  }

  async isNarrationReady(audio = {}) {
    if (audio.intentionalSilence === true) {
      return String(audio.silenceReason || '').trim().length >= 10 && Boolean(audio.silenceConfirmedAt);
    }
    if (!audio.path || audio.simulated || String(audio.path).endsWith('.info')) return false;
    try {
      const stats = await fs.stat(audio.path);
      return stats.isFile() && stats.size > 0;
    } catch (_error) {
      return false;
    }
  }

  isUploadOutcomeUnknown(error) {
    const status = Number(error.status || error.response?.status || 0);
    return !status || status >= 500;
  }

  async reconcileUnresolvedUpload(scheduleId, videoId) {
    if (!this.youtube) {
      const error = new Error('YouTube API is not initialized');
      error.status = 503;
      throw error;
    }
    if (typeof this.db.getScheduleEntry !== 'function' ||
        typeof this.db.reconcileScheduleEntryUpload !== 'function') {
      const error = new Error('Atomic YouTube upload reconciliation support is unavailable');
      error.status = 503;
      error.code = 'PUBLISH_RECONCILIATION_UNAVAILABLE';
      throw error;
    }
    const entry = await this.db.getScheduleEntry(scheduleId);
    if (!entry) {
      const error = new Error('Publish schedule entry not found');
      error.status = 404;
      throw error;
    }
    if (!['uploading', 'reconciliation_required'].includes(entry.status) || entry.youtubeId) {
      const error = new Error('Only unresolved uploads without a recorded YouTube ID can be reconciled');
      error.status = 409;
      error.code = 'PUBLISH_RECONCILIATION_CONFLICT';
      throw error;
    }
    const candidateId = String(videoId || '').trim();
    if (!/^[A-Za-z0-9_-]{11}$/.test(candidateId)) {
      const error = new Error('A valid 11-character YouTube video ID is required');
      error.status = 400;
      error.code = 'INVALID_YOUTUBE_VIDEO_ID';
      throw error;
    }

    const [videoResponse, channelResponse] = await Promise.all([
      this.youtube.videos.list({ part: 'id,snippet,status', id: candidateId }),
      this.youtube.channels.list({ part: 'id', mine: true })
    ]);
    const video = (videoResponse.data.items || []).find(item => item.id === candidateId);
    if (!video?.snippet?.channelId) {
      const error = new Error('YouTube could not verify this video ID');
      error.status = 404;
      error.code = 'YOUTUBE_VIDEO_NOT_FOUND';
      throw error;
    }
    const channelId = channelResponse.data.items?.[0]?.id;
    if (!channelId || video.snippet.channelId !== channelId) {
      const error = new Error('The supplied video does not belong to the authenticated YouTube channel');
      error.status = 403;
      error.code = 'YOUTUBE_CHANNEL_MISMATCH';
      throw error;
    }
    const expectedTitle = String(entry.metadata?.seo?.title || entry.title || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
    const actualTitle = String(video.snippet.title || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
    if (!expectedTitle || actualTitle !== expectedTitle) {
      const error = new Error('The verified YouTube video title does not match this scheduled content');
      error.status = 409;
      error.code = 'YOUTUBE_TITLE_MISMATCH';
      throw error;
    }

    const metadata = {
      ...(entry.metadata || {}),
      uploadReconciliation: {
        action: 'video_attached',
        videoId: candidateId,
        channelId,
        verifiedTitle: video.snippet.title,
        verifiedAt: new Date().toISOString()
      }
    };
    const reconciled = await this.db.reconcileScheduleEntryUpload(scheduleId, candidateId, metadata);
    if (!reconciled) {
      const latest = await this.db.getScheduleEntry(scheduleId);
      if (latest?.status === 'published' && latest.youtubeId === candidateId) return latest;
      const error = new Error('The publish entry changed while YouTube verification was running; reload and reconcile the current state');
      error.status = 409;
      error.code = 'PUBLISH_RECONCILIATION_CONFLICT';
      throw error;
    }
    await this.syncShortStatus(reconciled, 'published');
    this.publishQueue = this.publishQueue.filter(item => item.id !== scheduleId);
    this.logger.success(`Operator reconciled existing YouTube upload: ${reconciled.youtubeUrl}`);
    return reconciled;
  }

  async resolveUnresolvedUploadAsAbsent(scheduleId, confirmedAbsent) {
    if (confirmedAbsent !== true) {
      const error = new Error('Explicit confirmation that no video exists in the channel is required');
      error.status = 400;
      error.code = 'UPLOAD_ABSENCE_CONFIRMATION_REQUIRED';
      throw error;
    }
    if (typeof this.db.getScheduleEntry !== 'function' ||
        typeof this.db.resolveScheduleEntryUploadAbsent !== 'function') {
      const error = new Error('Atomic YouTube upload reconciliation support is unavailable');
      error.status = 503;
      error.code = 'PUBLISH_RECONCILIATION_UNAVAILABLE';
      throw error;
    }
    const entry = await this.db.getScheduleEntry(scheduleId);
    if (!entry) {
      const error = new Error('Publish schedule entry not found');
      error.status = 404;
      throw error;
    }
    if (!['uploading', 'reconciliation_required'].includes(entry.status) || entry.youtubeId) {
      const error = new Error('Only unresolved uploads without a recorded YouTube ID can be resolved as absent');
      error.status = 409;
      error.code = 'PUBLISH_RECONCILIATION_CONFLICT';
      throw error;
    }
    const confirmedAt = new Date().toISOString();
    const metadata = {
      ...(entry.metadata || {}),
      uploadReconciliation: {
        action: 'operator_confirmed_absent',
        confirmedAt,
        warning: 'Operator checked the authenticated channel and confirmed no matching upload was found'
      }
    };
    const resolved = await this.db.resolveScheduleEntryUploadAbsent(
      scheduleId,
      metadata,
      'Operator confirmed that no matching YouTube upload exists; a manual retry is now permitted'
    );
    if (!resolved) {
      const latest = await this.db.getScheduleEntry(scheduleId);
      if (latest && ['uploading', 'reconciliation_required'].includes(latest.status) && !latest.youtubeId) {
        const error = new Error('The upload attempt must be at least 10 minutes old before confirming that no video was created. Check YouTube Studio again after the grace period.');
        error.status = 409;
        error.code = 'UPLOAD_GRACE_PERIOD_ACTIVE';
        throw error;
      }
      const error = new Error('The publish entry changed during reconciliation; reload before retrying');
      error.status = 409;
      error.code = 'PUBLISH_RECONCILIATION_CONFLICT';
      throw error;
    }
    await this.syncShortStatus(resolved, 'failed', resolved.error);
    const queued = this.publishQueue.find(item => item.id === scheduleId);
    if (queued) Object.assign(queued, resolved);
    return resolved;
  }

  async reconcileUploadedVideo(scheduleEntry) {
    if (!this.youtube || typeof this.db.updateScheduleEntryUploadVerification !== 'function') {
      const error = new Error('Safe verification for recorded YouTube uploads is unavailable');
      error.status = 503;
      error.code = 'PUBLISH_RECONCILIATION_UNAVAILABLE';
      throw error;
    }
    const videoId = String(scheduleEntry.youtubeId || '').trim();
    let video = null;
    let channelId = null;
    try {
      const [videoResponse, channelResponse] = await Promise.all([
        this.youtube.videos.list({ part: 'id,snippet,status', id: videoId }),
        this.youtube.channels.list({ part: 'id', mine: true })
      ]);
      video = (videoResponse.data.items || []).find(item => item.id === videoId) || null;
      channelId = channelResponse.data.items?.[0]?.id || null;
    } catch (cause) {
      const error = new Error(`YouTube could not verify the recorded upload: ${cause.message}`);
      error.status = 502;
      error.code = 'YOUTUBE_VERIFICATION_FAILED';
      throw error;
    }

    const expectedTitle = String(scheduleEntry.metadata?.seo?.title || scheduleEntry.title || '')
      .trim().replace(/\\s+/g, ' ').toLocaleLowerCase();
    const actualTitle = String(video?.snippet?.title || '')
      .trim().replace(/\\s+/g, ' ').toLocaleLowerCase();
    let reason = null;
    let code = null;
    if (!video) {
      reason = 'The recorded YouTube video ID could not be found on the authenticated channel';
      code = 'YOUTUBE_VIDEO_NOT_FOUND';
    } else if (!channelId || video.snippet?.channelId !== channelId) {
      reason = 'The recorded YouTube video does not belong to the authenticated channel';
      code = 'YOUTUBE_CHANNEL_MISMATCH';
    } else if (!expectedTitle || actualTitle !== expectedTitle) {
      reason = 'The recorded YouTube video title does not match the scheduled content';
      code = 'YOUTUBE_TITLE_MISMATCH';
    }

    const nextStatus = reason ? 'reconciliation_required' : 'published';
    const updated = await this.db.updateScheduleEntryUploadVerification(
      scheduleEntry.id,
      scheduleEntry.status,
      videoId,
      nextStatus,
      reason,
      new Date().toISOString()
    );
    if (!updated) {
      const latest = await this.db.getScheduleEntry(scheduleEntry.id);
      if (latest?.status === 'published' && latest.youtubeId === videoId) return latest;
      const error = new Error('The schedule changed during YouTube verification; reload and inspect its current state');
      error.status = 409;
      error.code = 'PUBLISH_RECONCILIATION_CONFLICT';
      throw error;
    }
    await this.syncShortStatus(updated, nextStatus, reason);
    if (reason) {
      const error = new Error(reason);
      error.status = 409;
      error.code = code;
      throw error;
    }
    this.publishQueue = this.publishQueue.filter(entry => entry.id !== scheduleEntry.id);
    this.logger.success(`Reconciled existing YouTube upload: ${updated.youtubeUrl}`);
    return updated;
  }

  async syncShortStatus(scheduleEntry, status, error = null) {
    const clipId = scheduleEntry.metadata?.shortClipId;
    if (!clipId) return null;
    if (typeof this.db.updateShortClipForSchedule !== 'function') {
      this.logger.warn('Skipping Shorts status sync because schedule-scoped compare-and-set support is unavailable');
      return null;
    }
    const updated = await this.db.updateShortClipForSchedule(clipId, scheduleEntry.id, {
      status,
      youtubeId: scheduleEntry.youtubeId || null,
      youtubeUrl: scheduleEntry.youtubeUrl || null,
      error
    });
    if (!updated) this.logger.warn(`Skipped stale Shorts status update for ${clipId} from schedule ${scheduleEntry.id}`);
    return updated;
  }

  async getVideoStream(videoPath) {
    try {
      const stats = await fs.stat(videoPath);
      if (!stats.isFile() || path.extname(videoPath).toLowerCase() !== '.mp4') {
        throw new Error('placeholder asset');
      }

      return fsSync.createReadStream(videoPath);
    } catch (error) {
      throw new Error('video file not found — refusing to upload placeholder');
    }
  }
  async uploadThumbnail(videoId, thumbnailPath) {
    const thumbnailBuffer = await fs.readFile(thumbnailPath);
    await this.youtube.thumbnails.set({
      videoId,
      media: { body: thumbnailBuffer }
    });
    this.logger.info(`Thumbnail uploaded for video: ${videoId}`);
    return { videoId, uploaded: true };
  }

  async retryCaptionUpload(contentId) {
    const entry = this.db.getLatestScheduleEntry
      ? await this.db.getLatestScheduleEntry(contentId)
      : this.publishQueue.find(item => item.productionId === contentId || item.id === contentId);
    if (!entry) {
      const error = new Error(`Scheduled content not found: ${contentId}`);
      error.status = 404;
      throw error;
    }
    if (!entry.youtubeId) {
      const error = new Error('The video has not been uploaded to YouTube; caption repair is not available yet');
      error.status = 409;
      throw error;
    }
    if (entry.metadata?.captionUpload?.status !== 'failed' || entry.metadata.captionUpload.retryRequired !== true) {
      const error = new Error('A recorded caption upload failure is required before retrying this asset');
      error.status = 409;
      throw error;
    }
    const captionsPath = entry.metadata?.captions?.path;
    if (!captionsPath) {
      const error = new Error('No generated caption file is attached to this video');
      error.status = 409;
      throw error;
    }
    if (!this.youtube) {
      const error = new Error('YouTube API is not initialized');
      error.status = 503;
      throw error;
    }

    entry.metadata = entry.metadata || {};
    try {
      await this.uploadCaptions(entry.youtubeId, captionsPath);
      entry.metadata.captionUpload = {
        status: 'uploaded',
        completedAt: new Date().toISOString(),
        retryRequired: false
      };
      await this.db.updateScheduleEntry(entry);
      const queued = this.publishQueue.find(item => item.id === entry.id);
      if (queued) Object.assign(queued, entry);
      return entry;
    } catch (error) {
      entry.metadata.captionUpload = {
        status: 'failed',
        failedAt: new Date().toISOString(),
        errorCode: error.code || null,
        errorMessage: String(error.message || 'Caption upload failed').slice(0, 300),
        retryRequired: true
      };
      await this.db.updateScheduleEntry(entry);
      error.status = error.status || 502;
      error.code = 'CAPTION_RETRY_FAILED';
      throw error;
    }
  }

  async retryThumbnailUpload(contentId) {
    const entry = this.db.getLatestScheduleEntry
      ? await this.db.getLatestScheduleEntry(contentId)
      : this.publishQueue.find(item => item.productionId === contentId || item.id === contentId);
    if (!entry) {
      const error = new Error(`Scheduled content not found: ${contentId}`);
      error.status = 404;
      throw error;
    }
    if (!entry.youtubeId) {
      const error = new Error('The video has not been uploaded to YouTube; thumbnail repair is not available yet');
      error.status = 409;
      throw error;
    }
    if (entry.metadata?.thumbnailUpload?.status !== 'failed' || entry.metadata.thumbnailUpload.retryRequired !== true) {
      const error = new Error('A recorded thumbnail upload failure is required before retrying this asset');
      error.status = 409;
      throw error;
    }
    const thumbnailPath = entry.metadata?.thumbnail?.path;
    if (!thumbnailPath) {
      const error = new Error('No generated thumbnail file is attached to this video');
      error.status = 409;
      throw error;
    }
    if (!this.youtube) {
      const error = new Error('YouTube API is not initialized');
      error.status = 503;
      throw error;
    }

    entry.metadata = entry.metadata || {};
    try {
      await this.uploadThumbnail(entry.youtubeId, thumbnailPath);
      entry.metadata.thumbnailUpload = {
        status: 'uploaded',
        completedAt: new Date().toISOString(),
        retryRequired: false
      };
      await this.db.updateScheduleEntry(entry);
      const queued = this.publishQueue.find(item => item.id === entry.id);
      if (queued) Object.assign(queued, entry);
      return entry;
    } catch (error) {
      entry.metadata.thumbnailUpload = {
        status: 'failed',
        failedAt: new Date().toISOString(),
        errorCode: error.code || null,
        errorMessage: String(error.message || 'Thumbnail upload failed').slice(0, 300),
        retryRequired: true
      };
      await this.db.updateScheduleEntry(entry);
      error.status = error.status || 502;
      error.code = 'THUMBNAIL_RETRY_FAILED';
      throw error;
    }
  }

  async applyVideoPackaging(videoId, packaging = {}, previousPackaging = null) {
    const title = String(packaging.title || '').trim();
    if (!videoId || !title || title.length > 100 || !packaging.thumbnailPath) {
      const error = new Error('A valid video ID, title, and thumbnail are required for a packaging change');
      error.status = 400;
      error.code = 'PACKAGING_INVALID';
      throw error;
    }
    const thumbnail = await fs.readFile(packaging.thumbnailPath);
    const current = await this.youtube.videos.list({ part: 'snippet', id: videoId });
    const snippet = current.data.items?.[0]?.snippet;
    if (!snippet) {
      const error = new Error(`YouTube video not found: ${videoId}`);
      error.status = 404;
      error.code = 'PACKAGING_VIDEO_NOT_FOUND';
      throw error;
    }

    const updateTitle = async nextTitle => this.youtube.videos.update({
      part: 'snippet',
      requestBody: {
        id: videoId,
        snippet: {
          title: nextTitle,
          description: snippet.description || '',
          tags: snippet.tags || [],
          categoryId: snippet.categoryId || '22',
          defaultLanguage: snippet.defaultLanguage,
          defaultAudioLanguage: snippet.defaultAudioLanguage
        }
      }
    });

    await updateTitle(title);
    try {
      await this.youtube.thumbnails.set({
        videoId,
        media: { body: thumbnail }
      });
    } catch (error) {
      try {
        await updateTitle(String(previousPackaging?.title || snippet.title || '').trim());
      } catch (rollbackError) {
        error.message = `${error.message}; title rollback also failed: ${rollbackError.message}`;
      }
      throw error;
    }
    let auditRecorded = false;
    if (this.db.getScheduleEntryByYoutubeId && this.db.updateScheduleEntry) {
      try {
        const entry = await this.db.getScheduleEntryByYoutubeId(videoId);
        if (entry) {
          entry.metadata = entry.metadata || {};
          const history = Array.isArray(entry.metadata.packagingChangeHistory)
            ? entry.metadata.packagingChangeHistory
            : [];
          history.push({
            source: 'operator_post_publish',
            appliedAt: new Date().toISOString(),
            previousTitle: String(snippet.title || '').slice(0, 100),
            title: title.slice(0, 100),
            thumbnailPath: String(packaging.thumbnailPath).slice(0, 500)
          });
          entry.metadata.packagingChangeHistory = history.slice(-20);
          await this.db.updateScheduleEntry(entry);
          auditRecorded = true;
        }
      } catch (auditError) {
        this.logger.warn(`Packaging was updated on YouTube, but its local audit record could not be saved: ${auditError.message}`);
      }
    }
    this.logger.info(`Applied approved growth-experiment packaging to video: ${videoId}`);
    return { videoId, title, thumbnailPath: packaging.thumbnailPath, auditRecorded };
  }

  async uploadCaptions(videoId, captionsPath) {
    const captionsContent = await fs.readFile(captionsPath, 'utf8');
    await this.youtube.captions.insert({
      part: 'snippet',
      requestBody: {
        snippet: {
          videoId,
          language: 'en',
          name: 'English Captions',
          isDraft: false
        }
      },
      media: { body: captionsContent }
    });
    this.logger.info(`Captions uploaded for video: ${videoId}`);
    return { videoId, uploaded: true };
  }

  async processPublishQueue() {
    // A scheduled time is not consent to enable autonomous uploads. Require an
    // explicit environment or constructor opt-in before processing due items.
    if (this.autoPublishEnabled !== true) {
      this.logger.info('Automatic publishing is disabled; scheduled videos remain queued for manual review/publishing.');
      return 0;
    }
    // Refresh on every scheduler tick so overdue rows and schedules created by
    // other processes are visible after restart or while this process is running.
    if (!await this.loadPublishQueue()) return 0;

    const scheduled = this.publishQueue
      .filter(entry => entry.status === 'scheduled')
      .map(entry => ({ entry, publishAt: new Date(entry.publishTime) }))
      .sort((a, b) => a.publishAt - b.publishAt);

    const validScheduled = [];
    for (const item of scheduled) {
      if (!Number.isFinite(item.publishAt.getTime())) {
        item.entry.status = 'failed';
        item.entry.error = 'Invalid publish time; set a valid schedule before retrying';
        await this.db.updateScheduleEntry(item.entry);
        this.logger.error(`Skipping schedule ${item.entry.id}: invalid publish time`);
        continue;
      }
      validScheduled.push(item);
    }

    const now = Date.now();
    const readyToPublish = validScheduled
      .filter(item => item.publishAt.getTime() <= now)
      .map(item => item.entry);

    if (readyToPublish.length === 0) {
      if (validScheduled.length > 0) {
        this.logger.info(`Publish queue: ${validScheduled.length} item(s) waiting, next publish at ${validScheduled[0].entry.publishTime}`);
      } else {
        this.logger.info('Publish queue is empty — nothing scheduled yet.');
      }
      return 0;
    }

    this.logger.info(`Processing publish queue: ${readyToPublish.length} item(s) ready to publish...`);

    for (const entry of readyToPublish) {
      try {
        await this.publishContent(entry.productionId);
        this.logger.info(`Auto-published: ${entry.title}`);
      } catch (error) {
        if (error.code === 'READINESS_BLOCKED') {
          this.logger.warn(error.message);
          continue;
        }
        this.logger.error(`Failed to auto-publish ${entry.title}:`, error);
        // Mark as failed but don't stop processing other items. Unknown upload
        // outcomes remain blocked for operator reconciliation.
        if (error.code !== 'UPLOAD_OUTCOME_UNKNOWN') {
          entry.status = 'failed';
          entry.error = error.message;
          await this.db.updateScheduleEntry(entry);
        }
      }
    }

    return readyToPublish.length;
  }

  async getUpcomingSchedule(days = 7) {
    const now = new Date();
    const endDate = new Date(now.getTime() + (days * 24 * 60 * 60 * 1000));
    
    return this.publishQueue
      .filter(entry => {
        const publishTime = new Date(entry.publishTime);
        return publishTime >= now && publishTime <= endDate;
      })
      .sort((a, b) => new Date(a.publishTime) - new Date(b.publishTime));
  }

  async optimizePublishTimes() {
    // Analyze channel analytics to find optimal publish times
    const analytics = await this.getChannelAnalytics();
    const optimalTimes = this.calculateOptimalTimes(analytics);
    
    // Update scheduled content with better times
    for (const entry of this.publishQueue) {
      if (entry.status === 'scheduled') {
        const currentTime = new Date(entry.publishTime);
        const betterTime = this.findBetterTime(currentTime, optimalTimes);
        
        if (betterTime && betterTime.getTime() !== currentTime.getTime()) {
          entry.publishTime = betterTime.toISOString();
          await this.db.updateScheduleEntry(entry);
          this.logger.info(`Optimized publish time for: ${entry.title}`);
        }
      }
    }
  }

  async getChannelAnalytics() {
    try {
      // Get channel analytics for the last 30 days
      const response = await this.youtube.channels.list({
        part: 'statistics',
        mine: true
      });
      
      // In a full implementation, you'd use YouTube Analytics API
      // For now, we'll return simulated data
      return {
        totalViews: response.data.items[0]?.statistics?.viewCount || 0,
        subscribers: response.data.items[0]?.statistics?.subscriberCount || 0,
        videos: response.data.items[0]?.statistics?.videoCount || 0,
        optimalDays: ['Tuesday', 'Wednesday', 'Thursday'], // Most active days
        optimalHours: [14, 15, 16, 20] // Most active hours
      };
    } catch (error) {
      this.logger.error('Failed to get channel analytics:', error);
      return {
        optimalDays: ['Tuesday', 'Wednesday', 'Thursday'],
        optimalHours: [14, 15, 16]
      };
    }
  }

  calculateOptimalTimes(analytics) {
    const { optimalDays, optimalHours } = analytics;
    
    return {
      bestDays: optimalDays,
      bestHours: optimalHours,
      worstDays: ['Monday', 'Friday'],
      worstHours: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 22, 23]
    };
  }

  findBetterTime(currentTime, optimalTimes) {
    const currentDay = currentTime.toLocaleDateString('en-US', { weekday: 'long' });
    const currentHour = currentTime.getHours();
    
    // If current time is already optimal, return null
    if (optimalTimes.bestDays.includes(currentDay) && 
        optimalTimes.bestHours.includes(currentHour)) {
      return null;
    }
    
    // Find the next optimal time
    const nextOptimalTime = new Date(currentTime);
    
    // Try to find an optimal hour on the same day
    for (const hour of optimalTimes.bestHours) {
      if (hour > currentHour) {
        nextOptimalTime.setHours(hour, 0, 0, 0);
        if (optimalTimes.bestDays.includes(currentDay)) {
          return nextOptimalTime;
        }
      }
    }
    
    // Find next optimal day
    for (let i = 1; i <= 7; i++) {
      const testDate = new Date(currentTime.getTime() + (i * 24 * 60 * 60 * 1000));
      const testDay = testDate.toLocaleDateString('en-US', { weekday: 'long' });
      
      if (optimalTimes.bestDays.includes(testDay)) {
        testDate.setHours(optimalTimes.bestHours[0], 0, 0, 0);
        return testDate;
      }
    }
    
    return null; // No better time found
  }

  async createPublishingReport() {
    const report = {
      queueStatus: {
        total: this.publishQueue.length,
        scheduled: this.publishQueue.filter(e => e.status === 'scheduled').length,
        published: this.publishQueue.filter(e => e.status === 'published').length,
        failed: this.publishQueue.filter(e => e.status === 'failed').length
      },
      upcomingPublications: await this.getUpcomingSchedule(7),
      recentPublications: this.publishQueue
        .filter(e => e.status === 'published' && 
                new Date(e.publishedAt) > new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
        .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)),
      performance: await this.getPublishingPerformance(),
      generatedAt: new Date().toISOString()
    };
    
    return report;
  }

  async getPublishingPerformance() {
    const published = this.publishQueue.filter(e => e.status === 'published');
    
    if (published.length === 0) {
      return {
        totalPublished: 0,
        averageScheduleAccuracy: 0,
        publishingFrequency: 0
      };
    }
    
    // Calculate schedule accuracy
    let totalDelay = 0;
    let accuratePublishes = 0;
    
    published.forEach(entry => {
      const scheduledTime = new Date(entry.publishTime);
      const actualTime = new Date(entry.publishedAt);
      const delay = Math.abs(actualTime - scheduledTime) / (1000 * 60); // minutes
      
      totalDelay += delay;
      if (delay <= 5) accuratePublishes++; // Within 5 minutes is considered accurate
    });
    
    const averageDelay = totalDelay / published.length;
    const accuracyRate = (accuratePublishes / published.length) * 100;
    
    return {
      totalPublished: published.length,
      averageScheduleAccuracy: `${accuracyRate.toFixed(1)}%`,
      averageDelay: `${averageDelay.toFixed(1)} minutes`,
      publishingFrequency: this.calculatePublishingFrequency(published)
    };
  }

  calculatePublishingFrequency(published) {
    if (published.length < 2) return 'Insufficient data';
    
    const dates = published.map(p => new Date(p.publishedAt)).sort((a, b) => a - b);
    const totalDays = (dates[dates.length - 1] - dates[0]) / (1000 * 60 * 60 * 24);
    const frequency = published.length / totalDays;
    
    if (frequency >= 1) return `${frequency.toFixed(1)} videos per day`;
    if (frequency >= 0.14) return `${(frequency * 7).toFixed(1)} videos per week`;
    return `${(frequency * 30).toFixed(1)} videos per month`;
  }

  async emergencyPublish(contentId, delayMinutes = 0) {
    // For urgent publishing needs
    this.logger.info(`Emergency publish requested: ${contentId}`);

    if (delayMinutes > 0) {
      const entry = this.publishQueue.find(e => e.productionId === contentId || e.id === contentId) ||
        await this.db.getLatestScheduleEntry?.(contentId);
      if (!entry) throw new Error(`Content not found: ${contentId}`);
      const newPublishTime = new Date(Date.now() + (delayMinutes * 60 * 1000));
      entry.publishTime = newPublishTime.toISOString();
      await this.db.updateScheduleEntry(entry);
      this.logger.info(`Emergency scheduled for: ${entry.publishTime}`);
      return entry;
    }
    return this.publishContent(contentId, { publishNow: true });
  }

  async pauseScheduledContent(contentId) {
    const entry = this.publishQueue.find(e => 
      e.productionId === contentId || e.id === contentId
    );
    
    if (!entry) {
      throw new Error(`Content not found: ${contentId}`);
    }
    
    entry.status = 'paused';
    await this.db.updateScheduleEntry(entry);
    
    this.logger.info(`Content paused: ${entry.title}`);
    return entry;
  }

  async resumeScheduledContent(contentId, newPublishTime = null) {
    const entry = this.publishQueue.find(e => 
      e.productionId === contentId || e.id === contentId
    );
    
    if (!entry) {
      throw new Error(`Content not found: ${contentId}`);
    }
    
    entry.status = 'scheduled';
    if (newPublishTime) {
      entry.publishTime = new Date(newPublishTime).toISOString();
    }
    
    await this.db.updateScheduleEntry(entry);
    
    this.logger.info(`Content resumed: ${entry.title}`);
    return entry;
  }

  async rescheduleContent(contentId, newPublishTime) {
    const publishTime = new Date(newPublishTime);
    if (!Number.isFinite(publishTime.getTime()) || publishTime.getTime() <= Date.now()) {
      const error = new Error('Choose a future publish time');
      error.status = 400;
      throw error;
    }
    const entry = this.publishQueue.find(item => item.productionId === contentId || item.id === contentId) ||
      await this.db.getLatestScheduleEntry?.(contentId);
    if (!entry) {
      const error = new Error(`Scheduled content not found: ${contentId}`);
      error.status = 404;
      throw error;
    }
    if (entry.youtubeId || ['uploading', 'uploaded', 'published', 'reconciliation_required'].includes(entry.status)) {
      const error = new Error('Content with a recorded YouTube video ID or an unresolved upload cannot be rescheduled');
      error.status = 409;
      throw error;
    }
    entry.publishTime = publishTime.toISOString();
    entry.status = 'scheduled';
    entry.error = null;
    await this.db.updateScheduleEntry(entry);
    if (!this.publishQueue.some(item => item.id === entry.id)) this.publishQueue.push(entry);
    this.publishQueue.sort((a, b) => new Date(a.publishTime) - new Date(b.publishTime));
    return entry;
  }

  async deleteScheduledContent(contentId) {
    const entry = this.publishQueue.find(item => item.productionId === contentId || item.id === contentId) ||
      await this.db.getLatestScheduleEntry?.(contentId);
    if (!entry) {
      const error = new Error(`Scheduled content not found: ${contentId}`);
      error.status = 404;
      throw error;
    }
    if (entry.youtubeId || ['uploading', 'uploaded', 'published', 'reconciliation_required'].includes(entry.status)) {
      const error = new Error('A schedule with a recorded YouTube video ID or unresolved upload cannot be deleted');
      error.status = 409;
      throw error;
    }
    await this.db.deleteScheduleEntry(entry.id);
    this.publishQueue = this.publishQueue.filter(item => item.id !== entry.id);
    await this.syncShortStatus(entry, 'rendered');
    return entry;
  }
}

module.exports = { PublishingSchedulingAgent };
