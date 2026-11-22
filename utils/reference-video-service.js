const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const { runFFmpeg, getMediaDuration } = require('./ffmpeg');

const MAX_REFERENCE_BYTES = 200 * 1024 * 1024;
const MIME_EXTENSIONS = new Map([
  ['video/mp4', '.mp4'],
  ['video/quicktime', '.mov'],
  ['video/webm', '.webm']
]);

class ReferenceVideoService {
  constructor(db, options = {}) {
    this.db = db;
    this.dataRoot = options.dataRoot || path.join(__dirname, '..', 'data', 'reference-videos');
    this.runFFmpeg = options.runFFmpeg || runFFmpeg;
    this.getMediaDuration = options.getMediaDuration || getMediaDuration;
    this.maxBytes = options.maxBytes || MAX_REFERENCE_BYTES;
  }

  async upload(buffer, fileName, mimeType) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 16) throw new Error('Upload a valid reference video file');
    if (buffer.length > this.maxBytes) throw new Error('Reference video must be 200 MB or smaller');
    const normalizedMime = String(mimeType || '').split(';')[0].trim().toLowerCase();
    const extension = MIME_EXTENSIONS.get(normalizedMime);
    if (!extension) throw new Error('Supported reference formats are MP4, MOV, and WebM');
    const isMp4 = ['video/mp4', 'video/quicktime'].includes(normalizedMime) && buffer.toString('ascii', 4, 8) === 'ftyp';
    const isWebm = normalizedMime === 'video/webm' && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    if (!isMp4 && !isWebm) throw new Error('The uploaded file does not match its declared video format');

    const id = crypto.randomUUID();
    const directory = path.join(this.dataRoot, id);
    const safeName = path.basename(String(fileName || 'reference-video')).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'reference-video';
    const videoPath = path.join(directory, `source${extension}`);
    await fs.mkdir(directory, { recursive: true });

    try {
      await fs.writeFile(videoPath, buffer, { flag: 'wx' });
      const durationSeconds = await this.getMediaDuration(videoPath);
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('Could not read reference video duration');
      const fractions = [0.08, 0.24, 0.42, 0.60, 0.78, 0.94];
      const framePaths = [];
      for (let index = 0; index < fractions.length; index++) {
        const timestamp = Math.min(Math.max(0, durationSeconds - 0.15), durationSeconds * fractions[index]);
        const framePath = path.join(directory, `frame_${index + 1}.jpg`);
        try {
          await this.runFFmpeg([
            '-y', '-ss', timestamp.toFixed(3), '-i', videoPath,
            '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', framePath
          ]);
          const frame = await fs.stat(framePath);
          if (frame.isFile() && frame.size > 0) framePaths.push(framePath);
        } catch (_error) {
          // Some short or variable-frame-rate clips may not contain a frame at every requested timestamp.
        }
      }
      if (!framePaths.length) throw new Error('No preview frames could be extracted from the reference video');
      const record = {
        id, originalName: safeName, filePath: videoPath, mimeType: normalizedMime,
        sizeBytes: buffer.length, durationSeconds, framePaths, analysis: null,
        analysisStatus: 'pending'
      };
      await this.db.saveReferenceVideo(record);
      return record;
    } catch (error) {
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async getFrame(referenceId, frameIndex) {
    const record = await this.db.getReferenceVideo(referenceId);
    const index = Number.parseInt(frameIndex, 10);
    if (!record || !Array.isArray(record.framePaths) || !Number.isInteger(index) || index < 0 || index >= record.framePaths.length) return null;
    try {
      const [root, candidate] = await Promise.all([
        fs.realpath(this.dataRoot),
        fs.realpath(record.framePaths[index])
      ]);
      const relative = path.relative(root, candidate);
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
      const stat = await fs.stat(candidate);
      return stat.isFile() ? candidate : null;
    } catch (_error) {
      return null;
    }
  }

  toPublicRecord(record) {
    return {
      id: record.id,
      originalName: record.originalName,
      mimeType: record.mimeType,
      sizeBytes: record.sizeBytes,
      durationSeconds: record.durationSeconds,
      analysis: record.analysis,
      analysisStatus: record.analysisStatus,
      frameUrls: record.framePaths.map((_frame, index) => `/api/concepts/reference-videos/${encodeURIComponent(record.id)}/frames/${index}`)
    };
  }
}

module.exports = { ReferenceVideoService, MAX_REFERENCE_BYTES };
