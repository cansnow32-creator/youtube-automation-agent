function tokenize(value) {
  return new Set(String(value || '').toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(token => [...token].length > 2));
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

function historicalPerformanceForIdea(idea, sourceTopic, snapshots = []) {
  const latestByVideo = new Map();
  for (const snapshot of snapshots || []) {
    if (snapshot.simulated || !snapshot.videoId || !snapshot.contentAttributes) continue;
    const attributes = snapshot.contentAttributes;
    const topicSimilarity = overlapScore(sourceTopic, attributes.topic);
    const pillarSimilarity = overlapScore(idea.pillar, attributes.pillar);
    const formatMatch = Boolean(idea.format && attributes.format &&
      String(idea.format).toLowerCase() === String(attributes.format).toLowerCase());
    if (!((topicSimilarity !== null && topicSimilarity >= 20) ||
      (pillarSimilarity !== null && pillarSimilarity >= 40))) continue;

    const metrics = snapshot.metrics || {};
    const components = [];
    const performanceScore = Number(metrics.performanceScore);
    const ctr = Number(metrics.ctr);
    const retention = Number(metrics.retention);
    if (Number.isFinite(performanceScore)) components.push(clamp(performanceScore));
    if (Number.isFinite(ctr)) components.push(clamp(ctr * 10));
    if (Number.isFinite(retention)) components.push(clamp(retention));
    if (!components.length) continue;

    const relevance = (topicSimilarity !== null ? topicSimilarity * 0.65 : 0) +
      (pillarSimilarity !== null ? pillarSimilarity * 0.25 : 0) +
      (formatMatch ? 10 : 0);
    const sample = {
      videoId: snapshot.videoId,
      score: components.reduce((sum, value) => sum + value, 0) / components.length,
      relevance: Math.max(0.1, relevance),
      topicMatched: topicSimilarity !== null && topicSimilarity >= 20,
      pillarMatched: pillarSimilarity !== null && pillarSimilarity >= 40,
      formatMatched: formatMatch,
      measuredAt: snapshot.measuredAt || snapshot.measured_at || ''
    };
    const previous = latestByVideo.get(snapshot.videoId);
    if (!previous || String(sample.measuredAt) > String(previous.measuredAt)) {
      latestByVideo.set(snapshot.videoId, sample);
    }
  }

  const samples = [...latestByVideo.values()];
  if (!samples.length) return null;
  const totalWeight = samples.reduce((sum, item) => sum + item.relevance, 0);
  const rawScore = samples.reduce((sum, item) => sum + item.score * item.relevance, 0) / totalWeight;
  // Small samples are deliberately pulled toward neutral so one unusual video
  // cannot dominate the next weekly batch of ideas.
  const confidence = samples.length / (samples.length + 2);
  const adjustedScore = 50 + (rawScore - 50) * confidence;
  return {
    score: clamp(Math.round(adjustedScore)),
    rawScore: clamp(Math.round(rawScore)),
    sampleSize: samples.length,
    confidence: Number(confidence.toFixed(2)),
    topicMatchedCount: samples.filter(item => item.topicMatched).length,
    pillarMatchedCount: samples.filter(item => item.pillarMatched).length,
    formatMatchedCount: samples.filter(item => item.formatMatched).length
  };
}

function scoreViewerValue(idea = {}, audienceDemand = null) {
  const angle = String(idea.angle || '').trim();
  const rationale = String(idea.rationale || '').trim();
  const combined = `${angle} ${rationale}`.toLowerCase();
  if (!combined.trim()) return 45;
  const benefitTerms = /step|steps|guide|checklist|workflow|compare|comparison|avoid|fix|solve|learn|build|create|save|improve|choose|explained|tutorial|beginner|practical/i;
  const hasConcreteBenefit = benefitTerms.test(combined);
  const hasSpecificAngle = tokenize(angle).size >= 5;
  const hasAudienceDemand = Boolean(audienceDemand);
  return clamp(45 + (hasConcreteBenefit ? 25 : 0) + (hasSpecificAngle ? 20 : 0) + (hasAudienceDemand ? 10 : 0));
}

function scoreProductionFit(idea = {}, channelStrategy = {}) {
  const preferredFormat = String(channelStrategy.default_format || '').trim().toLowerCase();
  const ideaFormat = String(idea.format || '').trim().toLowerCase();
  if (!preferredFormat || !ideaFormat) return 75;
  return preferredFormat === ideaFormat ? 100 : 65;
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
  const snapshots = (performanceSnapshots || []).filter(item => !item.simulated);

  return (ideas || []).map(idea => {
    const sourceTopic = String(idea.sourceTopic || '').trim();
    const trend = trends.get(sourceTopic.toLowerCase());
    const topic = String(idea.topic || '').trim();
    if (!trend || !topic) return null;

    const rawTrend = Math.max(0, Number(trend.score) || 0);
    const rawTrendScore = clamp(Math.round((Math.log1p(rawTrend) / Math.log1p(maxTrend)) * 100));
    const sourceTypes = [...new Set((Array.isArray(trend.sources) ? trend.sources : [])
      .filter(source => typeof source === 'string' && source.trim()))];
    const evidence = Array.isArray(trend.evidence) ? trend.evidence : [];
    const hasEvidenceMetadata = Array.isArray(trend.sources) || Array.isArray(trend.evidence);
    // Pull weakly-supported trend scores toward neutral. This is deliberately
    // bounded so a single-source topic can still rank well when other signals agree.
    const trendEvidenceConfidence = hasEvidenceMetadata
      ? clamp(0.35 + Math.min(sourceTypes.length, 2) * 0.15 + Math.min(evidence.length, 3) * 0.1, 0, 0.95)
      : 1;
    const trendScore = clamp(Math.round(50 + (rawTrendScore - 50) * trendEvidenceConfidence));
    const fit = overlapScore(`${sourceTopic} ${topic}`, profile);
    const channelFit = fit === null ? 50 : fit;
    const demand = audienceDemandForTopic(`${sourceTopic} ${topic}`, audienceDemand);
    const historical = historicalPerformanceForIdea(idea, sourceTopic, snapshots);
    const performance = historical?.score ?? null;
    const viewerValue = scoreViewerValue(idea, demand);
    const productionFit = scoreProductionFit(idea, channelStrategy);

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

    score = Math.round(score * 0.8 + viewerValue * 0.1 + productionFit * 0.1);

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
        rawTrend: rawTrendScore,
        trendEvidenceConfidence: Number(trendEvidenceConfidence.toFixed(2)),
        trendSourceCount: sourceTypes.length,
        trendEvidenceCount: evidence.length,
        channelFit,
        viewerValue,
        productionFit,
        historicalPerformance: performance,
        historicalRawPerformance: historical?.rawScore ?? null,
        historicalSampleSize: historical?.sampleSize || 0,
        historicalConfidence: historical?.confidence ?? 0,
        historicalTopicMatches: historical?.topicMatchedCount || 0,
        historicalPillarMatches: historical?.pillarMatchedCount || 0,
        historicalFormatMatches: historical?.formatMatchedCount || 0,
        audienceDemand: demand?.score ?? null,
        audienceAskCount: demand?.askCount || 0,
        audienceThemeCount: demand?.matchingThemes || 0,
        audienceEvidence: demand?.themes || [],
        weights
      }
    };
  }).filter(Boolean).sort((a, b) => b.score - a.score);
}

