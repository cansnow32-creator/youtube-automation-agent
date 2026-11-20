# AgentTube — Current State

Last reconciled: 2026-11-20 (live PR metadata and check-runs refreshed immediately before this update)
Repository: cansnow32-creator/youtube-automation-agent
Default branch: master

> This is a handoff snapshot, not a live API. Always refresh GitHub PRs, branch heads, and check-runs before relying on it.

## Active pull requests

| PR | Branch | Base | Purpose | Live state at 2026-11-20 |
|---|---|---|---|---|
| [#1](https://github.com/cansnow32-creator/youtube-automation-agent/pull/1) | feat/local-first-quality-gate | master | Local-first Ollama script generation and 80-point review gate | Open draft, unmerged; head `dcec5c12b7ae55ae1fbb69b6452398ddd97f6e81`; 0 check-runs on current head (previous head had 2 successful runs) |
| [#2](https://github.com/cansnow32-creator/youtube-automation-agent/pull/2) | feat/video-concept-approval | feat/local-first-quality-gate | Concept approval, production recovery, scene repair | Open draft, unmerged; head `48def2c871f779dc0722c995a9d41b7a450b2f69`; 0 check-runs |
| [#3](https://github.com/cansnow32-creator/youtube-automation-agent/pull/3) | feat/agent-continuity | master | ChatGPT/GitHub continuity files and validation workflow | Open draft, unmerged; head `ad6ad108c88b4716ef517f188ec0d1f78c5debda`; 0 check-runs |

PR #2 intentionally stacks on PR #1. Its live head is `48def2c871f779dc0722c995a9d41b7a450b2f69`; compare against the live base branch before attempting synchronization. PR #2 remains open/draft/unmerged and GitHub reports zero check-runs on its current head. PR #1 and PR #3 also remain open/draft/unmerged with zero check-runs on their current heads. Connector-authored commits have not triggered Actions. Preserve the stacked PR relationship; do not retarget or rewrite history without a full dependency review. Never merge any PR without explicit user approval.

## PR #2 current audit notes

- CI workflow commit `96ac8f7c27be5009c981576650dd93c365cd160e` now runs `npm ci` against the committed lockfile before generating a separate, reviewable dependency remediation candidate. It no longer silently rewrites the lockfile before tests.
- Static review inspected job-scoped production locking in `ProductionManagementAgent.processContent`, production-scoped resume leases, scene-repair lease heartbeats/loss guards, and temporary-output replacement with rollback.
- Tightened a weak SQL assertion in `test/production-operation-lock.test.js` so it requires the literal `?` placeholder in the lease-renewal predicate; commit `5c346c23f75aa240c083371a8de42decdd80fed2`.
- Added a real SQLite test using two independent connections to race for one lock, verify non-owner renewal/release, and test expired-lease takeover (commit `7940c5410c7caa3c3c82de47bcf628abec5adc80`). Production SQLite now configures a 5-second busy timeout (`b6e9c7f10bf6c8e42ebbe50f08683863f70d2965`). Static review then found `rebuildNarration()` could publish its shared audio cache after a scene-repair lease expired during FFmpeg rendering. The lease assertion is now passed into that helper and checked immediately before cache replacement; an injected-runner regression test simulates lease loss and asserts no cache file is published. Commits `a4cf5eeb76be2faaff5e236f72b853179c627df8`, `42b1538747a89ada2d4aaf12acecd29f301bfae1`, and `2f6edb51130eaf1d2ecec399d6e1c209fae312c1`. These tests and all application tests remain unexecuted; runtime recovery remains unverified.
- GitHub reports zero check-runs on the current PR #2 head `48def2c871f779dc0722c995a9d41b7a450b2f69`. The SQLite integration and scene-repair lease-loss regression tests and the broader PR #2 application tests/lint have not been run. PR #1's base workflow filter was broadened to include stacked PR targets, but connector-authored commits have not triggered Actions.
- Additional PR #2 audit finding: `processScript()` wrote the JSON script and TTS text without checking the generation-job lease. It now receives the `assertLease` callback and checks ownership immediately before each file write and after the second write. Added regression coverage for lease loss before the first write and between the JSON/TTS writes. Commits: `83f818e73f875b086af18920057059b7b7c97162` and `60204e2013dbabc5cd966ebf2bfc39a53a2fb711`. Static review only; tests have not been executed. The guard prevents subsequent writes once lease loss is observable; it does not provide an OS-level atomic fence against a lease expiring in the tiny interval after a check.
- Visual generation now receives the job lease assertion from both initial production and resume call paths. A lease check is performed immediately before per-scene DB persistence, and the catch path re-checks ownership so lease loss cannot be swallowed as a provider failure. Regression coverage simulates lease loss after the image provider returns and asserts no stale DB persistence. Commits: `dc7f5792120bd1ffdc22f5b3dc75305eff4b215f`, `48def2c871f779dc0722c995a9d41b7a450b2f69`. Static review only; tests remain unexecuted.
- Continue deeper review of remaining production side effects (narration, captions, final assembly and scene repair initialization), paying attention to lease loss after long-running provider/FFmpeg work.

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
