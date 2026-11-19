const TITLE_PATTERNS = [
  { id: 'numbered_list', label: 'Numbered list', pattern: /\b(?:top\s*\d+|\d+\s+(?:ways|tips|mistakes|steps|reasons|things)|\d+\s+(?:yol|ipucu|hata|adım|neden|şey))\b/i },
  { id: 'how_to', label: 'How-to / tutorial', pattern: /\b(?:how to|how do|guide to|tutorial|nasıl|rehber|adım adım)\b/i },
  { id: 'question', label: 'Question-led', pattern: /[?？]|\b(?:why|what|when|neden|nasıl|ne zaman|ne olur)\b/i },
  { id: 'comparison', label: 'Comparison', pattern: /\b(?:vs\.?|versus|compared|comparison|karşılaştırma|hangisi|farkı)\b/i },
  { id: 'warning_mistake', label: 'Warning / mistake', pattern: /\b(?:mistakes?|avoid|warning|never|hata|sakın|kaçın|yanlış)\b/i },
  { id: 'curiosity_reveal', label: 'Curiosity / reveal', pattern: /\b(?:secret|truth|revealed|hidden|shocking|gerçek|sır|gizli|ortaya çıktı)\b/i }
];

function classifyTitlePattern(title) {
  const value = String(title || '').trim();
  if (!value) return { id: 'unclassified', label: 'Unclassified' };
  return TITLE_PATTERNS.find(item => item.pattern.test(value)) || {
    id: 'direct_statement',
    label: 'Direct statement'
  };
}

function classifyVideoFormat(title, description = '') {
  const value = `${title || ''} ${description || ''}`.toLowerCase();
  if (/\b(?:review|reviewed|test|tested|inceleme|deneyim)\b/i.test(value)) return 'review';
  if (/\b(?:tutorial|how to|guide|nasıl|rehber|adım adım)\b/i.test(value)) return 'tutorial';
  if (/\b(?:story|storytime|hikaye|öykü|başarı hikayesi)\b/i.test(value)) return 'story';
  if (/\b(?:top\s*\d+|\d+\s+(?:ways|tips|mistakes|steps|yol|ipucu|hata|adım))\b/i.test(value)) return 'list';
  if (/\b(?:explained|explain|explained simply|açıklandı|anlatım)\b/i.test(value)) return 'explainer';
  return 'other';
}

function analyzeVideoTemplates(videos = []) {
  const groups = new Map();
  const usable = (videos || []).filter(video => video?.snippet?.title);
  const channelAverage = usable.reduce((sum, video) =>
    sum + (Number(video.statistics?.viewCount) || 0), 0) / Math.max(1, usable.length);

  for (const video of usable) {
    const title = String(video.snippet.title);
    const description = String(video.snippet.description || '');
    const pattern = classifyTitlePattern(title);
    const format = classifyVideoFormat(title, description);
    const key = `${pattern.id}:${format}`;
    if (!groups.has(key)) groups.set(key, {
      patternId: pattern.id,
      patternLabel: pattern.label,
      format,
      sampleCount: 0,
      totalViews: 0,
      evidence: []
    });
    const group = groups.get(key);
    const views = Math.max(0, Number(video.statistics?.viewCount) || 0);
    group.sampleCount++;
    group.totalViews += views;
    group.evidence.push({
      url: video.id ? `https://www.youtube.com/watch?v=${video.id}` : null,
      title,
      views,
      publisher: video.snippet.channelTitle || 'Configured competitor channel'
    });
  }

  return [...groups.values()]
    .map(group => ({
      patternId: group.patternId,
      patternLabel: group.patternLabel,
      format: group.format,
      sampleCount: group.sampleCount,
      averageViews: Math.round(group.totalViews / group.sampleCount),
      relativeToChannelAverage: channelAverage > 0
        ? Number((group.totalViews / group.sampleCount / channelAverage).toFixed(2))
        : null,
      evidence: group.evidence.sort((a, b) => b.views - a.views).slice(0, 3)
    }))
    .sort((a, b) => b.averageViews - a.averageViews);
}

module.exports = { classifyTitlePattern, classifyVideoFormat, analyzeVideoTemplates };
