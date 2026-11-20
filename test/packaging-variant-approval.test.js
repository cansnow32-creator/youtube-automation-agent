const assert = require('node:assert/strict');
const { YouTubeAutomationAgent } = require('../index');

async function run() {
  const agent = Object.create(YouTubeAutomationAgent.prototype);
  const bundle = {
    id: 'packaging-approval-test',
    status: 'draft',
    strategy: { topic: 'Urban gardening' },
    script: { title: 'Original title' },
    thumbnail: { path: '/assets/control-thumbnail.png' },
    seo: { title: 'Original title', description: 'Description', tags: ['garden'] },
    assets: {
      thumbnail: { path: '/assets/control-thumbnail.png' },
      finalVideo: { path: '/assets/final.mp4' }
    },
    timeline: [],
    scheduled_publish_time: '2026-11-20T12:00:00.000Z',
    estimated_duration: 120,
    provenance: {},
    scenes: [],
    editorData: {
      factChecked: false,
      rightsConfirmed: false,
      packagingExperiment: {
        titleVariants: [
          { label: 'Control', title: 'Original title' },
          { label: 'Evidence-backed', title: 'The Hidden Cost of Fast Fashion' }
        ],
        thumbnailVariants: [
          { label: 'Control', path: '/assets/control-thumbnail.png' },
          { label: 'Centered', path: '/assets/centered-thumbnail.png' }
        ]
      }
    },
    schedule: null
  };

  assert.throws(
    () => agent.validateEditorData({ selectedTitleVariant: 99 }, bundle.editorData),
    /Selected title variant is invalid/
  );
  assert.throws(
    () => agent.validateEditorData({ selectedThumbnailVariant: -1 }, bundle.editorData),
    /Selected thumbnail variant is invalid/
  );

  let scheduledProduction;
  let savedReview;
  let updatedSchedule;
  agent.db = {
    getProductionBundle: async id => {
      assert.equal(id, bundle.id);
      return bundle;
    },
    getChannelProfile: async () => ({}),
    saveContentReview: async (id, review) => {
      savedReview = { id, ...review };
      return savedReview;
    },
    updateScheduleEntry: async entry => { updatedSchedule = { ...entry, metadata: { ...entry.metadata } }; return updatedSchedule; },
    updateProductionStatus: async (id, status) => {
      assert.equal(id, bundle.id);
      assert.equal(status, 'scheduled');
    }
  };
  agent.agents = {
    publishing: {
      loadPublishQueue: async () => {},
      scheduleContent: async production => {
        scheduledProduction = production;
        return {
          id: 'schedule-1',
          productionId: production.id,
          title: production.script.title,
          publishTime: production.scheduledPublishTime,
          status: 'scheduled',
          metadata: {
            seo: production.seo,
            thumbnail: production.assets.thumbnail
          }
        };
      }
    }
  };
  agent.operator = {
    runQualityChecks: async production => {
      assert.equal(production.script.title, 'The Hidden Cost of Fast Fashion');
      assert.equal(production.seo.title, 'The Hidden Cost of Fast Fashion');
      assert.equal(production.assets.thumbnail.path, '/assets/centered-thumbnail.png');
      return { passed: true, score: 96, checks: [], blockingFailures: [] };
    },
    notify: async () => {}
  };

  const result = await agent.approveContent(bundle.id, {
    selectedTitleVariant: 1,
    selectedThumbnailVariant: 1,
    factChecked: true,
    rightsConfirmed: true,
    publishTime: '2026-11-21T12:00:00.000Z'
  });

  assert.equal(scheduledProduction.script.title, 'The Hidden Cost of Fast Fashion');
  assert.equal(scheduledProduction.seo.title, 'The Hidden Cost of Fast Fashion');
  assert.equal(scheduledProduction.assets.thumbnail.path, '/assets/centered-thumbnail.png');
  assert.equal(result.schedule.metadata.thumbnail.path, '/assets/centered-thumbnail.png');
  assert.equal(savedReview.status, 'approved');
  assert.equal(savedReview.editorData.selectedTitleVariant, 1);
  assert.equal(savedReview.editorData.selectedThumbnailVariant, 1);
  assert.equal(savedReview.editorData.title, 'The Hidden Cost of Fast Fashion');

  bundle.schedule = {
    id: 'existing-schedule', productionId: bundle.id, title: 'Previously selected title',
    publishTime: '2026-11-22T12:00:00.000Z', status: 'paused',
    metadata: { preservedField: 'keep-me', seo: { title: 'Previously selected title' }, thumbnail: { path: '/assets/old-thumbnail.png' } }
  };
  const rescheduled = await agent.approveContent(bundle.id, {
    selectedTitleVariant: 1, selectedThumbnailVariant: 1,
    factChecked: true, rightsConfirmed: true,
    publishTime: '2026-11-23T12:00:00.000Z'
  });
  assert.equal(rescheduled.schedule.id, 'existing-schedule');
  assert.equal(updatedSchedule.title, 'The Hidden Cost of Fast Fashion');
  assert.equal(updatedSchedule.metadata.seo.title, 'The Hidden Cost of Fast Fashion');
  assert.equal(updatedSchedule.metadata.thumbnail.path, '/assets/centered-thumbnail.png');
  assert.equal(updatedSchedule.metadata.preservedField, 'keep-me');
  assert.equal(updatedSchedule.publishTime, '2026-11-23T12:00:00.000Z');
  assert.equal(updatedSchedule.status, 'scheduled');

  process.stdout.write('Packaging variant approval tests passed\\n');
}

run().catch(error => {
  process.stderr.write(`Packaging variant approval tests failed: ${error.stack || error.message}\\n`);
  process.exitCode = 1;
});
