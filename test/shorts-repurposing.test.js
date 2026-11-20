const assert = require('node:assert/strict');
const fs = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const { ShortsRepurposingService } = require('../utils/shorts-repurposing-service');
const crypto = require('node:crypto');

async function createHarness(mediaInfo) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shorts-render-test-'));
  const sourcePath = path.join(root, 'source.mp4');
  await fs.writeFile(sourcePath, Buffer.from('source-video'));
  const productionId = 'production-test';
  const clip = {
    id: 'short-test',
    productionId,
    status: 'proposed',
    startSeconds: 0,
    duration: 30,
    layout: 'crop',
    sourceSceneIds: ['scene-1']
  };
  const bundle = {
    assets: { finalVideo: { path: sourcePath, simulated: false } },
    scenes: [{
      id: 'scene-1',
      assetPath: path.join(root, 'scene.png'),
      status: 'ready',
      narrationStatus: 'current',
      scriptText: 'A complete short-form scene.'
    }]
  };
  const state = {};
  const db = {
    getProductionBundle: async () => bundle,
    getShortClip: async () => ({ ...clip, ...state }),
    updateShortClip: async (_id, changes) => Object.assign(state, changes),
    updateShortClipForRender: async (_id, attemptId, changes) => {
      if (state.status !== 'rendering' || state.renderAttemptId !== attemptId) return null;
      Object.assign(state, changes);
      return { ...clip, ...state };
    }
  };
  const runFFmpeg = async args => {
    const destination = args[args.length - 1];
    if (String(destination).endsWith('.rendering.mp4')) {
      await fs.writeFile(destination, Buffer.from('rendered-short'));
    }
  };
  const service = new ShortsRepurposingService(db, {}, {
    dataRoot: path.join(root, 'shorts'),
    runFFmpeg,
    getMediaInfo: async filePath => mediaInfo(filePath)
  });
  return { root, service, state, productionId, clip };
}

async function testLeaseLossCleansOnlyTheCurrentShortAttempt() {
  const harness = await createHarness(async () => ({ duration: 30, width: 1080, height: 1920, hasAudio: true }));
  let leaseLost = false;
  const leaseError = Object.assign(new Error('generation job lease lost'), { code: 'GENERATION_JOB_LEASE_LOST', status: 409 });
  const assertLease = async () => { if (leaseLost) throw leaseError; };
  harness.service.runFFmpeg = async args => {
    const destination = args[args.length - 1];
    if (String(destination).endsWith('.rendering.mp4')) {
      await fs.writeFile(destination, Buffer.from('partial short'));
      leaseLost = true;
    }
  };
  try {
    await assert.rejects(harness.service.render(harness.productionId, harness.clip.id, { assertLease }), error => error === leaseError);
    const outputDir = path.join(harness.root, 'shorts', harness.productionId);
    assert.deepEqual(await fs.readdir(outputDir), [], 'lease loss must remove this attempt output, captions, and temporary file');
    assert.equal(harness.state.status, 'rendering', 'a stale worker must not write a failed status after losing its lease');
  } finally {
    await fs.rm(harness.root, { recursive: true, force: true });
  }
}
async function testSupersededRenderAttemptCannotCommit() {
  const harness = await createHarness(async () => ({ duration: 30, width: 1080, height: 1920, hasAudio: true }));
  harness.service.runFFmpeg = async args => {
    const destination = args[args.length - 1];
    if (String(destination).endsWith('.rendering.mp4')) {
      await fs.writeFile(destination, Buffer.from('rendered by stale attempt'));
      harness.state.renderAttemptId = 'newer-attempt';
    }
  };
  try {
    await assert.rejects(
      harness.service.render(harness.productionId, harness.clip.id),
      error => error.code === 'SHORTS_RENDER_ATTEMPT_SUPERSEDED' && error.status === 409
    );
    assert.equal(harness.state.status, 'rendering');
    assert.equal(harness.state.renderAttemptId, 'newer-attempt');
    const outputDir = path.join(harness.root, 'shorts', harness.productionId);
    assert.deepEqual(await fs.readdir(outputDir), [], 'superseded attempt output and captions must be removed');
  } finally {
    await fs.rm(harness.root, { recursive: true, force: true });
  }
}

async function testShortEditsAreRejectedDuringRender() {
  const harness = await createHarness(async () => ({ duration: 30, width: 1080, height: 1920, hasAudio: true }));
  let releaseRender;
  let markStarted;
  const renderGate = new Promise(resolve => { releaseRender = resolve; });
  const renderStarted = new Promise(resolve => { markStarted = resolve; });
  harness.service.runFFmpeg = async args => {
    const destination = args[args.length - 1];
    if (String(destination).endsWith('.rendering.mp4')) {
      await fs.writeFile(destination, Buffer.from('rendered-short'));
      markStarted();
      await renderGate;
    }
  };
  try {
    const rendering = harness.service.render(harness.productionId, harness.clip.id);
    await renderStarted;
    await assert.rejects(
      harness.service.update(harness.productionId, harness.clip.id, { layout: 'blur' }),
      error => error.status === 409 && /while a render attempt is in progress/.test(error.message)
    );
    releaseRender();
    const result = await rendering;
    assert.equal(result.status, 'rendered');
  } finally {
    releaseRender?.();
    await fs.rm(harness.root, { recursive: true, force: true });
  }
}

async function run() {
  await testLeaseLossCleansOnlyTheCurrentShortAttempt();
  await testSupersededRenderAttemptCannotCommit();
  await testShortEditsAreRejectedDuringRender();
  let harness = await createHarness(async () => ({ duration: 30, width: 1080, height: 1920, hasAudio: true }));
  try {
    const rendered = await harness.service.render(harness.productionId, harness.clip.id);
    assert.equal(rendered.status, 'rendered');
    assert.deepEqual(rendered.renderMetadata, { duration: 30, width: 1080, height: 1920, hasAudio: true });
    await fs.access(rendered.outputPath);
    await assert.rejects(fs.access(rendered.outputPath.replace(/\.mp4$/i, '.rendering.mp4')));
    const edited = await harness.service.update(harness.productionId, harness.clip.id, { layout: 'blur' });
    assert.equal(edited.status, 'proposed');
    assert.equal(edited.outputPath, null);
    assert.equal(edited.renderMetadata, null);
  } finally {
    await fs.rm(harness.root, { recursive: true, force: true });
  }

  for (const [label, info, expected] of [
    ['short duration', { duration: 12, width: 1080, height: 1920 }, /does not match the requested/],
    ['landscape dimensions', { duration: 30, width: 1920, height: 1080 }, /must be 9:16 portrait/]
  ]) {
    harness = await createHarness(async () => info);
    try {
      await assert.rejects(() => harness.service.render(harness.productionId, harness.clip.id), expected, label);
      assert.equal(harness.state.status, 'failed');
      assert.equal(harness.state.outputPath, undefined);
      const outputDir = path.join(harness.root, 'shorts', harness.productionId);
      const remaining = await fs.readdir(outputDir);
      assert.deepEqual(remaining, [], 'failed render must remove only its attempt-scoped files');
    } finally {
      await fs.rm(harness.root, { recursive: true, force: true });
    }
  }

  process.stdout.write('Shorts repurposing tests passed\\n');
}

run().catch(error => {
  process.stderr.write((error.stack || error.message) + '\\n');
  process.exitCode = 1;
});
