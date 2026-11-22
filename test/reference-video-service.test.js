const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ReferenceVideoService } = require('../utils/reference-video-service');

async function run() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reference-video-'));
  const records = new Map();
  const db = {
    async saveReferenceVideo(record) { records.set(record.id, record); return record; },
    async getReferenceVideo(id) { return records.get(id) || null; }
  };
  const referenceRoot = path.join(directory, 'references');
  const service = new ReferenceVideoService(db, {
    dataRoot: referenceRoot,
    getMediaDuration: async () => 12,
    runFFmpeg: async args => fs.writeFile(args.at(-1), Buffer.from('sample-frame'))
  });
  try {
    const bytes = Buffer.alloc(128);
    bytes.write('ftyp', 4, 'ascii');
    const record = await service.upload(bytes, 'sample reference.mp4', 'video/mp4');
    assert.equal(record.analysisStatus, 'pending');
    assert.equal(record.durationSeconds, 12);
    assert.equal(record.framePaths.length, 6);
    assert.match(record.originalName, /sample_reference\.mp4/);
    const originalFrame = record.framePaths[0];
    assert.equal(await service.getFrame(record.id, 0), originalFrame);
    assert.equal(await service.getFrame(record.id, 99), null);
    const outsideFile = path.join(directory, 'outside.jpg');
    await fs.writeFile(outsideFile, Buffer.from('outside-data'));
    record.framePaths[0] = outsideFile;
    assert.equal(await service.getFrame(record.id, 0), null, 'database paths outside the reference root must not be served');
    const symlinkPath = path.join(path.dirname(originalFrame), 'external-frame.jpg');
    await fs.symlink(outsideFile, symlinkPath);
    record.framePaths[0] = symlinkPath;
    assert.equal(await service.getFrame(record.id, 0), null, 'symlinks escaping the reference root must not be served');
    record.framePaths[0] = originalFrame;
    const publicRecord = service.toPublicRecord(record);
    assert.equal(publicRecord.frameUrls.length, 6);
    assert.equal('filePath' in publicRecord, false);
    await assert.rejects(() => service.upload(Buffer.alloc(128), 'bad.mp4', 'video/mp4'), /does not match/);
    await assert.rejects(() => service.upload(bytes, 'bad.avi', 'video/x-msvideo'), /Supported reference formats/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
  process.stdout.write('Reference video service tests passed\\n');
}

run().catch(error => {
  process.stderr.write('Reference video service tests failed: ' + (error.stack || error.message) + '\\n');
  process.exitCode = 1;
});
