const assert = require('node:assert/strict');
const { buildSubtitleFilter, describeSubtitleApplication } = require('../utils/subtitle-renderer');

const filter = buildSubtitleFilter('data/captions/demo.srt', {
  typography: 'large bold yellow sans',
  placement: 'top safe area',
  animation: 'word by word'
});
assert.match(filter, /FontName=Arial/);
assert.match(filter, /FontSize=26/);
assert.match(filter, /Bold=1/);
assert.match(filter, /PrimaryColour=&H0000D7FF/);
assert.match(filter, /Alignment=8/);
assert.throws(() => buildSubtitleFilter(null), /captions file is required/);

const application = describeSubtitleApplication({ animation: 'word by word' });
assert.equal(application.typographyApplied, true);
assert.equal(application.placementApplied, true);
assert.equal(application.animationApplied, false);
assert.match(application.note, /not supported/);
process.stdout.write('Subtitle renderer tests passed\\n');
