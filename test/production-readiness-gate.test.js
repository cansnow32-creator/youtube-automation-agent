const assert = require('node:assert/strict');
const { ProductionReadinessService } = require('../utils/production-readiness-service');

const NOW = new Date('2026-11-19T12:00:00.000Z');

function serviceWith(latest) {
  return new ProductionReadinessService({
    getLatestReadinessRun: async () => latest
  }, {}, { now: () => NOW });
}

async function rejectsWithStatus(promise, status, message) {
  await assert.rejects(promise, error => {
    assert.equal(error.status, status);
    assert.match(error.message, message);
    return true;
  });
}

async function run() {
  const unverified = serviceWith(null);
  await rejectsWithStatus(
    unverified.assertReady('Autonomous production'),
    409,
    /Run the verified production readiness check/
  );

  const stale = serviceWith({
    status: 'passed',
    completed_at: '2026-11-18T11:59:59.000Z',
    checks: []
  });
  await rejectsWithStatus(
    stale.assertReady('Automated generation'),
    409,
    /older than 24 hours/
  );

  const failed = serviceWith({
    status: 'failed',
    completed_at: NOW.toISOString(),
    checks: [{ id: 'youtube_access', blocking: true, status: 'failed' }]
  });
  await rejectsWithStatus(
    failed.assertReady('Autonomous production'),
    409,
    /youtube_access/
  );

  const passed = serviceWith({
    status: 'passed',
    completed_at: NOW.toISOString(),
    checks: [{ id: 'youtube_access', blocking: true, status: 'passed' }]
  });
  const passedSummary = await passed.assertReady('Autonomous production');
  assert.equal(passedSummary.status, 'passed');

  const warning = serviceWith({
    status: 'warning',
    completed_at: NOW.toISOString(),
    checks: [
      { id: 'youtube_access', blocking: true, status: 'passed' },
      { id: 'image_provider', blocking: false, status: 'skipped' }
    ]
  });
  const warningSummary = await warning.assertReady('Automated generation');
  assert.equal(warningSummary.status, 'warning');
  assert.deepEqual(warningSummary.blockingFailures, []);

  const originalFetch = global.fetch;
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  const originalGroqKey = process.env.GROQ_API_KEY;
  const originalOllamaModel = process.env.OLLAMA_MODEL;
  const originalOllamaUrl = process.env.OLLAMA_BASE_URL;
  try {
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    process.env.GROQ_API_KEY = 'test-groq-key';
    process.env.OLLAMA_MODEL = 'qwen3.5:4b';
    process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:11434/';
    global.fetch = async url => {
      assert.equal(url, 'http://127.0.0.1:11434/api/tags');
      return { ok: true, json: async () => ({ models: [{ name: 'qwen3.5:4b' }] }) };
    };
    const quality = new ProductionReadinessService({}, { credentials: { gemini: { apiKey: 'saved-gemini-key' } } });
    const qualityResult = await quality.probeQualityPipeline();
    assert.equal(qualityResult.details.ollamaModel, 'qwen3.5:4b');
    assert.equal(qualityResult.details.geminiConfigured, true);
    assert.equal(qualityResult.details.groqConfigured, true);

    global.fetch = async () => ({ ok: true, json: async () => ({ models: [{ name: 'llama3:latest' }] }) });
    await assert.rejects(quality.probeQualityPipeline(), /Ollama model qwen3.5:4b is not installed/);

    delete process.env.GROQ_API_KEY;
    await assert.rejects(quality.probeQualityPipeline(), /Groq reviewer is not configured/);
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries({
      GEMINI_API_KEY: originalGeminiKey,
      GROQ_API_KEY: originalGroqKey,
      OLLAMA_MODEL: originalOllamaModel,
      OLLAMA_BASE_URL: originalOllamaUrl
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  const previousEnabled = process.env.QUALITY_PIPELINE_ENABLED;
  try {
    process.env.QUALITY_PIPELINE_ENABLED = 'true';
    const runDb = {
      generateId: () => 'quality_readiness_test',
      saveReadinessRun: async value => value
    };
    const passingProbe = label => async () => ({ message: `${label} verified` });
    const enabledService = new ProductionReadinessService(runDb, { credentials: {} }, {
      probes: {
        text: passingProbe('Text'),
        qualityPipeline: passingProbe('Quality pipeline'),
        image: passingProbe('Image'),
        videoProvider: passingProbe('Video'),
        narration: passingProbe('Narration'),
        videoAssembly: passingProbe('Assembly'),
        youtube: passingProbe('YouTube'),
        metadata: passingProbe('Metadata')
      }
    });
    const enabledRun = await enabledService.run();
    const qualityCheck = enabledRun.checks.find(check => check.id === 'quality_pipeline');
    assert.equal(qualityCheck?.blocking, true);
    assert.equal(qualityCheck?.status, 'passed');
  } finally {
    if (previousEnabled === undefined) delete process.env.QUALITY_PIPELINE_ENABLED;
    else process.env.QUALITY_PIPELINE_ENABLED = previousEnabled;
  }

  const { PublishingSchedulingAgent } = require('../agents/publishing-scheduling-agent');
  const recent = new Date().toISOString();
  const schedule = () => ({
    id: 'readiness-publish-test', productionId: 'readiness-publish-test',
    title: 'Readiness publish test', status: 'scheduled',
    metadata: { audio: { intentionalSilence: true, silenceReason: 'This test fixture is intentionally silent.', silenceConfirmedAt: recent } }
  });
  async function verifyPublishGate(readinessRun, expectedBlocked, expectedReason) {
    let uploadAttempts = 0;
    const entry = schedule();
    const publisher = new PublishingSchedulingAgent({
      getLatestReadinessRun: async () => readinessRun,
      updateScheduleEntry: async () => {}
    }, {});
    publisher.publishQueue = [entry];
    publisher.uploadToYouTube = async () => { uploadAttempts++; throw new Error('UPLOAD_REACHED'); };
    let error;
    try { await publisher.publishContent(entry.productionId); } catch (caught) { error = caught; }
    if (expectedBlocked) {
      assert.equal(error?.code, 'READINESS_BLOCKED');
      assert.match(error.message, expectedReason);
      assert.equal(uploadAttempts, 0, 'YouTube upload must not start when readiness is not current and valid');
    } else {
      assert.match(error?.message || '', /UPLOAD_REACHED/);
      assert.equal(uploadAttempts, 1, 'A fresh passed/warning readiness result should permit the upload path');
    }
  }
  await verifyPublishGate(null, true, /Run the verified production readiness check/);
  await verifyPublishGate({ status: 'passed', completed_at: '2026-11-18T00:00:00.000Z', checks: [] }, true, /older than 24 hours/);
  await verifyPublishGate({ status: 'failed', completed_at: recent, checks: [{ id: 'youtube_access', blocking: true, status: 'failed' }] }, true, /youtube_access/);
  await verifyPublishGate({ status: 'running', completed_at: recent, checks: [] }, true, /status \(running\)/);
  await verifyPublishGate({ status: 'passed', completed_at: recent, checks: [] }, false);
  await verifyPublishGate({ status: 'warning', completed_at: recent, checks: [{ id: 'optional_image', blocking: false, status: 'skipped' }] }, false);

  process.stdout.write('Production readiness gate tests passed\\n');
}

run().catch(error => {
  process.stderr.write(`Production readiness gate tests failed: ${error.stack || error.message}\\n`);
  process.exitCode = 1;
});
