const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ShortsRepurposingService } = require('../utils/shorts-repurposing-service');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shorts-approval-lease-'));
  const outputPath = path.join(root, 'short.mp4');
  await fs.writeFile(outputPath, Buffer.from('rendered-short'));
  let scheduleCalls = 0;
  let clipWrites = 0;
  const clip = {
    id: 'short-1', productionId: 'production-1', status: 'rendered',
    title: 'Approved Short', description: 'Description', tags: ['test'],
    outputPath, captionsPath: null, duration: 30, publishTime: new Date(Date.now() + 3600000).toISOString(),
    privacyStatus: 'private'
  };
  const bundle = {
    review_status: 'approved',
    provenance: { status: 'verified', containsSyntheticMedia: false },
    scenes: [{ id: 'scene-1', status: 'ready', narrationStatus: 'current', assetOrigin: 'generated' }],
    assets: { audio: { intentionalSilence: true, silenceReason: 'This clip intentionally contains no narration.', silenceConfirmedAt: new Date().toISOString() } }
  };
  const db = {
    getProductionBundle: async () => bundle,
    getShortClip: async () => clip,
    updateShortClip: async () => { clipWrites += 1; return clip; }
  };
  const publishing = {
    scheduleContent: async input => {
      scheduleCalls += 1;
      assert.equal(input.shortClipId, 'short-1');
      return { id: 'schedule-1', status: 'scheduled' };
    }
  };
  const service = new ShortsRepurposingService(db, publishing, { dataRoot: root });
  let assertions = 0;
  const leaseError = Object.assign(new Error('production lease lost'), { code: 'SCENE_EDIT_LEASE_LOST', status: 409 });
  try {
    await assert.rejects(
      service.approve('production-1', 'short-1', { confirmed: true }, {
        assertLease: async () => {
          assertions += 1;
          if (assertions === 4) throw leaseError;
        }
      }),
      error => error === leaseError
    );
    assert.equal(scheduleCalls, 1, 'the schedule may already be durable and must be reused on retry');
    assert.equal(clipWrites, 0, 'a stale approval worker must not update the Short after losing its lease');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  process.stdout.write('Shorts approval lease fencing tests passed\\n');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
