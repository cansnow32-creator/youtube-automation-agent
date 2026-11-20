const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const {
  runFFmpeg,
  getMediaInfo,
  getAudioInfo
} = require('./ffmpeg');

const LICENSE_TYPES = new Set([
  'user_owned',
  'public_domain',
  'cc0',
  'cc_by',
  'cc_by_sa',
  'commercial_license'
]);

async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = require('node:fs').createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function cleanText(value, maxLength = 500) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function validateMusicRights(music = {}) {
  if (music.rightsConfirmed !== true) {
    throw new Error('Background music was not mixed: confirm that you own the track or have commercial-use rights');
  }
  if (!LICENSE_TYPES.has(music.licenseType)) {
    throw new Error('Background music requires a supported licenseType (user_owned, public_domain, cc0, cc_by, cc_by_sa, commercial_license)');
  }
  if (['cc_by', 'cc_by_sa'].includes(music.licenseType) && !cleanText(music.attribution)) {
    throw new Error('Creative Commons music requires its attribution text');
  }
  if (music.licenseType === 'commercial_license' && !cleanText(music.licenseName) && !cleanText(music.licenseUrl)) {
    throw new Error('Commercially licensed music requires a license name or license URL');
  }
}

async function mixBackgroundMusic(videoPath, outputPath, music = {}, dependencies = {}) {
  if (!music || music.enabled === false) return { status: 'disabled', path: videoPath };

  const run = dependencies.runFFmpeg || runFFmpeg;
  const readVideoInfo = dependencies.getMediaInfo || getMediaInfo;
  const readAudioInfo = dependencies.getAudioInfo || getAudioInfo;
  const fileSystem = dependencies.fs || fs;
  const assertLease = typeof dependencies.assertLease === 'function' ? dependencies.assertLease : async () => {};

  await assertLease();
  validateMusicRights(music);
  const musicPath = path.resolve(cleanText(music.path, 2048));
  if (!music.path || !path.isAbsolute(musicPath)) {
    throw new Error('Background music requires a local audio file path');
  }
  const musicStats = await fileSystem.stat(musicPath).catch(() => null);
  if (!musicStats?.isFile() || musicStats.size <= 0) {
    throw new Error('Background music file is missing or empty');
  }

  const volume = Number(music.volume ?? 0.18);
  if (!Number.isFinite(volume) || volume < 0.01 || volume > 0.5) {
    throw new Error('Background music volume must be between 0.01 and 0.5');
  }
  const fadeIn = Number(music.fadeInSeconds ?? 2);
  const fadeOut = Number(music.fadeOutSeconds ?? 3);
  if (![fadeIn, fadeOut].every(value => Number.isFinite(value) && value >= 0 && value <= 30)) {
    throw new Error('Background music fade durations must be between 0 and 30 seconds');
  }

  const [videoInfo, musicInfo] = await Promise.all([
    readVideoInfo(videoPath),
    readAudioInfo(musicPath)
  ]);
  if (!Number.isFinite(videoInfo.duration) || videoInfo.duration <= 0) {
    throw new Error('Cannot mix background music into a video with unknown duration');
  }
  const fadeOutStart = Math.max(0, videoInfo.duration - fadeOut);
  const musicFilters = [
    `volume=${volume}`,
    ...(fadeIn > 0 ? [`afade=t=in:st=0:d=${Math.min(fadeIn, videoInfo.duration)}`] : []),
    ...(fadeOut > 0 ? [`afade=t=out:st=${fadeOutStart}:d=${Math.min(fadeOut, videoInfo.duration)}`] : [])
  ].join(',');

  const filters = videoInfo.hasAudio
    ? `[0:a:0]volume=1.0[narration];[1:a:0]${musicFilters}[music];[narration][music]amix=inputs=2:duration=first:dropout_transition=2:normalize=0,alimiter=limit=0.95[mixed]`
    : `[1:a:0]${musicFilters},alimiter=limit=0.95[mixed]`;
  const temporaryPath = `${outputPath}.mixing.mp4`;
  const manifestPath = `${outputPath}.mix.json`;
  const [videoHash, musicHash] = await Promise.all([hashFile(videoPath), hashFile(musicPath)]);
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
    videoHash, musicHash, volume, fadeIn, fadeOut, loop: music.loop !== false,
    filterVersion: 1, videoHasAudio: Boolean(videoInfo.hasAudio)
  })).digest('hex');
  try {
    const [manifest, cachedStats] = await Promise.all([
      fileSystem.readFile(manifestPath, 'utf8').then(JSON.parse),
      fileSystem.stat(outputPath)
    ]);
    if (manifest.fingerprint === fingerprint && cachedStats.isFile() && cachedStats.size > 0) {
      const cachedInfo = await readVideoInfo(outputPath);
      const tolerance = Math.max(1, videoInfo.duration * 0.03);
      if (cachedInfo.hasAudio && Number.isFinite(cachedInfo.duration) &&
          Math.abs(cachedInfo.duration - videoInfo.duration) <= tolerance) {
        await run(['-v', 'error', '-i', outputPath, '-f', 'null', '-'], { assertLease });
        return {
          ...manifest.result,
          status: 'mixed',
          path: outputPath,
          sourcePath: musicPath,
          sourceFileSize: musicStats.size,
          duration: cachedInfo.duration,
          fileSize: cachedStats.size,
          cached: true
        };
      }
    }
  } catch (_cacheError) {
    // Missing, stale, or invalid cache: perform a fresh mix.
  }
  await assertLease();
  await fileSystem.rm(temporaryPath, { force: true });

  try {
    await assertLease();
    await run([
      '-y',
      '-i', videoPath,
      ...(music.loop === false ? [] : ['-stream_loop', '-1']),
      '-i', musicPath,
      '-filter_complex', filters,
      '-map', '0:v:0',
      '-map', '[mixed]',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-shortest',
      '-movflags', '+faststart',
      temporaryPath
    ], { assertLease });
    await assertLease();
    await run(['-v', 'error', '-i', temporaryPath, '-f', 'null', '-'], { assertLease });

    const outputStats = await fileSystem.stat(temporaryPath);
    const outputInfo = await readVideoInfo(temporaryPath);
    const tolerance = Math.max(1, videoInfo.duration * 0.03);
    if (!outputStats.isFile() || outputStats.size <= 0) {
      throw new Error('Background music mixer returned an empty video');
    }
    if (!outputInfo.hasAudio) {
      throw new Error('Background music mix did not produce an audio stream');
    }
    if (!Number.isFinite(outputInfo.duration) || Math.abs(outputInfo.duration - videoInfo.duration) > tolerance) {
      throw new Error('Background music mix changed the video duration beyond the allowed tolerance');
    }

    await assertLease();
    await fileSystem.rm(outputPath, { force: true });
    await fileSystem.rename(temporaryPath, outputPath);
    await assertLease();
    const result = {
      status: 'mixed',
      path: outputPath,
      sourcePath: musicPath,
      sourceFileSize: musicStats.size,
      duration: outputInfo.duration,
      fileSize: outputStats.size,
      volume,
      loop: music.loop !== false,
      fadeInSeconds: fadeIn,
      fadeOutSeconds: fadeOut,
      trackDuration: musicInfo.duration,
      title: cleanText(music.title, 200) || null,
      creator: cleanText(music.creator, 200) || null,
      licenseType: music.licenseType,
      licenseName: cleanText(music.licenseName, 200) || null,
      licenseUrl: cleanText(music.licenseUrl, 1000) || null,
      sourceUrl: cleanText(music.sourceUrl, 1000) || null,
      attribution: cleanText(music.attribution, 1000) || null,
      rightsConfirmed: true,
      mixedAt: new Date().toISOString()
    };
    const manifestTempPath = `${manifestPath}.tmp`;
    await assertLease();
    await fileSystem.writeFile(manifestTempPath, JSON.stringify({ version: 1, fingerprint, result }, null, 2));
    await assertLease();
    await fileSystem.rm(manifestPath, { force: true });
    await fileSystem.rename(manifestTempPath, manifestPath);
    await assertLease();
    return result;
  } catch (error) {
    await fileSystem.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

module.exports = { mixBackgroundMusic, validateMusicRights, LICENSE_TYPES };
