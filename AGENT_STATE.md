# AgentTube — Current State

Last reconciled: 2026-11-20 (PR #2 head verified at `b6e9c7f10bf6c8e42ebbe50f08683863f70d2965`; PR #3 head verified at `4df4389927782b3a643b3fa5d6f92d3e201bf439` before continuity updates)
Repository: cansnow32-creator/youtube-automation-agent
Default branch: master

> This is a handoff snapshot, not a live API. Always refresh GitHub PRs, branch heads, and check-runs before relying on it.

## Active pull requests

| PR | Branch | Base | Purpose | Live state at 2026-11-20 |
|---|---|---|---|---|
| [#1](https://github.com/cansnow32-creator/youtube-automation-agent/pull/1) | feat/local-first-quality-gate | master | Local-first Ollama script generation and 80-point review gate | Open draft, unmerged; head `dcec5c12b7ae55ae1fbb69b6452398ddd97f6e81`; 0 check-runs on current head (previous head had 2 successful runs) |
| [#2](https://github.com/cansnow32-creator/youtube-automation-agent/pull/2) | feat/video-concept-approval | feat/local-first-quality-gate | Concept approval, production recovery, scene repair | Open draft, unmerged; head `b6e9c7f10bf6c8e42ebbe50f08683863f70d2965`; 0 check-runs |
| [#3](https://github.com/cansnow32-creator/youtube-automation-agent/pull/3) | feat/agent-continuity | master | ChatGPT/GitHub continuity files and validation workflow | Open draft, unmerged; head `8034dd2bfcb0559ac63a6e8657fab36791033249`; 0 check-runs |

PR #2 intentionally stacks on PR #1. Its current head `7940c5410c7caa3c3c82de47bcf628abec5adc80` is based on the prior PR #1 head `9438d3d6e9015684cc074f832188e05ecbf3ab51`; PR #1 has since advanced by one commit to `dcec5c12b7ae55ae1fbb69b6452398ddd97f6e81`. GitHub compare reports the PR #2 branch as diverged (402 ahead, 1 behind); do not retarget or rewrite the stacked branch without reviewing the CI workflow overlap. All current PR heads report zero check-runs. Connector-authored commits did not trigger Actions. PR #3 is independent. Never merge any PR without explicit user approval.

## PR #2 current audit notes

- CI workflow commit `96ac8f7c27be5009c981576650dd93c365cd160e` now runs `npm ci` against the committed lockfile before generating a separate, reviewable dependency remediation candidate. It no longer silently rewrites the lockfile before tests.
- Static review inspected job-scoped production locking in `ProductionManagementAgent.processContent`, production-scoped resume leases, scene-repair lease heartbeats/loss guards, and temporary-output replacement with rollback.
- Tightened a weak SQL assertion in `test/production-operation-lock.test.js` so it requires the literal `?` placeholder in the lease-renewal predicate; commit `5c346c23f75aa240c083371a8de42decdd80fed2`.
- Added a real SQLite test using two independent connections to race for one lock, verify non-owner renewal/release, and test expired-lease takeover (commit `7940c5410c7caa3c3c82de47bcf628abec5adc80`). The test has been committed but has not been executed; real multi-process behavior and end-to-end production recovery remain unverified. A further static review found production SQLite connections did not configure a busy timeout, while the integration test manually did. Added this.db.configure('busyTimeout', 5000) during Database.initialize() in commit `b6e9c7f10bf6c8e42ebbe50f08683863f70d2965`; this prevents immediate SQLITE_BUSY on short writer contention but remains untested at runtime.
- GitHub reports zero check-runs on the current PR #2 head. The new SQLite integration test and the broader PR #2 application tests/lint have not been run. PR #1's base workflow filter was broadened to include stacked PR targets, but the connector-authored commit did not trigger Actions.
- Continue deeper review; add database-backed concurrency regression coverage where appropriate.

## PR #2 known work and validation limits

- Local Ollama-first concept proposal/revision; no silent Gemini/Groq fallback.
- Approved-concept gate at production entry points.
- Reference-video upload/analysis foundations and native CineCode image-to-motion adapter.
- Production stage workflow, resume/recovery and artifact reuse.
- Cross-process scene repair leases and lease-loss guards.
- Job-scoped production creation locks, production-scoped resume locks, rollback-safe output replacement, and regression tests.
- Earlier CI passed at `a49a9071988375a759809021ef44112426f6828f`; that is not the current head.
- Dependency install previously reported 36 advisories (2 critical, 19 high, 13 moderate, 2 low); remediation needs a separate review.

## PR #3 — Continuity foundation

- Branch: `feat/agent-continuity`, based on `master`.
- Adds `AGENT_CONTINUITY.md`, `AGENT_STATE.md`, `AGENT_TASKS.md`, `AGENT_RULES.md`, `AGENT_LOG.md`, `DOT_SETUP.md`, and `.github/workflows/continuity-check.yml`.
- Workflow is deterministic/read-only; it validates continuity files and guardrails. It is not an autonomous coding model.
- Current PR #3 head has zero check-runs; workflow execution remains unverified.
- New-chat handoff is manual: user opens a new chat and says **"AgentTube – devam et"**. It does not automatically open a new ChatGPT chat or continue after the user closes the current one.

## Product and operating preferences

- Prefer local Ollama qwen3.5:4b for concept and quality workflows when the user's PC is available.
- Do not silently fallback to paid Gemini/Groq/OpenAI API. Any paid provider usage requires explicit user approval.
- Keep automatic YouTube publishing disabled.
- Never merge PRs without explicit user approval.
- Keep work cost-conscious; avoid paid API usage unless explicitly approved.
- User wants a clear dashboard with logical navigation and a separate Video / Animation Studio.
- Preserve existing API contracts and workflows when reorganizing the dashboard.
- A future reference-video workflow should analyze movement/style and support requested transformations; do not promise full motion/pose/3D reconstruction until implemented and tested.

## Environment constraints

- User's Windows PC may be offline. Cloud GitHub work must not depend on local Node, Ollama, FFmpeg, or local files.
- Local Ollama, FFmpeg on the user's PC, YouTube OAuth, and full end-to-end production have not been verified from cloud.
- No secrets belong in Git-tracked files.
