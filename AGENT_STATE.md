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

Latest known PR #2 head at continuity setup: e47c569dc6e8bd4b4617d094a7b93dfcc25c9bcb. This SHA may become stale; always fetch the live PR head.

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

## Current continuity branch

- Branch: feat/agent-continuity
- Purpose: durable handoff notes and deterministic GitHub Actions continuity checks.
- This branch is independent of PR #1 and PR #2; do not merge it automatically.
