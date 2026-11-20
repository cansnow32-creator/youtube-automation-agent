const assert = require('node:assert/strict');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { ProductionManagementAgent } = require('../agents/production-management-agent');

async function run() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agenttube-media-reuse-'));
  const artifactPaths = new Set();
  try {
    const agent = Object.create(ProductionManagementAgent.prototype);
    let ttsCalls = 0;
    let captionCalls = 0;
    agent.logger = { info() {}, warn() {}, error() {} };
    const ttsPath = path.join(tempDir, 'script.txt');
    await fs.writeFile(ttsPath, 'Narration text');
    const script = {
      title: 'Reuse test',
      hook: { text: 'A short hook' },
      mainContent: { sections: [{ title: 'Section', content: 'Main text', duration: 10 }] },
      conclusion: { recap: ['Summary'], finalThought: 'The end' }
    };
    const production = {
      id: 'reuse-test-' + crypto.randomUUID(),
      script,
      strategy: { approvedVideoConcept: { audioDirection: {} } },
      assets: { script: { ttsPath }, audio: null, captions: null },
      timeline: { artifactAttemptId: 'attempt_a' },
      estimatedDuration: 20
    };
    agent.aiVideoGenerator = {
      lastNarrationResult: { provider: 'test', status: 'ready' },
      async generateTTSAudio(_text, outputPath) {
        ttsCalls++;
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, Buffer.from('valid-audio'));
        this.lastNarrationResult = { provider: 'test', status: 'ready', directionApplied: false };
        return outputPath;
      },
      async isUsableAudioFile(filePath) {
        return Boolean(filePath && await fs.stat(filePath).then(s => s.isFile() && s.size > 0).catch(() => false));
      }
    };

    const audioA = await agent.generateAudioNarration(production);
    artifactPaths.add(audioA);
    assert.equal(ttsCalls, 1);
    assert.equal(production.assets.audio.sourceHash, crypto.createHash('sha256')
      .update(JSON.stringify({ ttsText: 'Narration text', audioDirection: {} })).digest('hex'));
    production.timeline.artifactAttemptId = 'attempt_b';
    const reusedAudio = await agent.generateAudioNarration(production);
    assert.equal(reusedAudio, audioA);
    assert.equal(ttsCalls, 1, 'valid narration should be reused across a new production attempt');

    await fs.unlink(audioA);
    const audioB = await agent.generateAudioNarration(production);
    artifactPaths.add(audioB);
    assert.equal(ttsCalls, 2, 'missing narration must be regenerated');
    assert.notEqual(audioB, audioA);

    agent.createSRTCaptions = async () => {
      captionCalls++;
      return '1\n00:00:00,000 --> 00:00:02,000\nCaption text\n';
    };
    production.timeline.artifactAttemptId = 'attempt_c';
    const captionsA = await agent.generateCaptions(production);
    artifactPaths.add(captionsA);
    assert.equal(captionCalls, 1);
    production.timeline.artifactAttemptId = 'attempt_d';
    const reusedCaptions = await agent.generateCaptions(production);
    assert.equal(reusedCaptions, captionsA);
    assert.equal(captionCalls, 1, 'valid captions should be reused across a new production attempt');

    production.script.hook.text = 'Changed hook';
    const captionsB = await agent.generateCaptions(production);
    artifactPaths.add(captionsB);
    assert.equal(captionCalls, 2, 'changed script must regenerate captions');
    assert.notEqual(captionsB, captionsA);

    await fs.writeFile(captionsB, 'not an SRT file');
    await agent.generateCaptions(production);
    assert.equal(captionCalls, 3, 'corrupted captions must be regenerated');
    if (production.assets.audio?.path) artifactPaths.add(production.assets.audio.path);
    if (production.assets.captions?.path) artifactPaths.add(production.assets.captions.path);
    console.log('Production media artifact reuse tests passed.');
  } finally {
    await Promise.all([...artifactPaths].flatMap(file => [
      fs.rm(file, { force: true }),
      fs.rm(file + '.pcm', { force: true }),
      fs.rm(file + '.info', { force: true })
    ]));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
