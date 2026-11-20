const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { VideoConceptService } = require('../utils/video-concept-service');

async function run() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reference-analysis-'));
  const framePath = path.join(directory, 'frame.jpg');
  await fs.writeFile(framePath, Buffer.from('sample-image'));
  const record = {
    id: 'reference-1', originalName: 'reference.mp4', durationSeconds: 20,
    framePaths: [framePath], analysis: null, analysisStatus: 'pending'
  };
  const db = {
    async getReferenceVideo(id) { return id === record.id ? record : null; },
    async updateReferenceVideoAnalysis(id, analysis, status) {
      assert.equal(id, record.id);
      record.analysis = analysis;
      record.analysisStatus = status;
      return record;
    }
  };
  let sentBody;
  const service = new VideoConceptService(db, {
    fetch: async (_url, options) => {
      sentBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          message: { content: JSON.stringify({
            visualStyle: 'cinematic documentary',
            colorPalette: 'cool blue and warm highlights',
            composition: 'wide shots and close-ups',
            cameraLanguage: 'slow pans',
            editingRhythm: 'measured; inferred from sparse frames',
            subtitleTreatment: 'lower safe area',
            audioMood: 'not directly observable',
            observations: ['A sampled frame shows a wide exterior shot'],
            limitations: ['Still frames cannot establish exact timing or audio']
          }) }
        })
      };
    }
  });
  try {
    const analyzed = await service.analyzeReferenceVideo(record.id);
    assert.equal(analyzed.analysisStatus, 'complete');
    assert.equal(analyzed.analysis.visualStyle, 'cinematic documentary');
    assert.equal(sentBody.messages[0].images.length, 1);
    assert.equal(sentBody.messages[0].images[0], Buffer.from('sample-image').toString('base64'));
    assert.match(sentBody.messages[0].content, /style guidance only/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
  process.stdout.write('Reference video analysis tests passed\\n');
}

run().catch(error => {
  process.stderr.write('Reference video analysis tests failed: ' + (error.stack || error.message) + '\\n');
  process.exitCode = 1;
});
