const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { ProductionManagementAgent, getVideoAttemptSidecarPaths } = require('../agents/production-management-agent');

function createLeaseLostError() {
  return Object.assign(new Error('generation job lease lost'), {
    code: 'GENERATION_JOB_LEASE_LOST',
    status: 409
  });
}

function createAgent() {
  const agent = Object.create(ProductionManagementAgent.prototype);
  agent.logger = { info() {}, warn() {}, error() {} };
  return agent;
}

async function testNarrationUsesAttemptScopedOutputsAndPreservesEarlierAttempt() {
  const tempDir = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'agenttube-audio-attempt-'));
  const id = 'audio-attempt-' + crypto.randomUUID();
  const ttsPath = path.join(tempDir, 'script.txt');
  const audioDir = path.join(__dirname, '..', 'data', 'audio');
  const attemptA = 'attempt_a';
  const attemptB = 'attempt_b';
  const firstPath = path.join(audioDir, id + '_' + attemptA + '_narration.mp3');
  const secondPath = path.join(audioDir, id + '_' + attemptB + '_narration.mp3');
  const agent = createAgent();
  let providerCalls = 0;
  agent.aiVideoGenerator = {
    lastNarrationResult: { provider: 'test', model: 'test-tts', directionApplied: true },
    async generateTTSAudio(_text, outputPath) {
      providerCalls += 1;
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, 'audio-attempt-' + providerCalls);
      return outputPath;
    },
    async isUsableAudioFile(filePath) {
      const stat = await fs.stat(filePath).catch(() => null);
      return Boolean(stat?.isFile() && stat.size > 0);
    }
  };
  const production = {
    id,
    script: {},
    strategy: { approvedVideoConcept: { audioDirection: {} } },
    assets: { script: { ttsPath }, audio: null },
    timeline: { artifactAttemptId: attemptA },
    estimatedDuration: 30
  };

  try {
    await fs.mkdir(audioDir, { recursive: true });
    await fs.writeFile(ttsPath, 'First narration');
    const generatedA = await agent.generateAudioNarration(production);
    assert.equal(generatedA, firstPath);

    await fs.writeFile(ttsPath, 'Updated narration');
    production.timeline.artifactAttemptId = attemptB;
    const generatedB = await agent.generateAudioNarration(production);
    assert.equal(generatedB, secondPath);
    assert.notEqual(generatedA, generatedB);
    assert.equal(await fs.readFile(generatedA, 'utf8'), 'audio-attempt-1',
      'a new attempt must not overwrite the earlier audio file');
    assert.equal(await fs.readFile(generatedB, 'utf8'), 'audio-attempt-2');
    assert.equal(providerCalls, 2);
  } finally {
    await Promise.all([firstPath, secondPath].map(file => fs.rm(file, { force: true })));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function testNarrationOutputIsRemovedAfterLeaseLoss() {
  const tempDir = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'agenttube-audio-lease-'));
  const id = 'audio-lease-' + crypto.randomUUID();
  const attemptId = 'lease_attempt';
  const audioPath = path.join(__dirname, '..', 'data', 'audio', id + '_' + attemptId + '_narration.mp3');
  const ttsPath = path.join(tempDir, 'script.txt');
  const agent = createAgent();
  let leaseLost = false;
  agent.aiVideoGenerator = {
    lastNarrationResult: { provider: 'test' },
    async generateTTSAudio(_text, outputPath) {
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, 'partial generated audio');
      leaseLost = true;
      return outputPath;
    },
    async isUsableAudioFile() { return true; }
  };
  const production = {
    id,
    script: {},
    strategy: { approvedVideoConcept: { audioDirection: {} } },
    assets: { script: { ttsPath }, audio: null },
    timeline: { artifactAttemptId: attemptId },
    estimatedDuration: 10
  };
  const assertLease = async () => {
    if (leaseLost) throw createLeaseLostError();
  };

  try {
    await fs.writeFile(ttsPath, 'Narration');
    await assert.rejects(agent.generateAudioNarration(production, assertLease),
      error => error.code === 'GENERATION_JOB_LEASE_LOST');
    await assert.rejects(fs.access(audioPath), { code: 'ENOENT' });
    assert.equal(production.assets.audio, null, 'stale audio must not be added to production metadata');
  } finally {
    await fs.rm(audioPath, { force: true });
    await fs.rm(audioPath + '.pcm', { force: true });
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function testCaptionsUseAttemptScopedPathsAndPreserveEarlierAttempt() {
  const id = 'caption-attempt-' + crypto.randomUUID();
  const captionsDir = path.join(__dirname, '..', 'data', 'captions');
  const firstPath = path.join(captionsDir, id + '_attempt_a_captions.srt');
  const secondPath = path.join(captionsDir, id + '_attempt_b_captions.srt');
  const agent = createAgent();
  agent.createSRTCaptions = async production => '1\n00:00:00,000 --> 00:00:02,000\n' + production.script.title + '\n';
  const production = {
    id,
    script: { title: 'First version' },
    strategy: {},
    assets: { captions: null },
    timeline: { artifactAttemptId: 'attempt_a' }
  };

  try {
    const pathA = await agent.generateCaptions(production);
    assert.equal(pathA, firstPath);
    production.script.title = 'Second version';
    production.timeline.artifactAttemptId = 'attempt_b';
    const pathB = await agent.generateCaptions(production);
    assert.equal(pathB, secondPath);
    assert.notEqual(pathA, pathB);
    assert.match(await fs.readFile(pathA, 'utf8'), /First version/);
    assert.match(await fs.readFile(pathB, 'utf8'), /Second version/);
  } finally {
    await Promise.all([firstPath, secondPath].map(file => fs.rm(file, { force: true })));
  }
}

async function testCaptionOutputIsRemovedAfterLeaseLoss() {
  const id = 'caption-lease-' + crypto.randomUUID();
  const attemptId = 'lease_attempt';
  const captionsPath = path.join(__dirname, '..', 'data', 'captions', id + '_' + attemptId + '_captions.srt');
  const agent = createAgent();
  agent.createSRTCaptions = async () => '1\n00:00:00,000 --> 00:00:02,000\nLease test\n';
  let assertions = 0;
  const assertLease = async () => {
    assertions += 1;
    if (assertions >= 4) throw createLeaseLostError();
  };
  const production = {
    id,
    script: { title: 'Lease test' },
    strategy: {},
    assets: { captions: null },
    timeline: { artifactAttemptId: attemptId }
  };

  try {
    await assert.rejects(agent.generateCaptions(production, assertLease),
      error => error.code === 'GENERATION_JOB_LEASE_LOST');
    await assert.rejects(fs.access(captionsPath), { code: 'ENOENT' });
    assert.equal(production.assets.captions, null);
  } finally {
    await fs.rm(captionsPath, { force: true });
  }
}

async function testFinalVideoOutputIsPreservedAfterLeaseLossForRecovery() {
  const id = 'video-lease-' + crypto.randomUUID();
  const attemptId = 'lease_attempt';
  const outputPath = path.join(__dirname, '..', 'data', 'videos', id + '_' + attemptId + '_final.mp4');
  const agent = createAgent();
  let leaseLost = false;
  agent.aiVideoGenerator = {
    isUsableAudioFile: async () => true,
    async generateVideo(_script, _visuals, _audio, requestedPath) {
      await fs.mkdir(path.dirname(requestedPath), { recursive: true });
      await fs.writeFile(requestedPath, 'partial mp4 output');
      leaseLost = true;
      return requestedPath;
    }
  };
  const previousFinal = {
    path: path.join(__dirname, '..', 'data', 'videos', id + '_previous_captioned.mp4'),
    cleanPath: path.join(__dirname, '..', 'data', 'videos', id + '_previous_final.mp4')
  };
  const production = {
    id,
    script: { title: 'Lease test' },
    strategy: { approvedVideoConcept: { audioDirection: {} } },
    assets: {
      audio: { path: 'valid-audio.mp3' },
      video: { visualAssets: [] },
      captions: { path: 'valid-captions.srt' },
      finalVideo: previousFinal
    },
    timeline: { artifactAttemptId: attemptId },
    estimatedDuration: 10
  };
  const assertLease = async () => {
    if (leaseLost) throw createLeaseLostError();
  };

  try {
    await assert.rejects(agent.assembleVideo(production, assertLease),
      error => error.code === 'GENERATION_JOB_LEASE_LOST');
    assert.equal(await fs.access(outputPath).then(() => true, () => false), true,
      'the next lease owner may validate or reuse the attempt-scoped output');
    assert.equal(production.assets.finalVideo, previousFinal,
      'the previously persisted final video reference must remain intact');
  } finally {
    await fs.rm(outputPath, { force: true });
    await fs.rm(outputPath + '.assembly.json', { force: true });
  }
}

async function testThumbnailFallbackOutputIsRemovedAfterLeaseLoss() {
  const tempDir = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'agenttube-thumbnail-lease-'));
  const sourcePath = path.join(tempDir, 'source.jpg');
  const marker = 'thumbnail_lease_' + crypto.randomUUID();
  const originalRandomUUID = crypto.randomUUID;
  const originalDateNow = Date.now;
  const fixedTimestamp = Date.now();
  const agent = createAgent();
  let assertions = 0;
  const assertLease = async () => {
    assertions += 1;
    if (assertions >= 5) throw createLeaseLostError();
  };
  agent.aiVideoGenerator = {
    async generateThumbnail() {
      return { path: path.join(tempDir, 'simulated.info'), simulated: true };
    }
  };
  const expectedOutput = path.join(__dirname, '..', 'data', 'assets', 'thumbnail_' + fixedTimestamp + '_' + marker + '.jpg');

  try {
    await fs.writeFile(sourcePath, 'thumbnail-source');
    crypto.randomUUID = () => marker;
    Date.now = () => fixedTimestamp;
    await assert.rejects(
      agent.processThumbnail({ path: sourcePath }, { title: 'Lease test' }, assertLease),
      error => error.code === 'GENERATION_JOB_LEASE_LOST'
    );
    await assert.rejects(fs.access(expectedOutput), { code: 'ENOENT' });
  } finally {
    crypto.randomUUID = originalRandomUUID;
    Date.now = originalDateNow;
    await fs.rm(expectedOutput, { force: true });
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function testSimulationArtifactIsRemovedAfterLeaseLoss() {
  const id = 'simulation-lease-' + crypto.randomUUID();
  const attemptId = 'lease_attempt';
  const placeholderPath = path.join(__dirname, '..', 'data', 'videos', id + '_' + attemptId + '_final.mp4.assembly.json');
  const agent = createAgent();
  let assertions = 0;
  const production = {
    id,
    script: { title: 'Lease test' },
    assets: { finalVideo: null },
    timeline: { artifactAttemptId: attemptId },
    estimatedDuration: 10
  };

  try {
    await assert.rejects(agent.simulateVideoAssembly(production, 'render failed', async () => {
      assertions += 1;
      if (assertions >= 2) throw createLeaseLostError();
    }), error => error.code === 'GENERATION_JOB_LEASE_LOST');
    await assert.rejects(fs.access(placeholderPath), { code: 'ENOENT' });
    assert.equal(production.assets.finalVideo, null);
  } finally {
    await fs.rm(placeholderPath, { force: true });
  }
}

function testVideoAttemptCleanupExcludesIndependentCineCodeSceneArtifacts() {
  const outputPath = path.join(__dirname, '..', 'data', 'videos', 'production_attempt_final.mp4');
  const paths = getVideoAttemptSidecarPaths(outputPath);
  for (let index = 1; index <= 20; index++) {
    const scenePath = path.join(path.dirname(outputPath), 'production_attempt_final_cinecode_scene_' + String(index).padStart(2, '0') + '.mp4');
    for (const artifact of [scenePath, scenePath + '.rendering.mp4', scenePath + '.render.json', scenePath + '.render.json.tmp']) {
      assert.equal(paths.includes(artifact), false,
        'CineCode scene output is independently attempt-scoped and must not be deleted with final assembly files');
    }
  }
  assert.ok(paths.includes(outputPath + '.assembly.json'));
}
async function run() {
  testVideoAttemptCleanupExcludesIndependentCineCodeSceneArtifacts();
  await testNarrationUsesAttemptScopedOutputsAndPreservesEarlierAttempt();
  await testNarrationOutputIsRemovedAfterLeaseLoss();
  await testCaptionsUseAttemptScopedPathsAndPreserveEarlierAttempt();
  await testCaptionOutputIsRemovedAfterLeaseLoss();
  await testFinalVideoOutputIsPreservedAfterLeaseLossForRecovery();
  await testThumbnailFallbackOutputIsRemovedAfterLeaseLoss();
  await testSimulationArtifactIsRemovedAfterLeaseLoss();
  console.log('Production attempt-scoped media artifact tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
