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
    .replaceAll('\\\\', '/')
    .replaceAll(':', '\\\\:')
    .replaceAll("'", "\\\\'");
  const style = [
    `FontName=${fontName}`, `FontSize=${fontSize}`, `Bold=${bold}`,
    `PrimaryColour=${color}`, 'OutlineColour=&H00000000', 'BorderStyle=1',
    'Outline=2', 'Shadow=1', `Alignment=${alignment}`, `MarginV=${margin}`
  ].join(',');
  return `subtitles='${escapedPath}':force_style='${style}'`;
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

module.exports = { buildSubtitleFilter, describeSubtitleApplication };
