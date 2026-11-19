const OpenAI = require('openai');

const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
const DEFAULT_OLLAMA_MODEL = 'qwen3.5:4b';
const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b';
const MINIMUM_SCORE = 80;
const MAX_REVISIONS = 2;

function extractJson(value) {
  const text = String(value || '').trim().replace(/^\x60\x60\x60(?:json)?\s*/i, '').replace(/\x60\x60\x60$/, '').trim();
  try { return JSON.parse(text); } catch (_) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Reviewer returned invalid JSON');
    return JSON.parse(match[0]);
  }
}

class LocalFirstQualityPipeline {
  constructor(credentials = {}, options = {}) {
    this.credentials = credentials || {};
    this.enabled = options.enabled ?? process.env.QUALITY_PIPELINE_ENABLED === 'true';
    this.maxRevisions = Math.max(0, Math.min(5, Number.isInteger(options.maxRevisions) ? options.maxRevisions : Number.parseInt(process.env.QUALITY_MAX_REVISIONS || MAX_REVISIONS, 10) || MAX_REVISIONS));
    this.minimumScore = options.minimumScore ?? MINIMUM_SCORE;
    this.lastReport = null;
    this.ollamaUrl = String(process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_URL).replace(/\/$/, '');
    this.ollamaModel = process.env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL;
    this.geminiModel = this.credentials.gemini?.model || process.env.GEMINI_REVIEW_MODEL || 'gemini-3.8-flash';
    this.geminiKey = this.credentials.gemini?.apiKey || process.env.GEMINI_API_KEY;
    this.groqKey = process.env.GROQ_API_KEY;
    this.groqModel = process.env.GROQ_REVIEW_MODEL || DEFAULT_GROQ_MODEL;
  }

  async requestOllama(prompt) {
    const response = await fetch(`${this.ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.ollamaModel,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        format: 'json',
        options: { temperature: 0.4 }
      }),
      signal: AbortSignal.timeout(Number(process.env.OLLAMA_TIMEOUT_MS || 120000))
    });
    if (!response.ok) throw new Error(`Ollama request failed: HTTP ${response.status}`);
    const data = await response.json();
    const content = data?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('Ollama returned an empty draft');
    return content;
  }

  async requestGemini(prompt) {
    if (!this.geminiKey) throw new Error('Gemini reviewer is not configured (GEMINI_API_KEY or credentials.gemini.apiKey)');
    const { GoogleGenAI } = require('@google/genai');
    const client = new GoogleGenAI({ apiKey: this.geminiKey });
    const response = await client.models.generateContent({
      model: this.geminiModel,
      contents: prompt,
      config: { responseMimeType: 'application/json', maxOutputTokens: 1800 }
    });
    const content = response?.text;
    if (typeof content !== 'string' || !content.trim()) throw new Error('Gemini reviewer returned an empty response');
    return extractJson(content);
  }

  async requestGroq(prompt) {
    if (!this.groqKey) throw new Error('Groq reviewer is not configured (GROQ_API_KEY)');
    const client = new OpenAI({ apiKey: this.groqKey, baseURL: 'https://api.groq.com/openai/v1' });
    const response = await client.chat.completions.create({
      model: this.groqModel,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: 1800,
      response_format: { type: 'json_object' }
    });
    return extractJson(response?.choices?.[0]?.message?.content);
  }

  buildReviewPrompt(draft, platform) {
    return `You are an independent, strict content quality reviewer. Review this ${platform} script and its metadata. Return ONLY JSON: {"score":0,"approved":false,"blockers":[],"findings":[],"revision_instructions":[],"platform_metadata":{"youtube":{"title":"","description":"","hashtags":[],"tags":[]},"instagram_reels":{"caption":"","hashtags":[]},"tiktok":{"caption":"","hashtags":[]}}}. Score 0-100. Check factual accuracy and unsupported claims, originality, audience fit, opening hook (first 5 seconds), logical development, satisfying conclusion and CTA, clarity, pacing, SEO title/description/hashtags/tags, and platform-specific packaging. Do not invent facts, sources, stats, or trend claims. Give actionable findings and concrete revision instructions. Score 80+ only if publish-ready; any serious factual, rights, safety, or misleading-claim issue must be a blocker. Provide separately adapted metadata for YouTube, Instagram Reels, and TikTok; do not assume identical captions/tags work on all platforms.\n\nDRAFT:\n${draft}`;
  }

  async reviewDraft(draft) {
    const prompt = this.buildReviewPrompt(draft, 'YouTube');
    const gemini = await this.requestGemini(prompt);
    const groq = await this.requestGroq(prompt);
    for (const [name, result] of [['Gemini', gemini], ['Groq', groq]]) {
      if (!Number.isFinite(Number(result.score)) || Number(result.score) < 0 || Number(result.score) > 100) {
        throw new Error(`${name} reviewer returned an invalid score`);
      }
      if (!Array.isArray(result.blockers) || !Array.isArray(result.revision_instructions)) {
        throw new Error(`${name} reviewer response is missing blockers or revision instructions`);
      }
    }
    return { gemini, groq };
  }

  async reviseDraft(originalPrompt, draft, reviews) {
    const feedback = Object.entries(reviews).map(([reviewer, result]) =>
      `${reviewer}: score ${result.score}/100; blockers: ${JSON.stringify(result.blockers)}; findings: ${JSON.stringify(result.findings || [])}; required revisions: ${JSON.stringify(result.revision_instructions)}`
    ).join('\n');
    return this.requestOllama(`Revise the draft using all reviewer feedback. Keep the required JSON schema from the original task. Do not invent evidence. Return ONLY the complete revised JSON.\n\nORIGINAL REQUIREMENTS:\n${originalPrompt}\n\nCURRENT DRAFT:\n${draft}\n\nREVIEW FEEDBACK:\n${feedback}`);
  }

  async generateAndReview(prompt) {
    if (!this.enabled) throw new Error('Quality pipeline is disabled');
    // Fail closed: no remote generation fallback and no template fallback in this mode.
    let draft = await this.requestOllama(prompt);
    const attempts = [];
    for (let revision = 0; revision <= this.maxRevisions; revision++) {
      const reviews = await this.reviewDraft(draft);
      const scores = [Number(reviews.gemini.score), Number(reviews.groq.score)];
      const blockers = [...reviews.gemini.blockers, ...reviews.groq.blockers];
      const score = Math.min(...scores);
      const approved = scores.every(value => value >= this.minimumScore) &&
        reviews.gemini.approved === true && reviews.groq.approved === true &&
        blockers.length === 0;
      attempts.push({
        revision,
        score,
        gemini: reviews.gemini,
        groq: reviews.groq,
        approved
      });
      if (approved) {
        this.lastReport = {
          status: 'approved',
          score,
          minimumScore: this.minimumScore,
          revisions: revision,
          attempts,
          platformMetadata: reviews.gemini.platform_metadata || reviews.groq.platform_metadata || null
        };
        return draft;
      }
      if (revision === this.maxRevisions) break;
      draft = await this.reviseDraft(prompt, draft, reviews);
    }
    this.lastReport = {
      status: 'human_review_required',
      score: attempts[attempts.length - 1]?.score ?? 0,
      minimumScore: this.minimumScore,
      revisions: this.maxRevisions,
      attempts
    };
    throw new Error(`Quality gate did not reach ${this.minimumScore}/100 after ${this.maxRevisions} revisions; content held for human review`);
  }
}

module.exports = { LocalFirstQualityPipeline, extractJson, MINIMUM_SCORE, MAX_REVISIONS };
