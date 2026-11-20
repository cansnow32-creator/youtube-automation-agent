# AgentTube — Current State

Last reconciled: 2026-11-20 (live PR metadata refreshed after generation-wide lease changes)
Repository: cansnow32-creator/youtube-automation-agent
Default branch: master

> This is a handoff snapshot, not a live API. Always refresh GitHub PRs, branch heads, and check-runs before relying on it.

## Active pull requests

| PR | Branch | Base | Purpose | Live state at 2026-11-20 |
|---|---|---|---|---|
| [#1](https://github.com/cansnow32-creator/youtube-automation-agent/pull/1) | feat/local-first-quality-gate | master | Local-first Ollama script generation and 80-point review gate | Open draft, unmerged; head `dcec5c12b7ae55ae1fbb69b6452398ddd97f6e81`; 0 check-runs on current head (previous head had 2 successful runs) |
| [#2](https://github.com/cansnow32-creator/youtube-automation-agent/pull/2) | feat/video-concept-approval | feat/local-first-quality-gate | Concept approval, production recovery, scene repair | Open draft, unmerged; head `4b79565185934266dfed6109cd8a830a3fed8be2`; 0 workflow runs |
| [#3](https://github.com/cansnow32-creator/youtube-automation-agent/pull/3) | feat/agent-continuity | master | ChatGPT/GitHub continuity files and validation workflow | Open draft, unmerged; head advances with continuity-document commits, so refresh live metadata each session |

PR #2 intentionally stacks on PR #1 and still targets `feat/local-first-quality-gate`. Its live head is `4b79565185934266dfed6109cd8a830a3fed8be2`; it remains open/draft/unmerged, GitHub reports `mergeable: false`, and the current-head workflow query returns zero runs. The base branch ref itself resolves to PR #1 head `dcec5c12b7ae55ae1fbb69b6452398ddd97f6e81`; the PR metadata's reported base SHA remains `9438d3d6e9015684cc074f832188e05ecbf3ab51`, so do not attempt a blind rebase or retarget. PR #1 (head `dcec5c12...`) and PR #3 remain open/draft/unmerged and each has zero check-runs on its current head; PR #3's head advances whenever these continuity files are updated. Connector-authored commits have not triggered Actions. Preserve the stacked PR relationship; do not retarget or rewrite history without a full dependency review. Never merge any PR without explicit user approval.

## PR #2 current audit notes

- CI workflow commit `96ac8f7c27be5009c981576650dd93c365cd160e` now runs `npm ci` against the committed lockfile before generating a separate, reviewable dependency remediation candidate. It no longer silently rewrites the lockfile before tests.
- Static review inspected job-scoped production locking in `ProductionManagementAgent.processContent`, production-scoped resume leases, scene-repair lease heartbeats/loss guards, and temporary-output replacement with rollback.
- Tightened a weak SQL assertion in `test/production-operation-lock.test.js` so it requires the literal `?` placeholder in the lease-renewal predicate; commit `5c346c23f75aa240c083371a8de42decdd80fed2`.
- Added a real SQLite test using two independent connections to race for one lock, verify non-owner renewal/release, and test expired-lease takeover (commit `7940c5410c7caa3c3c82de47bcf628abec5adc80`). Production SQLite now configures a 5-second busy timeout (`b6e9c7f10bf6c8e42ebbe50f08683863f70d2965`). Static review then found `rebuildNarration()` could publish its shared audio cache after a scene-repair lease expired during FFmpeg rendering. The lease assertion is now passed into that helper and checked immediately before cache replacement; an injected-runner regression test simulates lease loss and asserts no cache file is published. Commits `a4cf5eeb76be2faaff5e236f72b853179c627df8`, `42b1538747a89ada2d4aaf12acecd29f301bfae1`, and `2f6edb51130eaf1d2ecec399d6e1c209fae312c1`. These tests and all application tests remain unexecuted; runtime recovery remains unverified.
- GitHub reports zero check-runs on the current PR #2 head `6222a5cf7deb033f02634afc8b64e3e83a0a4971`. The SQLite integration and scene-repair lease-loss regression tests and the broader PR #2 application tests/lint have not been run. PR #1's base workflow filter was broadened to include stacked PR targets, but connector-authored commits have not triggered Actions.
- Additional PR #2 audit finding: `processScript()` wrote the JSON script and TTS text without checking the generation-job lease. It now receives the `assertLease` callback and checks ownership immediately before each file write and after the second write. Added regression coverage for lease loss before the first write and between the JSON/TTS writes. Commits: `83f818e73f875b086af18920057059b7b7c97162` and `60204e2013dbabc5cd966ebf2bfc39a53a2fb711`. Static review only; tests have not been executed. The guard prevents subsequent writes once lease loss is observable; it does not provide an OS-level atomic fence against a lease expiring in the tiny interval after a check.
- Visual generation now receives the job lease assertion from both initial production and resume call paths. A lease check is performed immediately before per-scene DB persistence, and the catch path re-checks ownership so lease loss cannot be swallowed as a provider failure. Regression coverage simulates lease loss after the image provider returns and asserts no stale DB persistence. Commits: `dc7f5792120bd1ffdc22f5b3dc75305eff4b215f`, `48def2c871f779dc0722c995a9d41b7a450b2f69`. Static review only; tests remain unexecuted.
- PR #2 now threads the active lease through visual generation, TTS narration, captions, final assembly, and scene-manifest initialization in both initial and resume flows. Regression coverage was added for lost leases during visual provider return, TTS fallback, and scene audio splitting. Commits include `2bf343dce295143df441fc3f61b9f50c976dfbc1`, `8c82636fcf070631e16e427c56c82653735a25d2`, `683c3c45298df8216851464a700269eb8543fe70`, `b9ef6fd2229d8f89cb1f032072cc3a9347c930eb`, `50a9e2fcf1002dbf8dbfb4d03d451f3b7574dec1`, `547c91c4a04c979e84f1c28f7d45a67bccd5d9a1`, and `322cd1f0aff871dd09720c46dfdf20a3c71038ac`. Static review only; tests remain unexecuted.
- Scene rebuild now passes its lease assertion through missing-manifest creation and checks ownership during scene validation and fingerprint hashing. It checks before deleting invalid shared outputs and before reusing a cached narration mix. Added regression coverage proving a stale rebuild cannot create a missing manifest. Commits: `711bc570229cfbd170d04328001bfa9451000d7e`, `6222a5cf7deb033f02634afc8b64e3e83a0a4971`. Static review only; tests remain unexecuted.
- Continue auditing scene-edit endpoints (regeneration, upload replacement, reorder, narration and silence overrides) for cross-process serialization and lease coverage; obtain actual CI execution before considering the audit complete.

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


## Latest PR #2 lease audit — 2026-11-20

- Extended lease assertions through visual generation, narration, captions, and final video assembly. Stage-scoped assertions flow through initial production and resume paths; checks guard provider boundaries, scene DB checkpoints, caption writes/FFmpeg replacement, audio mixing, and simulation fallbacks.
- Added regression coverage for TTS fallback suppression and visual metadata persistence suppression after lease loss. Script and thumbnail lease-loss tests remain in `test/production-operation-lock.test.js`.
- Commits: `2bf343dce295143df441fc3f61b9f50c976dfbc1`, `8c82636fcf070631e16e427c56c82653735a25d2`, `683c3c45298df8216851464a700269eb8543fe70`, `b9ef6fd2229d8f89cb1f032072cc3a9347c930eb`.
- Static review only; tests and lint have not been executed. PR #2 current head reports zero workflow runs. Cooperative checks are not atomic fencing and cannot prevent a race after a check or file writes internal to provider implementations.
- Next: inspect remaining production side effects, especially `sceneRepair.initializeProduction()` and DB writes; then obtain CI execution. Do not merge.


## Latest PR #2 scene-edit serialization — 2026-11-20

- Live PR #2 head: `550e7be00ad7c9f2b2a742da46a0441d9ce01ed0`, open/draft/unmerged. GitHub reports zero workflow runs on this head.
- Static audit found updateScene(), reorder(), and replaceAsset() did not acquire the production-scoped operation lock shared with rebuild/resume operations. Added an owner-scoped lock wrapper around these short edit/upload operations; competing operations now fail with HTTP 409 / `SCENE_EDIT_IN_PROGRESS` rather than racing metadata or asset publication.
- Added regression coverage for lock contention and owner-only release in `test/production-operation-lock.test.js`.
- Commits: `37bdd45d359ca27a8d7f779c06f0e8c15962ce4e` (service), `550e7be00ad7c9f2b2a742da46a0441d9ce01ed0` (test).
- Static inspection only. Tests and lint were not executed. Narration regeneration, visual regeneration, and silence override remain to audit for long-running lease heartbeats and stale-worker side effects.


## Latest PR #2 scene-operation lease protection — 2026-11-20

- Live PR #2 head: `77f2aa8d5b66475245ccdc6c05ba1fd64e800a9b`, open/draft/unmerged; base remains `feat/local-first-quality-gate` at `9438d3d6e9015684cc074f832188e05ecbf3ab51`.
- Static audit found paid visual regeneration, narration regeneration, and silence overrides were not using the shared production operation lock. Added `withProductionOperationLease()` with owner-scoped acquisition/release, 60-second heartbeat renewal, and fail-closed lease assertions. Wrapped all three mutation paths and added assertions around provider returns and DB writes; lease loss is not converted into a normal failed-generation write.
- Added regression coverage for lock contention, heartbeat lease loss/release, and all three public mutation wrappers.
- Commits: `aada5058e501de82bcb3d71191d0591bc9e4e10d` (service) and `77f2aa8d5b66475245ccdc6c05ba1fd64e800a9b` (tests).
- GitHub Actions still reports zero workflow runs on current PR #2 head. Tests/lint were not executed. Provider internals can still create orphan temporary output before the post-provider lease check; cooperative checks are not atomic filesystem fencing.
- Next: inspect media-generation provider output cleanup and route-level review refresh side effects; then establish real CI. Preserve stacked PR relationship; do not merge.


## Follow-up finding — route review refresh boundary

- Further route inspection found scene mutation handlers call `refreshContentReview()` only after the SceneRepairService method has released its production operation lock. The quality-check read and `saveContentReview()` can therefore race with a subsequent scene edit and persist review data based on a stale bundle.
- Next: move mutation plus review refresh into one production-scoped lease boundary (including update/reorder/replace/regenerate/narration/silence/rebuild routes), or otherwise fence review persistence against scene revision changes. Add a focused stale-review regression test before considering scene-edit serialization complete.


## Latest PR #2 review-refresh race fix — 2026-11-20

- Live PR #2 head: `9615d030839f4ad5322e9ab1fb3a02eee28f9937`, open/draft/unmerged; base remains `feat/local-first-quality-gate` at `9438d3d6e9015684cc074f832188e05ecbf3ab51`.
- Fixed the route-level stale review race by making `refreshContentReview()` acquire the same production-scoped operation lease as scene edits/rebuilds. The lock is held while reading the bundle, running quality checks, and saving review state; lease ownership is rechecked before persistence.
- Added `test/content-review-lock.test.js` covering a competing refresh being rejected while the first quality check holds the shared lock; added it to `npm test`.
- Commits: `7bf63295ed60213272917bad5ade79566629cfdb` (implementation), `5e9cbdb92787b66979d6ce6dd421007a34bb4a15` (test), `f22e1e82f52a8c800aebddbd390bd429d05940be` (test script), `9615d030839f4ad5322e9ab1fb3a02eee28f9937` (test output cleanup).
- GitHub Actions reports zero workflow runs on the current head. Tests and lint were not executed; this remains static review plus source/test re-fetch. A competing refresh gets HTTP 409 and must be retried by its caller after the active operation releases the lock.
- Next: continue auditing media provider orphan-file cleanup and other non-scene operations that mutate the same production review state; then obtain real CI. Do not merge.


## Latest PR #2 media provider lease fencing — 2026-11-20

- Live PR #2 head: `9722a7b55560a4019c81c7ffcdde51af7bff696c`, open/draft/unmerged.
- MediaGenerationService.generateClip() now accepts the active scene lease assertion and checks it before task mutations, provider polling, download, cache reuse, and final task persistence. Provider downloads use unique per-attempt temporary paths and are only renamed to the unique scene-revision output after validation and a fresh lease check. If lease loss is detected after publication, that attempt-specific output is removed.
- Provider tasks reporting remote `succeeded` remain locally `running` until the MP4 has been downloaded, validated, and safely published; only then is the task marked succeeded.
- Scene regeneration passes its active lease into generateClip() and gives each regeneration attempt a unique final output filename.
- Added `test/media-generation-lease.test.js` for lease loss after provider download, output cleanup, and suppression of local success persistence; included it in `npm test`.
- Commits: `e74ca1fe07c1b07d1e75dc11cb454b139b6dd381`, `17a7256203722d237bd34d1dcac4de8da2d23f8d`, `0c41484dd6f0e6f36f8e9c33f4f8e48cb6db43d4`, `cc9d60ec4baf35c6ebe8d89f6596bb2dd8fc9c50`, `b528f75dc2082af417e17c28d791a088df1e5fdf`, `9722a7b55560a4019c81c7ffcdde51af7bff696c`.
- Static review only. Tests/lint not executed; GitHub Actions still needs an actual run. A remote provider task can still be created in the narrow interval between a successful lease check and the external API request; the post-response lease check prevents stale local persistence/publication but cannot atomically fence the external provider.
- Next: review visual-image and TTS regeneration for attempt-scoped output cleanup and stale writes; then trigger CI through an authorized GitHub UI/workflow dispatch. Do not merge.


## Latest PR #2 regeneration artifact cleanup — 2026-11-20

- Audited SceneRepairService.regenerateNarrationUnlocked() and regenerateUnlocked(). Narration output paths now include a per-attempt UUID; if the lease is lost or generation fails before scene metadata is committed, partial/generated audio and Gemini PCM sidecars are removed.
- Visual regeneration tracks generated image/simulation files and removes them on pre-commit failure or lease loss. Visual generator output names now include UUIDs to avoid same-millisecond collisions.
- Added test/scene-regeneration-lease-cleanup.test.js to simulate lease loss after TTS output creation and assert that no attempt audio remains. Added it to npm test.
- Commits on PR #2: bad06f3af3c0d21db406224b25fc1f865b9a6281, 77de4fad8751796d5c7efaa6a6eb34fc5b585c49, 86a2480fcad9a70eaba23aabc93f75b5375dd317, b938b5582ecfb72c1db30649d643c65918cde184, dcc5433c223a46df953196105a0fb408896d1fe1, 5e07fa496bdba00dac7c54b77e1dedd81b13f790.
- Static review and GitHub re-fetch only; test/lint have not run. Current head has zero PR-triggered workflow runs.
- CI workflow supports workflow_dispatch, but connected GitHub actions exposed in this session provide read/rerun operations only; no workflow-dispatch action is available. Connector file commits have not triggered push workflows. Manual dispatch through the GitHub Actions UI remains required.
- Remaining: add a corresponding lease-loss cleanup regression for visual image generation, inspect all partial provider-write paths, then obtain real CI execution. Do not merge.


## PR #2 partial visual provider output cleanup — 2026-11-20

- Static audit found generateVisualAssets() tracked image paths only after generateImage() returned. If a provider wrote partial bytes and then threw, the path was not tracked and the fallback simulation could leave an orphan image.
- Changed the method to register each UUID-scoped attempt path before invoking the provider and remove all attempt paths on failure before running the existing simulation fallback.
- Added test/visual-generation-artifact-cleanup.test.js, which simulates a provider writing partial bytes then throwing and verifies the partial output is removed; included in npm test.
- Commits: fb3cf772bfc2372cfdecc4df4669e1007d0a82ee (implementation), c3f81469c0b779eeefa0bf1ebdd8cd7c88e9575e (test), 660b967a0911be27e686bbfce6777ef74f663478 (test script).
- Re-fetched source/test/package and confirmed expected cleanup and test inclusion. Static verification only; tests/lint not run. PR #2 current head has zero workflow runs.
- Next: audit image provider internals for any secondary temp paths outside the requested imagePath, then continue the remaining production side-effect audit and obtain real CI. Do not merge.


## Latest PR #2 provider artifact cleanup — 2026-11-20

- Live GitHub state before the continuity-note commits: PR #1 open/draft/unmerged, head `dcec5c12b7ae55ae1fbb69b6452398ddd97f6e81`, mergeable true, 0 check-runs. PR #2 open/draft/unmerged, head `d606a1ab5742c8128c3b7653342a0431df27425d`, base branch `feat/local-first-quality-gate`, mergeable false, 0 workflow runs. PR #3 remains open/draft/unmerged; its head advances with these documentation commits.
- Audited OpenAI/Gemini image-provider filesystem behavior. Provider responses are consumed in memory or streamed to a local output; no separate vendor-created local sidecar was found. However, direct writes could expose partial output across provider fallback. Each provider now writes to a UUID-scoped sibling attempt file; Sharp validates it, same-directory rename publishes only complete output, and failed attempts are removed. OpenAI image URL downloads now use stream `pipeline()` and remove partial output on stream failure.
- Added `test/image-provider-atomic-output.test.js` and wired it into `npm test`. Commits: `4eb6577e7a33a996049be43bbf53852a6e1b6f43`, `f1ce5e961ebb86659d83bcfd09dab31d962f427c`, `9f932dd4cf950d9c62ae68c30f976346cd114e32`.
- Found Gemini TTS could leave its `.pcm` sidecar when FFmpeg conversion failed. The sidecar is now removed in `finally`; conversion uses the constructor-injected FFmpeg runner for deterministic testing. Added success/failure tests in `test/gemini-tts-temp-cleanup.test.js`. Commits: `bb61213e5d2dd7427b5cf1f5c295fbfdf51e3863`, `d198c34ecf4be8805c7552f4dfa0e5ede4301484`, `d606a1ab5742c8128c3b7653342a0431df27425d`.
- Re-fetched source, tests, and package script from GitHub and confirmed both tests are included in `npm test`. Static verification only: tests and lint have not been executed. GitHub reports zero workflow runs for current PR #2 head.
- Branch comparison for PR #2: 454 commits ahead / 1 behind PR #1's current branch tip, with merge base `9438d3d6e9015684cc074f832188e05ecbf3ab51`. The one-behind commit is PR #1's CI workflow branch-filter/permission change; PR #2's workflow file already contains the equivalent change plus additional lockfile-integrity steps. No merge/rebase was applied; inspect the stacked history before synchronizing.
- PR #3 comparison against master was ahead by 85 / behind by 0 when checked; its latest head advances with each continuity-doc commit. Refresh before any action.
- Next: continue production recovery/file-side-effect audit, then run CI via an authorized workflow dispatch/UI. No workflow-dispatch action is available in the connected GitHub tools. Preserve the stacked PR dependency; do not merge.


## Latest PR #2 generation-wide lease and recovery fencing — 2026-11-20

- Live GitHub state: PR #1 remains open/draft/unmerged, head `dcec5c12b7ae55ae1fbb69b6452398ddd97f6e81`, mergeable true, 0 check-runs. PR #2 remains open/draft/unmerged, head `4b79565185934266dfed6109cd8a830a3fed8be2`, base `feat/local-first-quality-gate`, mergeable false, 0 workflow runs. PR #3 remains open/draft/unmerged; its head advances with continuity updates. No merge/rebase was applied.
- Added `utils/generation-job-lease.js`: owner-scoped lock ID `generation:<jobId>`, 2-hour lease, 30-second heartbeat, fail-closed lease loss/unverified errors, and owner-only release.
- Wired that lease through the full `runGenerationJob()` lifetime, preflight/resume checkpoint resets, human-approved script continuation, stage producers (strategy/script/thumbnail/SEO/production/quality review), and production-manager/resume entry points.
- Updated `GenerationRecoveryService` to assert the outer lease before/after prerequisite reads, artifact validation, stage updates, checkpoint writes, retry waits, reuse updates and checkpoint resets. A stale worker cannot mark the stage failed/completed after it observes lease loss.
- Tests added/updated: `test/generation-job-lease.test.js` (competing worker and end-to-end generation runner lock coverage) and `test/generation-recovery-prerequisites.test.js` (suppress stale completed/failed checkpoint writes). Added generation lease test to `npm test`.
- Commits on PR #2: `47f8a16e8bbcd40b975f98cc307bdd565082c7af`, `c00d8f8fecb074dc2d310fa7e9aa56eef978f5f2`, `d2c740c468b5efe30318edc13f7b649bb65022f6`, `63bd2fffd6ed3f426ef07d1280b2262f01490c71`, `5a2eee3e224365d9283529c4518bc8c5df8a0df5`, `7cf40742916eee804dc68cf11633d3342c76212f`, `09930cdd98ced25dcbd4db7f19df6fec5f2877ac`, `4b79565185934266dfed6109cd8a830a3fed8be2`.
- Re-fetched six changed source/test files from GitHub and parsed them for JavaScript syntax; all parsed. This is not runtime test execution. `npm test`, lint, database integration and real generation/resume have not run; Desktop Commander monthly execution quota is exhausted and GitHub shows zero workflow runs for this head.
- Limitation: the lease assertions are cooperative and cannot atomically fence a database/file mutation in the tiny interval between a successful assertion and the actual side effect. Lease loss during a long producer is checked immediately after return and stale checkpoint/job failure writes are suppressed.
- Next: continue production recovery and final artifact side-effect audit, then get a real CI run via the GitHub Actions UI or authorized workflow dispatch. Connected GitHub tools do not expose a workflow-dispatch action. Preserve the PR #1/#2 stack; do not merge.
