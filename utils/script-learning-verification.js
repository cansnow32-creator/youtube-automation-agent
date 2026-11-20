const VERIFIED_HOOK_LENGTHS = new Set(['concise', 'extended']);
const WORDS_PER_MINUTE = 130;

function normalizePreference(value) {
  return String(value || '').trim().toLowerCase().replace(/[\\s-]+/g, '_');
}

function countWords(value) {
  return String(value || '').trim().split(/\\s+/).filter(Boolean).length;
}

function collectSpokenText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(collectSpokenText).filter(Boolean).join(' ');
  if (!value || typeof value !== 'object') return '';
  return Object.entries(value)
    .filter(([key]) => !['type', 'duration', 'title', 'metadata', 'strategy'].includes(key))
    .map(([, item]) => collectSpokenText(item))
    .filter(Boolean)
    .join(' ');
}

function parseMinuteRange(value) {
  const normalized = String(value || '').toLowerCase().replace(/[–—]/g, '-');
  const match = normalized.match(/^\\s*(\\d+(?:\\.\\d+)?)\\s*(?:-|to)\\s*(\\d+(?:\\.\\d+)?)\\s*(?:minutes?|mins?|m)\\s*$/);
  if (!match) return null;
  const minimum = Number(match[1]);
  const maximum = Number(match[2]);
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum <= 0 || maximum < minimum) return null;
  return { minimum, maximum };
}

function verifyAppliedScriptLearnings(learnings = [], script = {}) {
  const verified = [];
  const seen = new Set();
  const hookText = typeof script.hook === 'string' ? script.hook : script.hook?.text;
  const hookWordCount = countWords(hookText);
  const spokenText = [
    hookText,
    collectSpokenText(script.introduction),
    collectSpokenText(script.mainContent?.sections || script.sections || []),
    collectSpokenText(script.conclusion),
    collectSpokenText(script.callToAction || script.cta)
  ].filter(Boolean).join(' ');
  const scriptWordCount = countWords(spokenText);
  const estimatedMinutes = scriptWordCount > 0 ? scriptWordCount / WORDS_PER_MINUTE : null;

  for (const item of Array.isArray(learnings) ? learnings : []) {
    const recommendationId = String(item?.recommendationId || '').trim();
    if (!recommendationId || seen.has(recommendationId)) continue;
    const preference = String(item.proposedChange?.prefer || '').trim();

    if (item.category === 'hookLength' && hookText && hookWordCount) {
      const expectedValue = normalizePreference(preference);
      if (!VERIFIED_HOOK_LENGTHS.has(expectedValue)) continue;
      const observedValue = hookWordCount <= 40 ? 'concise' : 'extended';
      if (observedValue !== expectedValue) continue;
      seen.add(recommendationId);
      verified.push({
        recommendationId: recommendationId.slice(0, 120),
        category: 'hookLength',
        expectedValue,
        observedValue,
        observedWordCount: hookWordCount,
        verificationMethod: 'generated_hook_word_count_threshold_40',
        status: 'verified_applied'
      });
      continue;
    }

    if (item.category === 'length' && estimatedMinutes !== null) {
      const range = parseMinuteRange(preference);
      if (!range || estimatedMinutes < range.minimum || estimatedMinutes > range.maximum) continue;
      seen.add(recommendationId);
      verified.push({
        recommendationId: recommendationId.slice(0, 120),
        category: 'length',
        expectedValue: preference.slice(0, 100),
        expectedMinimumMinutes: range.minimum,
        expectedMaximumMinutes: range.maximum,
        observedWordCount: scriptWordCount,
        estimatedMinutes: Number(estimatedMinutes.toFixed(2)),
        wordsPerMinuteAssumption: WORDS_PER_MINUTE,
        verificationMethod: 'generated_spoken_word_count_estimated_minutes_130_wpm',
        status: 'verified_applied'
      });
    }
  }
  return verified.slice(0, 8);
}

module.exports = { verifyAppliedScriptLearnings, parseMinuteRange, countWords };
