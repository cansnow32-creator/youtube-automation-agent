const assert = require('node:assert/strict');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { ProductionManagementAgent } = require('../agents/production-management-agent');

async function run() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agenttube-media-reuse-'));
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
      id: 'reuse-test',
      script,
      strategy: { approvedVideoConcept: { audioDirection: {} } },
      assets: { script: { ttsPath }, audio: null, captions: null },
      timeline: {},
      estimatedDuration: 20
    };
    agent.aiVideoGenerator = {
      lastNarrationResult: { provider: 'test', status: 'ready' },
      async generateTTSAudio(_text, outputPath) {
        ttsCalls++;
        await fs.writeFile(outputPath, Buffer.from('valid-audio'));
        this.lastNarrationResult = { provider: 'test', status: 'ready', directionApplied: false };
        return outputPath;
      },
      async isUsableAudioFile(filePath) {
        return Boolean(filePath && await fs.stat(filePath).then(s => s.isFile() && s.size > 0).catch(() => false));
      }
    };

    const audio = await agent.generateAudioNarration(production);
    assert.equal(ttsCalls, 1);
    assert.equal(production.assets.audio.sourceHash, crypto.createHash('sha256')
      .update(JSON.stringify({ ttsText: 'Narration text', audioDirection: {} })).digest('hex'));
    await agent.generateAudioNarration(production);
    assert.equal(ttsCalls, 1, 'valid narration should be reused on retry');

    await fs.unlink(audio);
    await agent.generateAudioNarration(production);
    assert.equal(ttsCalls, 2, 'missing narration must be regenerated');

    agent.createSRTCaptions = async () => {
      captionCalls++;
      return '1\n00:00:00,000 --> 00:00:02,000\nCaption text\n';
    };
    const captions = await agent.generateCaptions(production);
    assert.equal(captionCalls, 1);
    await agent.generateCaptions(production);
    assert.equal(captionCalls, 1, 'valid captions should be reused on retry');

    production.script.hook.text = 'Changed hook';
    await agent.generateCaptions(production);
    assert.equal(captionCalls, 2, 'changed script must regenerate captions');

    await fs.writeFile(captions, 'not an SRT file');
    await agent.generateCaptions(production);
    assert.equal(captionCalls, 3, 'corrupted captions must be regenerated');
    console.log('Production media artifact reuse tests passed.');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
