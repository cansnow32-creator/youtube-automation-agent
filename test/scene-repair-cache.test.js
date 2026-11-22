const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SceneRepairService } = require('../utils/scene-repair-service');

async function run() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-repair-cache-'));
  try {
    const visualPath = path.join(directory, 'visual.png');
    const audioPath = path.join(directory, 'narration.mp3');
    await fs.writeFile(visualPath, Buffer.from('same-size-image-A'));
    await fs.writeFile(audioPath, Buffer.from('same-size-audio-A'));

    const service = new SceneRepairService({}, {}, { dataRoot: directory });
    service.activeRebuilds.add('locked-production');
    await assert.rejects(
      service.rebuild('locked-production'),
      error => error.code === 'SCENE_REBUILD_IN_PROGRESS' && error.status === 409
    );
    service.activeRebuilds.delete('locked-production');

    const failingService = new SceneRepairService({
      acquireProductionOperationLock: async () => true,
      renewProductionOperationLock: async () => true,
      releaseProductionOperationLock: async () => true
    }, {}, { dataRoot: directory });
    failingService.rebuildUnlocked = async () => { throw new Error('simulated rebuild failure'); };
    await assert.rejects(failingService.rebuild('retryable-production'), /simulated rebuild failure/);
    assert.equal(failingService.activeRebuilds.has('retryable-production'), false,
      'rebuild lock must always be released after failure');

    const cleanupRoot = path.join(directory, 'cleanup');
    const cleanupService = new SceneRepairService({}, {}, { dataRoot: cleanupRoot });
    await fs.mkdir(path.join(cleanupRoot, 'videos'), { recursive: true });
    await fs.mkdir(path.join(cleanupRoot, 'captions'), { recursive: true });
    await fs.mkdir(path.join(cleanupRoot, 'audio'), { recursive: true });
    const staleTemp = path.join(cleanupRoot, 'videos', 'clean-me_repair_hash.12345678-1234-1234-1234-123456789abc.rendering.mp4');
    const freshTemp = path.join(cleanupRoot, 'videos', 'clean-me_repair_hash.abcdefab-cdef-abcd-efab-cdefabcdefab.rendering.mp4');
    const unrelatedTemp = path.join(cleanupRoot, 'videos', 'other_repair_hash.12345678-1234-1234-1234-123456789abc.rendering.mp4');
    await Promise.all([fs.writeFile(staleTemp, 'stale'), fs.writeFile(freshTemp, 'fresh'), fs.writeFile(unrelatedTemp, 'other')]);
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await fs.utimes(staleTemp, old, old);
    assert.equal(await cleanupService.cleanupStaleRepairTemps('clean-me'), 1, 'only old temp files belonging to this production are removed');
    await assert.rejects(fs.stat(staleTemp), { code: 'ENOENT' });
    await fs.stat(freshTemp);
    await fs.stat(unrelatedTemp);
    const scenes = [{
      id: 'scene-1', revision: 2, assetType: 'image', assetPath: visualPath,
      duration: 12, narrationStatus: 'current', audioPath, scriptText: 'Narration text'
    }];

    const first = await service.buildRebuildFingerprint(scenes, null);
    const repeated = await service.buildRebuildFingerprint(scenes, null);
    assert.equal(repeated, first, 'unchanged inputs should keep the same repair fingerprint');

    const visualStat = await fs.stat(visualPath);
    await fs.writeFile(visualPath, Buffer.from('same-size-image-B'));
    await fs.utimes(visualPath, visualStat.atime, visualStat.mtime);
    const changedVisual = await service.buildRebuildFingerprint(scenes, null);
    assert.notEqual(changedVisual, first, 'same-size visual content changes must invalidate repair cache');

    await fs.writeFile(visualPath, Buffer.from('same-size-image-A'));
    const restoredVisual = await service.buildRebuildFingerprint(scenes, null);
    assert.equal(restoredVisual, first, 'restoring original visual bytes should restore fingerprint');

    await fs.writeFile(audioPath, Buffer.from('same-size-audio-B'));
    const changedAudio = await service.buildRebuildFingerprint(scenes, null);
    assert.notEqual(changedAudio, first, 'narration changes must invalidate repair cache');

    const changedDuration = await service.buildRebuildFingerprint([{ ...scenes[0], duration: 13 }], null);
    assert.notEqual(changedDuration, first, 'duration changes must invalidate repair cache');

    const leaseDir = path.join(directory, 'lease-loss');
    const leaseService = new SceneRepairService({}, {}, {
      dataRoot: leaseDir,
      getMediaDuration: async () => 8,
      runFFmpeg: async args => {
        const output = args[args.length - 1];
        if (output !== '-') await fs.writeFile(output, 'rendered-audio');
      }
    });
    await fs.mkdir(path.join(leaseDir, 'audio'), { recursive: true });
    await assert.rejects(
      leaseService.rebuildNarration('lease-lost-production', [{
        narrationStatus: 'current', audioPath, duration: 8
      }], null, 'lease-fingerprint', async () => {
        throw Object.assign(new Error('lease lost'), { code: 'SCENE_REBUILD_LEASE_LOST' });
      }),
      error => error.code === 'SCENE_REBUILD_LEASE_LOST'
    );
    const audioFilesAfterLeaseLoss = await fs.readdir(path.join(leaseDir, 'audio'));
    assert.deepEqual(audioFilesAfterLeaseLoss, [], 'lost lease must not publish a shared narration cache file');

    const segmentDir = path.join(directory, 'scene-audio-lease');
    let segmentLeaseChecks = 0;
    let ffmpegReceivedLease = false;
    const segmentService = new SceneRepairService({}, {
      isUsableAudioFile: async () => true
    }, {
      dataRoot: segmentDir,
      runFFmpeg: async (_args, options = {}) => {
        ffmpegReceivedLease = typeof options.assertLease === 'function';
        await options.assertLease?.();
      }
    });
    const segmentScene = { position: 0, duration: 8 };
    await assert.rejects(
      segmentService.initializeAudioSegments({ id: 'segment-lease-production', assets: { audio: { path: audioPath } } }, [segmentScene], async () => {
        segmentLeaseChecks++;
        if (segmentLeaseChecks >= 3) {
          throw Object.assign(new Error('lease lost during FFmpeg'), { code: 'SCENE_REBUILD_LEASE_LOST' });
        }
      }),
      error => error.code === 'SCENE_REBUILD_LEASE_LOST'
    );
    assert.equal(ffmpegReceivedLease, true, 'scene narration FFmpeg must receive the active lease assertion');
    assert.equal(segmentScene.audioPath, undefined, 'a scene audio segment must not be published after lease loss');

    const mixDir = path.join(directory, 'narration-mix-lease');
    await fs.mkdir(path.join(mixDir, 'audio'), { recursive: true });
    const mixCalls = [];
    const mixService = new SceneRepairService({}, {}, {
      dataRoot: mixDir,
      getMediaDuration: async () => 8,
      runFFmpeg: async (args, options = {}) => {
        mixCalls.push({ args, hasLease: typeof options.assertLease === 'function' });
        await options.assertLease?.();
        const output = args[args.length - 1];
        if (output !== '-') await fs.writeFile(output, 'rendered-narration-mix');
      }
    });
    const mixOutput = await mixService.rebuildNarration('mix-lease-production', [{
      narrationStatus: 'current', audioPath, duration: 8
    }], null, 'mix-fingerprint', async () => {} , 'mix-attempt');
    assert.equal((await fs.stat(mixOutput)).isFile(), true, 'narration mix should publish after valid FFmpeg output');
    assert.equal(mixCalls.length, 2, 'narration mix should render and validate its output');
    assert.ok(mixCalls.every(call => call.hasLease), 'render and validation FFmpeg calls must both receive lease assertion');

    const fallbackPath = path.join(directory, 'full-narration.mp3');
    await fs.writeFile(fallbackPath, Buffer.from('fallback-audio'));
    const fallbackOne = await service.buildRebuildFingerprint([{ ...scenes[0], audioPath: null }], fallbackPath);
    await fs.writeFile(fallbackPath, Buffer.from('fallback-audio-2'));
    const fallbackTwo = await service.buildRebuildFingerprint([{ ...scenes[0], audioPath: null }], fallbackPath);
    assert.notEqual(fallbackTwo, fallbackOne, 'fallback narration changes must invalidate repair cache');

    console.log('Scene repair cache fingerprint tests passed');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
