const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const createReadStream = require('fs').createReadStream;
const sharp = require('sharp');
const { runFFmpeg } = require('./ffmpeg');
const { Logger } = require('./logger');

function isLeaseFailure(error) {
  const code = String(error?.code || '').toUpperCase();
  return code.includes('LEASE') || code.includes('LOCK_LOST') || code.includes('LOCK_UNVERIFIED');
}

async function removeAttemptFiles(paths = []) {
  await Promise.all([...new Set(paths.filter(value => typeof value === 'string' && value))]
    .map(filePath => fs.rm(filePath, { force: true }).catch(() => {})));
}

async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function dimensions(resolution = '720p', aspectRatio = '16:9') {
  const height = resolution === '1080p' ? 1080 : resolution === '480p' ? 480 : 720;
  const even = value => Math.max(2, Math.floor(value / 2) * 2);
  if (aspectRatio === '9:16') return { width: even(height * 9 / 16), height };
  if (aspectRatio === '1:1') return { width: height, height };
  return { width: even(height * 16 / 9), height };
}

function colorGrade(palette = '') {
  const value = String(palette).toLowerCase();
  if (/warm|amber|gold|sunset/.test(value)) return 'eq=saturation=1.12:contrast=1.05,colorbalance=rs=0.035:gs=0.01:bs=-0.025';
  if (/cool|blue|teal|night/.test(value)) return 'eq=saturation=1.02:contrast=1.07,colorbalance=rs=-0.025:gs=0.005:bs=0.035';
  if (/muted|monochrome|minimal|desaturated/.test(value)) return 'eq=saturation=0.72:contrast=1.08';
  if (/vibrant|vivid|neon/.test(value)) return 'eq=saturation=1.24:contrast=1.08';
  return 'eq=saturation=1.08:contrast=1.04';
}

class CineCodeRenderer {
  constructor(options = {}) {
    this.runFFmpeg = options.runFFmpeg || runFFmpeg;
    this.logger = options.logger || new Logger('CineCodeRenderer');
  }

