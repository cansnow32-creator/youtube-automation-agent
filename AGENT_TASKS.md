# AgentTube — Task Queue

Refresh GitHub state and inspect code before selecting work. Update task statuses and evidence as work progresses.

Status values: todo, in_progress, blocked, done, needs_user.

## P0 — Validate and stabilize current production work

- [ ] in_progress — Complete PR #2 audit. Latest finding: production SQLite connections had no busy timeout although the new two-connection test manually set 5 seconds; configured a 5-second busy timeout during Database.initialize() (commit `b6e9c7f10bf6c8e42ebbe50f08683863f70d2965`). This is a bounded wait, not proof that all contention/recovery cases pass. Static review covered job-scoped production lock, production resume lease, scene-repair lease/heartbeat, and rollback-safe output replacement. A two-connection SQLite concurrency test is now committed but unexecuted; full runtime behavior remains unverified.
- [ ] blocked — Run CI for PR #2 current head `7940c5410c7caa3c3c82de47bcf628abec5adc80`: GitHub reports zero check-runs. Connector-authored commits did not trigger Actions. PR #1 base-branch workflow filter has been broadened to include stacked PRs, but PR #2 is still one commit behind/diverged from the current PR #1 base and no run has been triggered/observed.
- [x] done — Fix CI integrity issue: stop rewriting the committed lockfile before `npm ci`; generate the npm audit remediation candidate separately. Commit `96ac8f7c27be5009c981576650dd93c365cd160e` on PR #2 branch.
- [x] done — Broaden PR #1 base workflow's `pull_request` branch filter so stacked PR #2 is eligible for CI; commit `dcec5c12b7ae55ae1fbb69b6452398ddd97f6e81` on PR #1 branch.
- [x] done — Tighten a weak SQL assertion in the lease-renewal regression test to require the literal `?` placeholder; commit `5c346c23f75aa240c083371a8de42decdd80fed2` on PR #2 branch.
- [ ] todo — Fix any additional verified application failures with focused regression tests; do not merge.
- [x] done — Review PR #1 / PR #2 dependency: PR #2 intentionally targets PR #1's branch. Keep the stacked relationship; do not retarget without a full dependency review.
- [x] done — Add database-backed SQLite lock/concurrency regression coverage using two independent connections, contested acquisition, non-owner renewal/release, and expired-lease takeover. Commit `7940c5410c7caa3c3c82de47bcf628abec5adc80`; execution is still pending.

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
