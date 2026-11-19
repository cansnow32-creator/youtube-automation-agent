function tokenize(value) {
  return new Set(String(value || '').toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/i)
    .filter(token => token.length > 2));
}

function overlapScore(left, right) {
  const a = tokenize(left);
  const b = tokenize(right);
  if (!a.size || !b.size) return null;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return Math.round((intersection / new Set([...a, ...b]).size) * 100);
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function scoreTrendIdeas(ideas, trendTopics, channelStrategy = {}, performanceSnapshots = []) {
  const trends = new Map((trendTopics || []).map(item => [String(item.topic || '').toLowerCase(), item]));
  const maxTrend = Math.max(1, ...(trendTopics || []).map(item => Number(item.score) || 0));
  const profile = [
    channelStrategy.objective,
    channelStrategy.audience,
    channelStrategy.value_proposition,
    ...(channelStrategy.contentPillars || [])
  ].filter(Boolean).join(' ');
  const snapshots = (performanceSnapshots || []).filter(item => !item.simulated && item.contentAttributes?.topic);

  return (ideas || []).map(idea => {
    const sourceTopic = String(idea.sourceTopic || '').trim();
    const trend = trends.get(sourceTopic.toLowerCase());
    const topic = String(idea.topic || '').trim();
    if (!trend || !topic) return null;

    const rawTrend = Math.max(0, Number(trend.score) || 0);
    const trendScore = clamp(Math.round((Math.log1p(rawTrend) / Math.log1p(maxTrend)) * 100));
    const fit = overlapScore(`${sourceTopic} ${topic}`, profile);
    const channelFit = fit === null ? 50 : fit;

    const matchingHistory = snapshots.map(snapshot => ({
      snapshot,
      similarity: overlapScore(sourceTopic, snapshot.contentAttributes.topic)
    })).filter(item => item.similarity !== null && item.similarity >= 20);
    const performance = matchingHistory.length
      ? clamp(Math.round(matchingHistory.reduce((sum, item) => {
        const metrics = item.snapshot.metrics || {};
        const score = Number(metrics.performanceScore);
        const ctr = Number(metrics.ctr);
        const retention = Number(metrics.retention);
        const components = [];
        if (Number.isFinite(score)) components.push(clamp(score));
        if (Number.isFinite(ctr)) components.push(clamp(ctr * 10));
        if (Number.isFinite(retention)) components.push(clamp(retention));
        return sum + (components.length ? components.reduce((a, b) => a + b, 0) / components.length : 50);
      }, 0) / matchingHistory.length))
      : null;

    const score = performance === null
      ? Math.round(trendScore * 0.55 + channelFit * 0.45)
      : Math.round(trendScore * 0.4 + channelFit * 0.3 + performance * 0.3);

    return {
      ...idea,
      sourceTopic,
      topic,
      angle: String(idea.angle || '').trim(),
      format: ['explainer', 'tutorial', 'list', 'review', 'story'].includes(idea.format) ? idea.format : 'explainer',
      rationale: String(idea.rationale || '').trim(),
      score,
      scoreBreakdown: {
        trend: trendScore,
        channelFit,
        historicalPerformance: performance,
        historicalSampleSize: matchingHistory.length,
        weights: performance === null
          ? { trend: 0.55, channelFit: 0.45, historicalPerformance: 0 }
          : { trend: 0.4, channelFit: 0.3, historicalPerformance: 0.3 }
      }
    };
  }).filter(Boolean).sort((a, b) => b.score - a.score);
}

module.exports = { scoreTrendIdeas, overlapScore };