  async renderScenes(input = {}) {
    const assertLease = typeof input.assertLease === 'function' ? input.assertLease : async () => {};
    const visualAssets = Array.isArray(input.visualAssets) ? input.visualAssets : [];
    if (!visualAssets.length) throw new Error('CineCode requires real generated image assets; placeholder files are not accepted');
    const totalDuration = Math.max(3, Number(input.totalDuration) || 30);
    const count = Math.min(visualAssets.length, Math.max(1, Math.floor(totalDuration / 3)));
    const selectedAssets = visualAssets.slice(0, count);
    const { width, height } = dimensions(input.resolution, input.aspectRatio);
    const concept = input.concept || {};
    const visualDirection = concept.visualDirection || {};
    const scenePlan = Array.isArray(concept.scenePlan) ? concept.scenePlan : [];
    const grade = colorGrade(visualDirection.palette);
    const outputDir = input.outputDir || path.join(process.cwd(), 'data', 'videos');
    const prefix = String(input.outputPrefix || 'cinecode-film').replace(/[^a-zA-Z0-9_-]/g, '_');
    await assertLease();
    await fs.mkdir(outputDir, { recursive: true });
    await assertLease();

    const durations = selectedAssets.map(() => Number((totalDuration / selectedAssets.length).toFixed(3)));
    const rendered = [];
    const createdPaths = [];
    try {
      for (let index = 0; index < selectedAssets.length; index++) {
        await assertLease();
        const imagePath = selectedAssets[index];
        if (typeof imagePath !== 'string' || path.extname(imagePath).toLowerCase() === '.info') {
          throw new Error('CineCode cannot render simulated or non-image assets');
        }
        const imageStats = await fs.stat(imagePath);
        await assertLease();
        if (!imageStats.isFile() || imageStats.size <= 0) throw new Error(`CineCode image asset ${index + 1} is missing or empty`);
        let imageMetadata;
        try {
          imageMetadata = await sharp(imagePath, { failOn: 'error' }).metadata();
        } catch (error) {
          throw new Error(`CineCode image asset ${index + 1} is not a decodable image: ${error.message}`);
        }
        await assertLease();
        if (!imageMetadata.width || !imageMetadata.height || !['png', 'jpeg', 'webp'].includes(imageMetadata.format)) {
          throw new Error(`CineCode image asset ${index + 1} has an unsupported or invalid image format`);
        }

        const scene = scenePlan[index % Math.max(1, scenePlan.length)] || {};
        const duration = durations[index];
        const fadeOutStart = Math.max(0, duration - 0.45);
        const panDirection = index % 2 === 0 ? 1 : -1;
        const filter = [
          `scale=${width}:${height}:force_original_aspect_ratio=increase`,
          `crop=${width}:${height}`,
          `zoompan=z='min(zoom+0.00004,1.08)':x='iw/2-(iw/zoom/2)+sin(on/120)*iw*0.008*${panDirection}':y='ih/2-(ih/zoom/2)+cos(on/150)*ih*0.004':d=1:s=${width}x${height}:fps=30`,
          grade,
          'vignette=PI/5',
          'fade=t=in:st=0:d=0.45',
          `fade=t=out:st=${fadeOutStart.toFixed(3)}:d=0.45`,
          'format=yuv420p'
        ].join(',');
        const outputPath = path.join(outputDir, `${prefix}_cinecode_scene_${String(index + 1).padStart(2, '0')}.mp4`);
        const manifestPath = `${outputPath}.render.json`;
        const temporaryPath = `${outputPath}.rendering.mp4`;
        const manifestTemp = `${manifestPath}.tmp`;
        const imageFingerprint = {
          path: path.resolve(imagePath),
          size: imageStats.size,
          mtimeMs: imageStats.mtimeMs,
          sha256: await hashFile(imagePath)
        };
        await assertLease();
        const renderFingerprint = crypto.createHash('sha256').update(JSON.stringify({
          image: imageFingerprint,
          duration,
          width,
          height,
          filter,
          encoder: 'libx264-veryfast-crf21'
        })).digest('hex');
        let reusable = false;
        try {
          const [manifest, cachedStats] = await Promise.all([
            fs.readFile(manifestPath, 'utf8').then(JSON.parse),
            fs.stat(outputPath)
          ]);
          reusable = manifest.fingerprint === renderFingerprint &&
            cachedStats.isFile() && cachedStats.size > 0;
        } catch (_error) {
          // Missing or invalid cache metadata forces a fresh render.
        }
        await assertLease();

        if (!reusable) {
          try {
            await assertLease();
            await fs.rm(temporaryPath, { force: true });
            await this.runFFmpeg([
              '-y', '-loop', '1', '-framerate', '30', '-i', imagePath,
              '-t', duration.toFixed(3), '-vf', filter,
              '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21',
              '-r', '30', '-movflags', '+faststart', temporaryPath
            ]);
            await assertLease();
            const outputStats = await fs.stat(temporaryPath);
            if (!outputStats.isFile() || outputStats.size <= 0) throw new Error(`CineCode failed to render scene ${index + 1}`);
            await assertLease();
            await fs.rm(outputPath, { force: true });
            await fs.rename(temporaryPath, outputPath);
            createdPaths.push(outputPath);
            await assertLease();
            await fs.writeFile(manifestTemp, JSON.stringify({
              fingerprint: renderFingerprint,
              source: imageFingerprint,
              renderedAt: new Date().toISOString()
            }, null, 2));
            await assertLease();
            await fs.rename(manifestTemp, manifestPath);
            createdPaths.push(manifestPath);
            await assertLease();
          } catch (error) {
            await removeAttemptFiles([temporaryPath, manifestTemp, outputPath, manifestPath]);
            if (isLeaseFailure(error)) {
              await removeAttemptFiles(createdPaths);
              createdPaths.length = 0;
            }
            throw error;
          }
        } else {
          await assertLease();
          // Cached scene files belong to this uncommitted attempt prefix too.
          // Keep them for a normal retry, but remove them if this worker loses its lease.
          createdPaths.push(outputPath, manifestPath);
          this.logger.info(`CineCode reusing completed scene ${index + 1}/${selectedAssets.length}`);
        }

        const outputStats = await fs.stat(outputPath);
        await assertLease();
        if (!outputStats.isFile() || outputStats.size <= 0) throw new Error(`CineCode failed to render scene ${index + 1}`);
        rendered.push({
          index: index + 1,
          label: scene.purpose || `Scene ${index + 1}`,
          prompt: scene.visual || visualDirection.style || 'Approved visual direction',
          duration,
          path: outputPath,
          provider: 'cinecode',
          model: 'local-ffmpeg-camera-motion'
        });
        this.logger.info(`CineCode rendered scene ${index + 1}/${selectedAssets.length}`);
      }

      await assertLease();
      return {
        clips: rendered,
        totalDuration: durations.reduce((sum, duration) => sum + duration, 0),
        model: 'local-ffmpeg-camera-motion',
        resolution: `${width}x${height}`,
        width,
        height,
        colorGrade: grade
      };
    } catch (error) {
      if (isLeaseFailure(error)) await removeAttemptFiles(createdPaths);
      throw error;
    }
  }
}

module.exports = { CineCodeRenderer, dimensions, colorGrade };
