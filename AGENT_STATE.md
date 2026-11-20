# AgentTube — Current State

Last manually reconciled: 2026-11-20
Repository: cansnow32-creator/youtube-automation-agent
Default branch: master

> Refresh GitHub PRs, branches, and check-runs before relying on these notes. This is a handoff snapshot, not a live API.

## Active pull requests

| PR | Branch | Base | Purpose | State at snapshot |
|---|---|---|---|---|
| #1 | feat/local-first-quality-gate | Verify live | Local-first quality gate | Open draft; do not merge |
| #2 | feat/video-concept-approval | feat/local-first-quality-gate | Concept approval, production recovery, scene repair | Open draft; do not merge |

Live PR #2 head checked 2026-11-20: `96ac8f7c27be5009c981576650dd93c365cd160e`; base remains `feat/local-first-quality-gate`. PR #2 is open, draft, and unmerged. Current head has zero check-runs. Always refresh live state.


## PR #3 — Agent Continuity

- Branch: `feat/agent-continuity`.
- Latest verified head at 2026-11-20: `1904d1fccc3d808628fedf80910b5db7daa12c04` (refresh live before relying on it).
- PR #3 is open, draft, and unmerged.
- It adds the continuity handoff files, Dot setup guidance, and deterministic read-only workflow validation.
- No check runs are associated with this head yet; the workflow has not been verified. Do not claim it passed.
- This system supports manual new-chat handoff via the phrase **"AgentTube – devam et"**. It does not automatically open a new ChatGPT chat or run an autonomous coding model.

## PR #2 current audit notes (2026-11-20)

- CI workflow commit `96ac8f7c27be5009c981576650dd93c365cd160e` now runs `npm ci` against the committed lockfile before generating a separate, reviewable dependency remediation candidate. It no longer silently rewrites the lockfile before tests.
- Static review inspected job-scoped production locking in `ProductionManagementAgent.processContent`, production-scoped resume leases, scene-repair lease heartbeats, and temporary-output replacement with rollback.
- Existing lock tests mock database calls; real SQLite multi-process contention and end-to-end production recovery have not been verified.
- PR #2 current head has zero check-runs. No PR #2 application tests or lint have been run in this session.

## PR #2 known work and validation limits

- Local Ollama-first concept proposal/revision; no silent Gemini/Groq fallback.
- Approved-concept gate at production entry points.
- Reference-video upload/analysis foundations and native CineCode image-to-motion adapter.
- Production stage workflow, resume/recovery and artifact reuse.
- Cross-process scene repair leases and lease-loss guards.
- Newer unverified changes add job-scoped production creation leases, production-scoped resume leases, rollback-safe output replacement, and regression tests.
- Earlier CI passed at a49a9071988375a759809021ef44112426f6828f; that is not the current head.
- At the latest known snapshot, current head had no associated check runs. Do not claim current changes pass.
- Dependency install previously reported 36 advisories (2 critical, 19 high, 13 moderate, 2 low); schedule a separate dependency security review.

## Product and operating preferences

- Prefer local Ollama qwen3.5:4b for concept and quality workflows when the user's PC is available.
- Do not silently fallback to paid Gemini/Groq. Any paid provider fallback requires explicit user approval.
- Keep automatic YouTube publishing disabled.
- Never merge PRs without explicit user approval.
- Keep work cost-conscious; avoid paid API usage unless explicitly approved.
- User wants a clear dashboard with logical navigation and a separate Video / Animation Studio.
- A future reference-video workflow should analyze movement/style and support requested transformations; do not promise full motion/pose/3D reconstruction until implemented and tested.
- Preserve existing API contracts and workflows when reorganizing the dashboard.

## Environment constraints

- User's Windows PC may be offline. Cloud work must not depend on local Node, Ollama, FFmpeg, or local files.
- Local Ollama, FFmpeg on the user's PC, YouTube OAuth and full end-to-end production have not been verified from cloud.
- No secrets belong in Git-tracked files.

## PR #3 — Continuity foundation

- PR: https://github.com/cansnow32-creator/youtube-automation-agent/pull/3
- Branch: feat/agent-continuity → master
- Head at snapshot: 990e079a78ee3a9a044637b9771a8f5df3f3b73c
- Open, draft, unmerged. No associated check runs observed.
- GitHub Actions workflow file is committed, but no run was triggered by the connector-authored commits. Do not report it as passed.

## Current continuity branch

- Branch: feat/agent-continuity
- Purpose: durable handoff notes and deterministic GitHub Actions continuity checks.
- This branch is independent of PR #1 and PR #2; do not merge it automatically.
