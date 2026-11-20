const VERIFIED_HOOK_LENGTHS = new Set(['concise', 'extended']);

function normalizePreference(value) {
  return String(value || '').trim().toLowerCase().replace(/[\\s-]+/g, '_');
}

function countWords(value) {
  return String(value || '').trim().split(/\\s+/).filter(Boolean).length;
}

function verifyAppliedScriptLearnings(learnings = [], script = {}) {
  const verified = [];
  const seen = new Set();
  const hookText = typeof script.hook === 'string' ? script.hook : script.hook?.text;
  const hookWordCount = countWords(hookText);
  if (!hookText || !hookWordCount) return verified;

  for (const item of Array.isArray(learnings) ? learnings : []) {
    const recommendationId = String(item?.recommendationId || '').trim();
    if (!recommendationId || seen.has(recommendationId) || item.category !== 'hookLength') continue;
    const expectedValue = normalizePreference(item.proposedChange?.prefer);
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
  }
  return verified.slice(0, 8);
}

module.exports = { verifyAppliedScriptLearnings };
