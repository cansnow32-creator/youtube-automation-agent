const fs = require('fs').promises;
const path = require('path');
const { runFFmpeg } = require('./ffmpeg');
const { Logger } = require('./logger');

function dimensions(resolution = '720p', aspectRatio = '16:9') {
  const height = resolution === '1080p' ? 1080 : resolution === '480p' ? 480 : 720;
  if (aspectRatio === '9:16') return { width: Math.round(height * 9 / 16), height };
  if (aspectRatio === '1:1') return { width: height, height };
  return { width: Math.round(height * 16 / 9), height };
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
    await fs.mkdir(outputDir, { recursive: true });

    const durations = selectedAssets.map(() => Number((totalDuration / selectedAssets.length).toFixed(3)));
    const rendered = [];
    for (let index = 0; index < selectedAssets.length; index++) {
      const imagePath = selectedAssets[index];
      if (typeof imagePath !== 'string' || path.extname(imagePath).toLowerCase() === '.info') {
        throw new Error('CineCode cannot render simulated or non-image assets');
      }
      const imageStats = await fs.stat(imagePath);
      if (!imageStats.isFile() || imageStats.size <= 0) throw new Error(`CineCode image asset ${index + 1} is missing or empty`);

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
      await this.runFFmpeg([
        '-y', '-loop', '1', '-framerate', '30', '-i', imagePath,
        '-t', duration.toFixed(3), '-vf', filter,
        '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21',
        '-r', '30', '-movflags', '+faststart', outputPath
      ]);
      const outputStats = await fs.stat(outputPath);
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

    return {
      clips: rendered,
      totalDuration: durations.reduce((sum, duration) => sum + duration, 0),
      model: 'local-ffmpeg-camera-motion',
      resolution: `${width}x${height}`,
      colorGrade: grade
    };
  }
}

module.exports = { CineCodeRenderer, dimensions, colorGrade };
