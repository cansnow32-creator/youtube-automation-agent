const assert = require('node:assert/strict');
const { buildSubtitleFilter, describeSubtitleApplication, validateSrtContent } = require('../utils/subtitle-renderer');

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

const validSrt = '1\n00:00:00,000 --> 00:00:02,500\nA valid caption line\n\n2\n00:00:02,500 --> 00:00:04,000\nSecond caption\n';
assert.deepEqual(validateSrtContent(validSrt), { cueCount: 2 });
assert.throws(() => validateSrtContent(''), /at least one subtitle cue/);
assert.throws(() => validateSrtContent('1\nnot-a-time\nCaption'), /malformed/);
assert.throws(() => validateSrtContent('1\n00:00:02,000 --> 00:00:01,000\nBackwards'), /end time/);
assert.throws(() => validateSrtContent('1\n00:00:00,000 --> 00:00:01,000\n'), /empty subtitle cue/);

const application = describeSubtitleApplication({ animation: 'word by word' });
assert.equal(application.typographyApplied, true);
assert.equal(application.placementApplied, true);
assert.equal(application.animationApplied, false);
assert.match(application.note, /not supported/);
process.stdout.write('Subtitle renderer tests passed\n');
