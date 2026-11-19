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

function buildAudienceDemand(engagementInsights = []) {
  const demand = [];
  for (const insight of engagementInsights || []) {
    if (insight?.analysisMethod !== 'ai') continue;
    for (const theme of insight.themes || []) {
      if (!['request', 'question'].includes(theme.kind)) continue;
      const title = String(theme.title || '').trim();
      const count = Math.max(0, Number(theme.count) || 0);
      if (!title || count < 3) continue;
      demand.push({
        topic: title,
        count,
        summary: String(theme.summary || '').slice(0, 240),
        videoId: insight.videoId || null
      });
    }
  }
  return demand;
}

function audienceDemandForTopic(topic, audienceDemand = []) {
  const matches = (audienceDemand || []).map(item => ({
    ...item,
    similarity: overlapScore(topic, item.topic)
  })).filter(item => item.similarity !== null && item.similarity >= 20);
  if (!matches.length) return null;
  const totalAsks = matches.reduce((sum, item) => sum + item.count, 0);
  return {
    score: clamp(Math.round((Math.log1p(totalAsks) / Math.log1p(30)) * 100)),
    askCount: totalAsks,
    matchingThemes: matches.length,
    themes: matches.slice(0, 5).map(item => ({
      topic: item.topic,
      count: item.count,
      summary: item.summary,
      videoId: item.videoId
    }))
  };
}

function scoreTrendIdeas(ideas, trendTopics, channelStrategy = {}, performanceSnapshots = [], audienceDemand = []) {
  const trends = new Map((trendTopics || []).map(item => [String(item.topic || '').toLowerCase(), item]));
  const maxTrend = Math.max(1, ...(trendTopics || []).map(item => Number(item.score) || 0));
  const profile = [
    channelStrategy.objective,
    channelStrategy.audience,
    channelStrategy.value_proposition || channelStrategy.valueProposition,
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
    const demand = audienceDemandForTopic(`${sourceTopic} ${topic}`, audienceDemand);

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

    let weights;
    let score;
    if (demand && performance !== null) {
      weights = { trend: 0.3, channelFit: 0.2, historicalPerformance: 0.2, audienceDemand: 0.3 };
      score = Math.round(trendScore * weights.trend + channelFit * weights.channelFit +
        performance * weights.historicalPerformance + demand.score * weights.audienceDemand);
    } else if (demand) {
      weights = { trend: 0.4, channelFit: 0.25, historicalPerformance: 0, audienceDemand: 0.35 };
      score = Math.round(trendScore * weights.trend + channelFit * weights.channelFit +
        demand.score * weights.audienceDemand);
    } else if (performance !== null) {
      weights = { trend: 0.4, channelFit: 0.3, historicalPerformance: 0.3, audienceDemand: 0 };
      score = Math.round(trendScore * weights.trend + channelFit * weights.channelFit +
        performance * weights.historicalPerformance);
    } else {
      weights = { trend: 0.55, channelFit: 0.45, historicalPerformance: 0, audienceDemand: 0 };
      score = Math.round(trendScore * weights.trend + channelFit * weights.channelFit);
    }

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
        audienceDemand: demand?.score ?? null,
        audienceAskCount: demand?.askCount || 0,
        audienceThemeCount: demand?.matchingThemes || 0,
        audienceEvidence: demand?.themes || [],
        weights
      }
    };
  }).filter(Boolean).sort((a, b) => b.score - a.score);
}

module.exports = { scoreTrendIdeas, overlapScore, buildAudienceDemand, audienceDemandForTopic };
