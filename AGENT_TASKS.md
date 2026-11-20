# AgentTube — Task Queue

Refresh GitHub state and inspect code before selecting work. Update task statuses and evidence as work progresses.

Status values: todo, in_progress, blocked, done, needs_user.

## P0 — Validate and stabilize current production work

- [x] done — Serialize short scene metadata edits, timeline reorder, and uploaded asset replacement with the shared production operation lock. Competing operations fail closed with `SCENE_EDIT_IN_PROGRESS`; owner-scoped release is guaranteed in `finally`. Commits: `37bdd45d359ca27a8d7f779c06f0e8c15962ce4e`, `550e7be00ad7c9f2b2a742da46a0441d9ce01ed0`. Static review only; regression test not executed.
- [ ] in_progress — Protect paid visual regeneration, narration regeneration, and silence override with the shared production operation lease and heartbeat. Implemented `withProductionOperationLease()`, provider-return/DB-write assertions, and regression coverage. Commits: `aada5058e501de82bcb3d71191d0591bc9e4e10d`, `77f2aa8d5b66475245ccdc6c05ba1fd64e800a9b`. Static review only; tests/lint not executed. Remaining: inspect provider-created orphan files and route-level review refresh side effects.

- [ ] in_progress — Complete PR #2 audit. Latest finding: `rebuildNarration()` could publish a shared audio-cache file after its scene-repair lease had expired because the FFmpeg render could outlive the lease. Passed `assertLease` into `rebuildNarration()` and re-check immediately before atomic cache replacement; added an injectable FFmpeg runner and regression test that simulates lease loss and asserts no cache file is published. Commits: `a4cf5eeb76be2faaff5e236f72b853179c627df8`, `42b1538747a89ada2d4aaf12acecd29f301bfae1`, `2f6edb51130eaf1d2ecec399d6e1c209fae312c1`. Static review only; tests remain unexecuted.
- [ ] in_progress — Extend PR #2 lease audit to script artifacts. `processScript()` now receives the job lease assertion and checks it before the JSON and TTS file writes; regression coverage tests lease loss before the first write and between writes. Commits: `83f818e73f875b086af18920057059b7b7c97162`, `60204e2013dbabc5cd966ebf2bfc39a53a2fb711`. Static review only; tests remain unexecuted.
- [ ] in_progress — Extend PR #2 lease audit to thumbnails. `processThumbnail()` now checks the job lease around AI generation and before fallback directory/file writes; lease loss in the catch path is re-thrown instead of triggering fallback writes. Regression coverage simulates lease loss during AI generation. Commits: `3100c57e376c98ad3a31681389ff3063b324724a`, `be29f94137d95eac9f49a8005779272b623ea742`. Static review only; tests remain unexecuted.
- [ ] in_progress — Extend PR #2 lease audit through visual, narration, captions, and final video assembly. Lease assertions now flow through initial and resume stage helpers, guard visual DB checkpoints, TTS fallback, caption file/FFmpeg output replacement, audio mixing, and simulation artifacts. Regression coverage checks TTS fallback suppression and visual persistence suppression after lease loss. Commits: `2bf343dce295143df441fc3f61b9f50c976dfbc1`, `8c82636fcf070631e16e427c56c82653735a25d2`, `683c3c45298df8216851464a700269eb8543fe70`, `b9ef6fd2229d8f89cb1f032072cc3a9347c930eb`. Static review only; tests/lint remain unexecuted.
- [ ] in_progress — Extend PR #2 lease audit to visual scene generation. Both initial and resume paths pass the lease assertion into `generateVideoContent()`. The per-scene database write checks the lease immediately before persistence, and the catch path re-checks it so lease loss is not swallowed as an ordinary provider failure. Added regression coverage for lease loss after image-provider return. Commits: `dc7f5792120bd1ffdc22f5b3dc75305eff4b215f`, `48def2c871f779dc0722c995a9d41b7a450b2f69`. Static review only; tests remain unexecuted.
- [ ] in_progress — Extend PR #2 lease audit to scene-manifest initialization. `sceneRepair.initializeProduction()` and `initializeAudioSegments()` now receive the active production lease assertion from both initial and resume paths. Checks guard audio directory creation, each FFmpeg split, error handling, and scene-row persistence. Added a regression test for lease loss after FFmpeg and before `replaceProductionScenes()`. Commits: `50a9e2fcf1002dbf8dbfb4d03d451f3b7574dec1`, `547c91c4a04c979e84f1c28f7d45a67bccd5d9a1`, `17f6c5c179a2b83c46b660507a470cf357eac16a`, `322cd1f0aff871dd09720c46dfdf20a3c71038ac`. Regression uses injected FFmpeg runner and keeps lease loss persistent through the catch path. Static review only; tests remain unexecuted.
- [ ] in_progress — Extend PR #2 lease audit to scene rebuild itself. `rebuildUnlocked()` now passes the lease through `getEditableBundle()`/`ensureManifest()`, checks ownership during scene validation and long fingerprint hashing, and checks before deleting invalid shared outputs or reusing a narration cache. Added regression coverage proving a lost lease prevents missing-manifest DB writes. Commits: `711bc570229cfbd170d04328001bfa9451000d7e`, `6222a5cf7deb033f02634afc8b64e3e83a0a4971`. Static review only; tests remain unexecuted.
- [ ] blocked — Run CI for PR #2 current head 5e07fa496bdba00dac7c54b77e1dedd81b13f790: GitHub reports zero PR-triggered workflow runs. The workflow has workflow_dispatch, but the connected GitHub tools expose no dispatch action; use the GitHub Actions UI. PR #2 remains stacked on PR #1; preserve the dependency.
- [x] done — Fix CI integrity issue: stop rewriting the committed lockfile before `npm ci`; generate the npm audit remediation candidate separately. Commit `96ac8f7c27be5009c981576650dd93c365cd160e` on PR #2 branch.
- [x] done — Broaden PR #1 base workflow's `pull_request` branch filter so stacked PR #2 is eligible for CI; commit `dcec5c12b7ae55ae1fbb69b6452398ddd97f6e81` on PR #1 branch.
- [x] done — Tighten a weak SQL assertion in the lease-renewal regression test to require the literal `?` placeholder; commit `5c346c23f75aa240c083371a8de42decdd80fed2` on PR #2 branch.
- [x] done — Fence route-level `refreshContentReview()` with the shared production operation lease. Bundle read, quality evaluation, and review persistence now run under the same lock as scene edits/rebuilds, with lease assertion before save. Added `test/content-review-lock.test.js` and included it in `npm test`. Commits: `7bf63295ed60213272917bad5ade79566629cfdb`, `5e9cbdb92787b66979d6ce6dd421007a34bb4a15`, `f22e1e82f52a8c800aebddbd390bd429d05940be`, `9615d030839f4ad5322e9ab1fb3a02eee28f9937`. Static review only; no tests/lint executed. Next: provider orphan-output cleanup and actual CI.
- [x] done — Add per-attempt cleanup for scene visual/narration regeneration. UUID-scoped image/audio paths are tracked and removed if generation fails or the lease is lost before scene metadata commit; Gemini PCM sidecars are also cleaned. Added test/scene-regeneration-lease-cleanup.test.js to npm test. Commits: bad06f3af3c0d21db406224b25fc1f865b9a6281, 77de4fad8751796d5c7efaa6a6eb34fc5b585c49, 86a2480fcad9a70eaba23aabc93f75b5375dd317, b938b5582ecfb72c1db30649d643c65918cde184, dcc5433c223a46df953196105a0fb408896d1fe1, 5e07fa496bdba00dac7c54b77e1dedd81b13f790. Static review only; tests/lint unexecuted.
- [ ] in_progress — Add visual-generation lease-loss cleanup regression and continue checking provider partial-write/error paths. GitHub Actions remains blocked pending manual workflow dispatch; current PR #2 head 5e07fa496bdba00dac7c54b77e1dedd81b13f790 has zero PR-triggered workflow runs.
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
