# AgentTube — Task Queue

Refresh GitHub state and inspect code before selecting work. Update task statuses and evidence as work progresses.

Status values: todo, in_progress, blocked, done, needs_user.

## P0 — Validate and stabilize current production work

- [ ] in_progress — Complete PR #2 audit. Live diff and check-runs inspected; static review covered job-scoped production lock, production resume lease, scene-repair lease/heartbeat, and rollback-safe output replacement. Database-backed multi-process concurrency and full runtime behavior remain unverified.
- [ ] todo — Run CI for PR #2 head `96ac8f7c27be5009c981576650dd93c365cd160e`: `npm ci`, lint and tests in GitHub Actions; record exact run and outputs. Current head has zero check-runs.
- [x] done — Fix CI integrity issue: stop rewriting the committed lockfile before `npm ci`; generate the npm audit remediation candidate separately. Commit `96ac8f7c27be5009c981576650dd93c365cd160e` on PR #2 branch.
- [ ] todo — Fix any additional verified application failures with focused regression tests; do not merge.
- [ ] todo — Review PR #1 / PR #2 dependency. PR #2 currently targets PR #1's branch. Preserve stacked PRs or retarget only after reviewing dependencies.

## P1 — Establish continuity and cloud execution

- [x] done — Continuity handoff files, Dot guide, and deterministic read-only validation workflow added on feat/agent-continuity; draft PR #3 opened.
- [ ] todo — Run the continuity workflow from GitHub Actions UI or a user-authorized workflow dispatch; connector-authored commits did not trigger a run.
- [ ] todo — Dot availability and GitHub connection: user must confirm chatgpt.com/dots availability and complete GitHub app authorization. Never request a PAT.
- [ ] todo — Cloud execution path: evaluate Dot cloud computer or Codex cloud environment. GitHub Actions is deterministic CI, not an autonomous coding agent.
- [ ] todo — New-chat resume smoke test: user says "Devam et"; assistant/dot reads these files and live GitHub state, then resumes the top task.

## P2 — Dashboard information architecture

- [ ] todo — Inspect dashboard UI; preserve existing views and API behavior while grouping navigation.
- [ ] todo — Implement navigation in a separate PR: Overview, Video Production, Video & Animation Studio, Scene Editing, Review & Publishing, Analytics, System & Settings. Do not enable auto-publishing.

## P3 — Video DNA / Animation Studio (separate scope)

- [ ] todo — Write technical design for reference-video ingest, frame/time sampling, motion/style analysis, scene timeline, overlays, preview and export.
- [ ] todo — Define honest capability tiers: style analysis and 2D camera motion vs true pose extraction, 3D reconstruction and editable character animation.
- [ ] todo — Implement only after design review, with rights-aware input handling and tests; no surprise paid providers.

## Parked / requires user approval

- [ ] needs_user — Paid model/API usage: no Gemini/Groq or other paid API fallback without explicit approval.
- [ ] needs_user — Merge any PR: explicit user approval required.
- [ ] needs_user — Enable automatic YouTube publishing: remains disabled unless explicitly authorized.
