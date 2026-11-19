const path = require('path');

function normalizeDirection(direction = {}) {
  if (typeof direction === 'string') return { typography: direction, placement: '' };
  return direction && typeof direction === 'object' ? direction : {};
}

function buildSubtitleFilter(captionsPath, rawDirection = {}) {
  if (!captionsPath) throw new Error('A captions file is required to apply subtitle direction');
  const direction = normalizeDirection(rawDirection);
  const typography = String(direction.typography || '').toLowerCase();
  const placement = String(direction.placement || '').toLowerCase();

  const fontName = /serif/.test(typography) ? 'Georgia'
    : /mono/.test(typography) ? 'Consolas'
      : /rounded/.test(typography) ? 'Trebuchet MS' : 'Arial';
  const fontSize = /large|headline|bold/.test(typography) ? 26
    : /small|minimal|subtle/.test(typography) ? 18 : 22;
  const bold = /bold|heavy|headline/.test(typography) ? 1 : 0;
  const color = /yellow|gold/.test(typography) ? '&H0000D7FF' : '&H00FFFFFF';
  const alignment = /top|upper/.test(placement) ? 8
    : /center|middle/.test(placement) ? 5 : 2;
  const margin = alignment === 8 ? 90 : alignment === 5 ? 0 : 110;

  const escapedPath = path.resolve(captionsPath)
    .replaceAll('\', '/')
    .replaceAll(':', '\:')
    .replaceAll("'", "\'");
  const style = [
    `FontName=${fontName}`, `FontSize=${fontSize}`, `Bold=${bold}`,
    `PrimaryColour=${color}`, 'OutlineColour=&H00000000', 'BorderStyle=1',
    'Outline=2', 'Shadow=1', `Alignment=${alignment}`, `MarginV=${margin}`
  ].join(',');
  return `subtitles='${escapedPath}':force_style='${style}'`;
}

function validateSrtContent(content) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('SRT captions must contain at least one subtitle cue');
  }
  const blocks = content.trim().split(/\r?\n\s*\r?\n/);
  const timestamp = /^(\d{2,}:\d{2}:\d{2},\d{3}) --> (\d{2,}:\d{2}:\d{2},\d{3})$/;
  let validCues = 0;
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    if (!/^\d+$/.test((lines[0] || '').trim())) continue;
    const match = timestamp.exec((lines[1] || '').trim());
    const text = lines.slice(2).join(' ').trim();
    if (!match || !text) throw new Error('SRT captions contain a malformed or empty subtitle cue');
    const toMs = value => {
      const [clock, millis] = value.split(',');
      const [hours, minutes, seconds] = clock.split(':').map(Number);
      return ((hours * 60 + minutes) * 60 + seconds) * 1000 + Number(millis);
    };
    if (toMs(match[2]) <= toMs(match[1])) {
      throw new Error('SRT subtitle cue end time must be after its start time');
    }
    validCues++;
  }
  if (!validCues) throw new Error('SRT captions must contain at least one valid subtitle cue');
  return { cueCount: validCues };
}

function describeSubtitleApplication(rawDirection = {}) {
  const direction = normalizeDirection(rawDirection);
  const animation = String(direction.animation || '').trim();
  return {
    typographyApplied: true,
    placementApplied: true,
    animationApplied: false,
    requestedAnimation: animation || null,
    note: animation
      ? 'Subtitle typography and placement were applied. Per-word or animated subtitle motion is not supported by the current SRT burn-in renderer.'
      : 'Subtitle typography and placement were applied using the local FFmpeg renderer.'
  };
}

module.exports = { buildSubtitleFilter, describeSubtitleApplication, validateSrtContent };