function filterTrendIdeasForApproval(ideas, existingTopics = [], options = {}) {
  const minimumScore = Number.isFinite(Number(options.minimumScore)) ? Number(options.minimumScore) : 40;
  const minimumChannelFit = Number.isFinite(Number(options.minimumChannelFit)) ? Number(options.minimumChannelFit) : 12;
  const profile = [
    options.channelStrategy?.objective,
    options.channelStrategy?.audience,
    options.channelStrategy?.value_proposition || options.channelStrategy?.valueProposition,
    ...(options.channelStrategy?.contentPillars || [])
  ].filter(Boolean).join(' ');
  const hasChannelProfile = Boolean(profile.trim());
  const seen = (existingTopics || []).map(topic => {
    if (typeof topic === 'string') return topic.trim();
    return { topic: String(topic?.topic || '').trim(), angle: String(topic?.angle || '').trim(), pillar: String(topic?.pillar || '').trim() };
  }).filter(topic => typeof topic === 'string' ? Boolean(topic) : Boolean(topic.topic));
  const accepted = [];
  const rejected = { lowScore: 0, offAudience: 0, duplicate: 0, missingEvidence: 0, invalid: 0 };

  for (const idea of ideas || []) {
    const title = String(idea?.topic || '').trim();
    if (!title || title.length < 12 || !idea.sourceTopic) {
      rejected.invalid++;
      continue;
    }
    if (Number(idea.score) < minimumScore) {
      rejected.lowScore++;
      continue;
    }
    if (hasChannelProfile && Number(idea.scoreBreakdown?.channelFit ?? 50) < minimumChannelFit) {
      rejected.offAudience++;
      continue;
    }
    if (Number(idea.scoreBreakdown?.trendEvidenceCount || 0) < 1) {
      rejected.missingEvidence++;
      continue;
    }
    const angle = String(idea.angle || '').trim();
    const pillar = String(idea.pillar || '').trim();
    const duplicate = [...seen, ...accepted.map(item => item)]
      .some(previous => {
        const previousTitle = typeof previous === 'string' ? previous : String(previous.topic || '').trim();
        const previousAngle = typeof previous === 'string' ? '' : String(previous.angle || '').trim();
        const previousPillar = typeof previous === 'string' ? '' : String(previous.pillar || '').trim();
        const titleSimilarity = overlapScore(title, previousTitle);
        const angleSimilarity = angle && previousAngle ? overlapScore(angle, previousAngle) : null;
        const crossSimilarity = angle && previousTitle ? overlapScore(angle, previousTitle) : null;
        const reverseCrossSimilarity = previousAngle ? overlapScore(title, previousAngle) : null;
        const sharedPillar = pillar && previousPillar &&
          pillar.toLocaleLowerCase() === previousPillar.toLocaleLowerCase();
        return (titleSimilarity !== null && titleSimilarity >= 70) ||
          (angleSimilarity !== null && angleSimilarity >= 60) ||
          (sharedPillar && titleSimilarity !== null && titleSimilarity >= 55) ||
          (crossSimilarity !== null && crossSimilarity >= 65) ||
          (reverseCrossSimilarity !== null && reverseCrossSimilarity >= 65);
      });
    if (duplicate) {
      rejected.duplicate++;
      continue;
    }
    accepted.push(idea);
  }
  return { ideas: accepted, rejected };
}

module.exports = {
  scoreTrendIdeas,
  overlapScore,
  buildAudienceDemand,
  audienceDemandForTopic,
  scoreViewerValue,
  scoreProductionFit,
  filterTrendIdeasForApproval
};
