# AgentTube — Current State

Last reconciled: 2026-11-20 (scene edit lease hardening)
Repository: cansnow32-creator/youtube-automation-agent
Default branch: master

> This is a handoff snapshot, not a live API. Always refresh GitHub PRs, branch heads, and check-runs before relying on it.

## Active pull requests

| PR | Branch | Base | Purpose | Live state at 2026-11-20 |
|---|---|---|---|---|
| [#1](https://github.com/cansnow32-creator/youtube-automation-agent/pull/1) | feat/local-first-quality-gate | master | Local-first Ollama script generation and 80-point review gate | Open draft, unmerged; head `dcec5c12b7ae55ae1fbb69b6452398ddd97f6e81`; 0 check-runs on current head (previous head had 2 successful runs) |
| [#2](https://github.com/cansnow32-creator/youtube-automation-agent/pull/2) | feat/video-concept-approval | feat/local-first-quality-gate | Concept approval, production recovery, scene repair | Open draft, unmerged; head `b8abf3a09a6ef20ffd3722dd7a7e6116eec74d1e`; mergeable false; 0 workflow runs |
| [#3](https://github.com/cansnow32-creator/youtube-automation-agent/pull/3) | feat/agent-continuity | master | ChatGPT/GitHub continuity files and validation workflow | Open draft, unmerged; branch head changes with continuity-doc commits; latest refreshed head is recorded in GitHub PR metadata; mergeable false; 0 workflow runs |

PR #2 intentionally stacks on PR #1 and still targets `feat/local-first-quality-gate`. Its live head is `b8abf3a09a6ef20ffd3722dd7a7e6116eec74d1e`; it remains open/draft/unmerged, GitHub reports `mergeable: false`, and the current-head workflow query returns zero runs. The base branch ref itself resolves to PR #1 head `dcec5c12b7ae55ae1fbb69b6452398ddd97f6e81`; the PR metadata's reported base SHA remains `9438d3d6e9015684cc074f832188e05ecbf3ab51`, so do not attempt a blind rebase or retarget. PR #1 (head `dcec5c12...`) and PR #3 remain open/draft/unmerged and each has zero check-runs on its current head; PR #3 currently reports `mergeable: false`, and its head advances whenever these continuity files are updated. Connector-authored commits have not triggered Actions. Preserve the stacked PR relationship; do not retarget or rewrite history without a full dependency review. Never merge any PR without explicit user approval.

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
- Current PR #3 head has zero check-runs and GitHub currently reports `mergeable: false`; workflow execution remains unverified.
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


## Latest PR #2 early-stage provider side-effect fencing — 2026-11-20

- Live GitHub state: PR #1 is open/draft/unmerged at `dcec5c12b7ae55ae1fbb69b6452398ddd97f6e81`, mergeable true. PR #2 is open/draft/unmerged at `bce6c2c718f81754ac99013a997fc62c620d69d0`, base `feat/local-first-quality-gate`, mergeable false, 0 workflow runs. PR #3 remains open/draft/unmerged and its branch head advances with continuity updates. No PR merged or rebased.
- The generation-job lease assertion is now passed into the strategy, script, thumbnail and SEO agents. They check the lease at producer boundaries and immediately before/after their internal DB persistence (`saveContentStrategy`, `saveScript`, rejected `saveScriptQualityReview`, `saveThumbnail`, `saveSEOData`). The rejected-script-review catch path rethrows lease errors instead of swallowing them as persistence warnings.
- Thumbnail assets use unique per-attempt names. Base, overlay and optimized outputs are tracked; partial output is removed inside the individual image helpers if a write fails; uncommitted outputs are deleted on lease loss. On success only the optimized thumbnail is retained after its DB row is saved.
- Packaging A/B thumbnail generation accepts the lease assertion and cleans all generated variants on failure. `preparePackagingExperiment()` passes the lease and removes generated variant files if lease loss occurs before the quality-review stage continues.
- Added `test/generation-stage-artifact-cleanup.test.js` for strategy/script/SEO persistence suppression, rejected review persistence suppression, thumbnail cleanup and A/B variant cleanup; included in `npm test`.
- Commits on PR #2: `7ca655b812044e63d8de8635602f1647fa513d70`, `dee9e52cc748549c5db74be6ad099be741b92ffa`, `28e1e15ac2e23bb6a644393224675c51842e8cb0`, `57d1495f014f982f4bbf480ec954f8d13215cb8f`, `84da7b0df0a10ec5d689c27ec40507d6c1b38341`, `41f612d1caa7ccdb8bb22a30b6b8551240dae944`, `04292d442af9f06452686911184857464c00ab09`, `ed52b8bee7b2bfbabf0a04e85776b0288c1c3898`, `9322fc7ed228420ab6cb3c2633410a18f16a2663`, `c74e69c2c270548756003b4fcc780eedfdc8c806`, `bce6c2c718f81754ac99013a997fc62c620d69d0`.
- Re-fetched six implementation/test files from GitHub and parsed JavaScript sources; JSON package manifest parsed and the new test is in `npm test`. No tests or lint were executed. Desktop Commander execution quota is exhausted; GitHub Actions reports 0 runs for the current PR #2 head.
- Cooperative assertions still do not create an atomic transaction spanning the lease row and each subsequent DB/file mutation. Existing lease-loss guards reduce stale writes, but the gap between assertion and mutation remains a known limitation.
- Next: continue auditing production recovery and final video/asset publication for stale-worker side effects; then obtain CI via GitHub Actions UI or authorized workflow dispatch. No dispatch action is available through the current connector. Preserve stacked PRs; do not merge.


## Next PR #2 media-output audit finding — 2026-11-20

- Static inspection of `ProductionManagementAgent` found remaining production-ID-stable output paths in `generateAudioNarration()` (`_narration.mp3` and simulation sidecar), `generateCaptions()` (`_captions.srt`), `assembleVideo()` (`_final.mp4`, `_music_mixed.mp4`, `_captioned.mp4`, `.rendering.mp4`, render manifest/temp), and `simulateVideoAssembly()` (`.assembly.json`).
- These functions do have cooperative lease assertions, but a long-running provider/FFmpeg failure or lease loss can leave intermediate files at shared production paths. This audit finding is not yet changed; next step is attempt-scoped paths and cleanup while preserving reusable, already-persisted artifacts.
- Current PR #2 head remains `bce6c2c718f81754ac99013a997fc62c620d69d0` at the time of this note, open/draft/unmerged, mergeable false, and with zero workflow runs. Re-fetch live PR metadata before any next change.


## Latest PR #2 attempt-scoped production media outputs — 2026-11-20

- Live PR state at reconciliation: PR #1 open/draft/unmerged at `dcec5c12b7ae55ae1fbb69b6452398ddd97f6e81`, mergeable true; PR #2 open/draft/unmerged at `cd108cc1e7935c57610c0c6d122c52ac20584833`, base `feat/local-first-quality-gate`, mergeable false; PR #3 open/draft/unmerged at `bdb4c0339000fcdfef7af4d368f4d4bbea4fdf4f`, mergeable true. All three current heads return zero PR-triggered workflow runs. PR #2 remains stacked on PR #1; no rebase or merge was made.
- Added `timeline.artifactAttemptId` for new productions and regenerated on each `resumeProductionUnlocked()` attempt. Narration MP3, simulation sidecar, captions SRT, clean/final MP4, music-mixed MP4, captioned MP4, render temp/manifest and assembly placeholder outputs are now attempt-scoped.
- Existing validated narration and captions still reuse by source hash when the source has not changed; retries do not sacrifice this cache behavior.
- Added production-side cleanup helpers to remove attempt-local audio/video/caption sidecars on lease loss and stage-persistence failure while preserving already referenced assets. Subtitle cache outputs created by the current attempt are tracked as uncommitted until the production record is persisted.
- Local slideshow still-frame directories now derive from the unique output basename instead of a shared `data/videos/slides` directory. Hybrid renderer and audio mixer sidecars are included in the cleanup inventory.
- Tests: added `test/production-attempt-artifact-cleanup.test.js` for narration, caption, final-video and simulation cleanup after lease loss; expanded `test/production-media-reuse.test.js` to verify reuse across different attempt IDs and regeneration on missing/corrupt/changed assets; updated `test/audio-mixer.test.js` to use attempt-scoped integration output paths. The new test is included in `npm test`.
- PR #2 commits for this media-output pass: `662301dd5ea4e0a24e94bf242cb6421df8df2492`, `b952cc821c5e38871ffcdd8ec3b7f7aa094b4aa9`, `76612966e8041994bf0925b658960c11250c2017`, `aec35f94fcd9d0822bba16b5964f878901feedbb`, `150944da374741d968b351fb1842c66ba01d456c`, `2bbe3bf3871a7035f94cdd73751378ac14a9ea9c`, `953df10591b9434b315eb0090c51bbaf45e5c983`, `35478fdc167525a4831b77896519a4b4068d0734`, `c1217b758d33e741d3518cd887501329b270153c`, `552975ba3387ab4fadc44bc62bed662849ab8ed7`, `cd108cc1e7935c57610c0c6d122c52ac20584833`.
- Re-fetched `agents/production-management-agent.js`, `utils/ai-video-generator.js`, `test/production-attempt-artifact-cleanup.test.js`, `test/production-media-reuse.test.js`, `test/audio-mixer.test.js`, and `package.json`; all JavaScript parsed and package JSON parsed with the new test in `npm test`. This is static validation only. `npm test` and lint were not executed; Desktop Commander monthly quota remains exhausted and GitHub Actions has 0 runs for the current PR #2 head.
- Remaining limitation: cooperative lease assertions cannot create an atomic transaction spanning the lock row and an individual filesystem/DB mutation. The new attempt-scoped paths and after-provider checks reduce overwrite/orphan risks, but a narrow check-to-write race remains.
- Next: inspect provider clip/CineCode render outputs for additional external/local side effects and continue CI recovery. Do not merge or retarget the stacked PR.


## Latest PR #2 media-provider and CineCode lease fencing — 2026-11-20

- Live state at reconciliation: PR #1 open/draft/unmerged at `dcec5c12b7ae55ae1fbb69b6452398ddd97f6e81`, mergeable true; PR #2 open/draft/unmerged at `c7871a6c45df66280efb1b005c80e8f0a8b603ad`, base `feat/local-first-quality-gate`, mergeable false; PR #3 open/draft/unmerged at `3775dcf5b6e190b2aa27eb347ce9c3bda01b1934`, mergeable true. Workflow run queries return 0 for each current head. PR #2 remains stacked on PR #1; no rebase/merge was performed.
- `ProductionManagementAgent.assembleVideo()` forwards the current `artifactAttemptId` and `assertLease` into `AIVideoGenerator.generateVideo()`.
- `AIVideoGenerator.generateVideo()` now forwards the lease into MediaGenerationService and CineCode; into hybrid FFmpeg rendering, slideshow rendering, audio muxing and simulation; and treats lease loss as a hard stop instead of a provider error that can start a slideshow fallback.
- `MediaGenerationService.generateClips()` writes provider clips to paths keyed by production, attempt, provider and scene. It passes the assertion into each `generateClip()`, checks after provider/task writes and removes newly generated partial clip sets when a call aborts. Outputs reused from previously successful DB-backed tasks are explicitly marked and preserved during cleanup.
- `CineCodeRenderer.renderScenes()` receives the lease assertion, checks ownership around image validation/hash, FFmpeg render, output rename and manifest writes, and removes attempt-local output/manifest files after lease loss or a failed scene render. CineCode outputs are attempt-scoped because the output prefix is derived from the attempt-specific final-video path.
- Hybrid rendering now checks lease ownership around fingerprinting, FFmpeg timeline rendering, video validation, audio mux, and manifests. Slideshow capture/render/audio mux and simulation output use the same lease guard. The media provider path propagates lease loss without starting local fallback.
- Tests expanded: `test/media-generation-lease.test.js` now covers attempt-specific clip paths, cleanup of a partially completed clip set, preservation of reused clips, and loss after provider download. `test/cinecode-renderer.test.js` covers scene cleanup after output publication and verifies lease forwarding/no slideshow fallback. Both test files are already part of `npm test`.
- PR #2 commits for this pass: `f9b71338749bd99d69d68930b9c4cf6985b9c439`, `cbd3e2d120589ca4681961ae8b0f3eeae3f1cb35`, `499b5d7bd3f52597fdb958d98f36e5e24d4a57c9`, `121236f0379e88056e9e84ee4617863ff5eaedc5`, `4801c130927eeaea87f8b0d151924cfdf3e9d6d0`, `7e2e6422c06fb299fa985dcbf65ae044a5bb1483`, `5c7863363e21ee279aa8969f6ff9beb33109d7aa`, `08a8dbe753512777ef763113b44c368fbfd93c28`, `808cde86d5ce4e386deb71e61ba6cdef12e996e3`, `044cb5be3a2496078cacff1fd9d8677c6745c3b7`, `8aaa0aba9508b637bf27c73c3eeb4d9b3a58a6b8`, `ada931eb55abce02390ae3167de52e5e7da3eff2`, `d8f56cd68d7bc85d6327a112b226b6eb90075d49`, `1986fdc78a94f27672548c0afec600def59cbf88`, `2129ff8db0e24b73a5bc4b2a4b767210befee720`, `57b482d1c3449f4f7777e6bf18dd4d29c92f65a4`, `2b979f46769767d38527d88b4aec78a8200e1228`, `e44af41c479b61abc0397801dc5201af039edd5d`, `a02d0cf06bd44205a446d1f3734379ae8d1b7939`, `c7871a6c45df66280efb1b005c80e8f0a8b603ad`.
- Re-fetched core implementation/test/package files and parsed all JavaScript with `new Function()`; package JSON parsed and the tests are wired. This is static syntax verification only; runtime tests and lint were not executed. GitHub reports 0 workflow runs for current PR #2 head.
- Remaining risk: external provider task creation cannot be atomically fenced with a database lease check; if a provider request is already accepted immediately before lease loss is detected, remote work may continue when the provider has no cancellation capability. Local publication and DB success writes are fenced after the provider responds.
- Next: inspect remote-task cancellation/recovery semantics and continue the final provider side-effect audit, then obtain real CI. Do not merge or retarget the stacked PR.


## Latest PR #2 remote-task cancellation on lease loss — 2026-11-20

- PR #2 is open/draft/unmerged at `6e0d03b44e3bdadafa4ea8a178e586d6c116dac6`, base `feat/local-first-quality-gate`, mergeable false, with 0 workflow runs. It remains stacked on PR #1. PR #1 remains open/draft/unmerged, head `dcec5c12b7ae55ae1fbb69b6452398ddd97f6e81`, mergeable true. PR #3's head changes when these continuity documents are updated; refresh it before the next action.
- `MediaGenerationService.generateClip()` now keeps the external provider task ID in memory as soon as `createTask()` or `getTask()` returns, before writing that ID to the local task row. If the generation lease is lost in this gap, the service invokes `cancelTask()` only when provider capability metadata explicitly declares cancellation and the remote task is not terminal.
- The cancellation helper logs unsupported cancellation and provider API failure without attempting stale database writes. The inspected provider registry currently advertises cancellation for Seedance; providers without that capability may continue remote processing after local lease loss.
- Added regression coverage in `test/media-generation-lease.test.js` for a queued remote task whose ID has not yet been persisted when the lease is lost. The test asserts remote cancellation, no stale task-row update, and no local output.
- Commits: `5aa8fe8ae38a6387246227618f51d155d7b97701` (cancellation handling), `6e0d03b44e3bdadafa4ea8a178e586d6c116dac6` (test).
- Re-fetched the media service, provider registry and regression test from GitHub and parsed their JavaScript syntax. Static verification only; runtime tests/lint are not run. Current PR #2 head has 0 workflow runs.
- Remaining limitation: providers without cancellation capability cannot be forcibly stopped by this path; they may finish or incur remote cost even though the stale worker will not publish results or persist success locally.
- Next: audit retry/idempotency/reconciliation for non-cancellable remote tasks and obtain an actual CI run. Do not merge.


## Latest PR #2 remote media task idempotency and operator reconciliation — 2026-11-20

- Live PR state: PR #1 open/draft/unmerged at `dcec5c12b7ae55ae1fbb69b6452398ddd97f6e81`, mergeable true; PR #2 open/draft/unmerged at `6e0d03b44e3bdadafa4ea8a178e586d6c116dac6`, base `feat/local-first-quality-gate`, mergeable false; PR #3 open/draft/unmerged at its latest continuity-doc head (refresh at next session). PR-triggered workflow queries return zero runs for all three current heads. The PR #2 stacked dependency is preserved.
- Provider submissions now use a durable write-ahead intent: initial row is `submitting` before `createTask()`. A lost response or crash before external ID persistence is treated as ambiguous and blocks automatic retry rather than risking duplicate paid generation.
- Known external IDs are resumed by polling the same remote task. Transient polling errors become `reconciliation_required`; successful provider jobs with failed downloads become `download_pending`. Previous terminal external IDs are retained in `provider_data.previousTasks` for auditing before a replacement submission.
- SQLite task creation now identifies the true insert claimant. Job-scoped tasks use `ON CONFLICT(job_id, scene_index, provider) DO NOTHING`; null-job/manual tasks are looked up by `production_id` and created with a conditional `INSERT ... SELECT ... WHERE NOT EXISTS`. A caller may submit to the provider only when `createdByThisInvocation === true`; missing ownership proof fails closed. Terminal failed/cancelled task retries use a conditional database claim, so only one worker can begin a replacement remote job.
- The DB update method explicitly supports clearing stale external task IDs and output paths with `null`. Manual task identity is scoped by job or production, avoiding cross-production reuse.
- Added protected operator APIs: `GET /api/media-generation/tasks/unresolved`, `POST /api/media-generation/tasks/:taskId/reconcile`, and `POST /api/media-generation/tasks/:taskId/resolve-no-task`. Remote ID reconciliation queries the configured provider and accepts only a known status; absent-task resolution requires an explicit boolean confirmation. Fresh `submitting` records are protected by a 10-minute grace period before either manual action.
- Added `docs/MEDIA_TASK_RECONCILIATION.md` with operator recovery steps and provider-dashboard checks.
- `test/media-generation-lease.test.js` now contains 14 test functions covering SQLite null-clearing, manual production scoping, atomic initial claim, atomic retry claim, missing ownership proof, ambiguous timeout, lease loss after remote creation, provider cancellation, manual reconciliation/resolution, stale-submission guard, previous-task history and same-task polling on retry. It is already included in `npm test`.
- Core current code/test commits: `9968aaba437c1bb0cd033e6b1e0fd4ce93355911`, `83cc80ba622e26de5ebb7485b1c4e8e9b505e7fd`, `7a97cfd9a2580025e078ca55e7becf0b4cb47519`, `a071c001eed4af59191d9ba8f0a6aaf543dd3842`, `fc2b6ce7136a04e8157ebca788b24c4ae0fa37a0`, `4428a5c0749d314285d73004abed5e9ad8a69348`, `d68ebc2d7a7d404268cf020627c6200d68a8e001`, `ceb87bca9acc9222348d2a834ba046971aaccd53`, `15cdd161c6174622c2040f2dd24025fe4540b682`, `6e0d03b44e3bdadafa4ea8a178e586d6c116dac6`. Supporting write-ahead, DB, tests, routes and docs commits are recorded in `AGENT_TASKS.md` / `AGENT_LOG.md`.
- Re-fetched `index.js`, `database/db.js`, `utils/media-generation-service.js`, `utils/video-providers.js`, `test/media-generation-lease.test.js`, `package.json` and reconciliation docs; all JavaScript syntax and package JSON parsing passed. The 14-test media regression suite is wired into `npm test`. This is static validation only; runtime tests/lint were not executed. Desktop Commander remains quota-blocked; GitHub Actions has zero PR-triggered runs for the current PR #2 head.
- Remaining boundary: providers without cancellation support can continue remote work after the local lease is lost. The write-ahead record prevents silent duplicate submission and the operator reconciliation flow resolves the ambiguous outcome, but it cannot forcibly terminate an external task.
- Next: obtain a real CI run for PR #2, then fix any runtime/test failures and re-check the stacked PR mergeability. Do not merge.


## PR #2 legacy remote-task compatibility and final claim hardening — 2026-11-20

- Live PR state at reconciliation: PR #1 open/draft/unmerged at `dcec5c12b7ae55ae1fbb69b6452398ddd97f6e81`, mergeable true; PR #2 open/draft/unmerged at `6e0d03b44e3bdadafa4ea8a178e586d6c116dac6`, base `feat/local-first-quality-gate`, mergeable false; PR #3's head follows continuity commits and must be refreshed next session. PR-triggered workflow queries return 0 runs for all three current heads. PR #2 remains stacked on PR #1.
- New rows are created as `submitting` before any remote provider API call. Unresolved no-ID rows block resubmission. Known remote IDs are queried on retry; polling outages are recorded as `reconciliation_required`, and download failures as `download_pending`.
- Legacy compatibility: rows from previous versions could be `failed` while still holding an external provider task ID (because a polling/network error was previously persisted as failed). Such rows are now queried at the provider before replacement. If the provider reports queued/running/succeeded, the same remote task is resumed; only a verified terminal failed/cancelled result can be archived and atomically replaced.
- Initial DB ownership is fail-closed: remote generation requires durable DB task tracking and an explicit `createdByThisInvocation === true` marker. Job-scoped tasks use SQLite's unique conflict no-op; manual `jobId = NULL` tasks use a conditional `INSERT ... SELECT ... WHERE NOT EXISTS` scoped by production ID. A caller may submit only when ownership is proven. Terminal retries use a conditional SQLite update claim; concurrent losers do not mutate task state or call the provider.
- Manual operator reconciliation remains available via the three protected endpoints documented in `docs/MEDIA_TASK_RECONCILIATION.md`. Fresh `submitting` rows are blocked from manual resolution for 10 minutes; the provider dashboard must be checked before explicit absent-task confirmation.
- Latest legacy compatibility / fail-closed commits: `b5c2a83f0ba3c45d7b7a586a43a23aabf10054b0`, `ad309461248954801ab6bc330f6259b616fc5c31`, `aeeecb9ed83f12f56c765f0f3bf3b2e420bbfcd2`, `6e0d03b44e3bdadafa4ea8a178e586d6c116dac6`. Final static-test hardening commits: `fc2b6ce7136a04e8157ebca788b24c4ae0fa37a0`, `4428a5c0749d314285d73004abed5e9ad8a69348`, `d68ebc2d7a7d404268cf020627c6200d68a8e001`, `ceb87bca9acc9222348d2a834ba046971aaccd53`, `15cdd161c6174622c2040f2dd24025fe4540b682`, `647e7aa26679fcad142baa8ebbdac6e6090ca35b`.
- Re-fetched seven implementation/test/package/doc files from GitHub; all JavaScript parsed and package JSON parsed. `test/media-generation-lease.test.js` declares 14 test functions, calls all 14 from its runner, and is already part of `npm test`. This is static syntax validation only; runtime tests/lint were not executed. The execution container cannot resolve github.com, Desktop Commander is monthly quota-blocked, and GitHub returns zero PR-triggered workflow runs; an actual full CI result remains pending.
- No PR merged, retargeted or rebased. No publishing automation or paid-provider defaults were changed.
- Next: obtain a real CI run for PR #2; resolve runtime failures if any, then re-evaluate stacked PR mergeability without rewriting history.


## 2026-11-20 — Atomic operator reconciliation conflict guard

- Live PR state: PR #1 open/draft/unmerged at `dcec5c12b7ae55ae1fbb69b6452398ddd97f6e81`, base `master`, mergeable true; PR #2 open/draft/unmerged at `cc53b532c2afa95f627e57d7aea58eda608f1a7b`, base `feat/local-first-quality-gate`, mergeable false; PR #3 open/draft/unmerged, latest head follows this continuity-branch update, mergeable false. PR-triggered workflow queries return zero runs for the three latest observed heads. PR #2's stacked base relationship is unchanged.
- Found that manual provider-task reconciliation and explicit “no remote task” resolution performed an unconditional update after a provider lookup / initial row read. A competing operator or worker could have changed the row in the meantime.
- Added `Database.compareAndSetMediaGenerationTask()`: one SQLite UPDATE checks the expected status and external task ID in its WHERE clause. Reconciliation and absent-task resolution now require this atomic update and return a 409 conflict if the row changed. The stale action does not overwrite the newer state.
- Added an SQLite-backed regression assertion: the first compare-and-set wins, and a second stale update using the old expected state is rejected. The existing 14 media regression functions remain wired into `npm test` and are all invoked by the test runner.
- Commits: `07ee9aaf8030d5553acf9774b73973e97224f367`, `7a0de7c82f4da2a3112f113136963fa77785b402`, `dc5a53764cdb3dadbd37570cc65fe3c1f679de49`, `749cb821a895e74ba8636e6b5170e564ba7723a7`.
- Static verification: JS syntax parsing passed for `utils/media-generation-service.js`, `database/db.js` and `test/media-generation-lease.test.js`; `package.json` parsed; docs were re-fetched. This is not runtime execution. Tests/lint remain unexecuted and no CI run is available for current heads.
- Next: obtain a real PR #2 CI run, address any actual runtime/regression failures, and then review stacked mergeability without changing the dependency. Do not merge.


## Latest PR #2 reconciliation race guard — 2026-11-20

- `reconcileTaskSubmission()` and `resolveAmbiguousSubmissionAsAbsent()` now use `compareAndSetMediaGenerationTask()` rather than unconditional writes after a provider lookup/operator confirmation.
- SQLite performs one conditional `UPDATE ... WHERE id = ? AND status = ? AND external_task_id IS ?`; stale competing actions cannot replace a newer task state and return HTTP 409.
- Added real SQLite coverage for a successful compare-and-set followed by a stale competing update, plus service test-double compatibility.
- Commits: `07ee9aaf8030d5553acf9774b73973e97224f367`, `7a0de7c82f4da2a3112f113136963fa77785b402`, `dc5a53764cdb3dadbd37570cc65fe3c1f679de49`, `749cb821a895e74ba8636e6b5170e564ba7723a7`, `cc53b532c2afa95f627e57d7aea58eda608f1a7b`.
- Re-fetched source, DB, tests and reconciliation docs. JavaScript syntax and JSON parsing only; runtime tests/lint not executed. PR #2 current head `cc53b532...` has zero PR-triggered workflow runs. PR #1 head `dcec5c12...` remains open/draft/mergeable; PR #2 remains stacked and not mergeable; PR #3 head `aa30932...` is open/draft/mergeable. No PR merged or retargeted.
- Next: get an actual full CI run on PR #2, then address runtime failures. Do not merge.


## Latest PR #2 scene-edit lease hardening — 2026-11-20

- Ordinary scene edits and timeline reordering previously used a lock without heartbeat or lease assertions. They now run under the heartbeat-backed production operation lease, like other long-running scene operations.
- Lease assertions are threaded through editable-bundle loading, scene DB writes, provenance review, reorder persistence and revision-history writes. Missing DB lock acquire/release support fails closed with `SCENE_EDIT_LOCK_UNAVAILABLE`.
- Commits: `9111b79aa624592b48322fe3a0dbf19392bace27`, `b8abf3a09a6ef20ffd3722dd7a7e6116eec74d1e`.
- Static JS syntax and package JSON checks passed; scene repair tests are wired into npm test but runtime tests/lint have not run. Current PR #2 head `b8abf3a09a6ef20ffd3722dd7a7e6116eec74d1e`; no PR-triggered workflow run observed.
- Next: obtain full CI and test lease-loss paths; do not merge.


## Latest PR #2 scene-edit lease regression coverage — 2026-11-20

- Removed the unused `withProductionEditLock()` helper, eliminating its unsafe lock-optional fallback from the scene repair service.
- Added `test/scene-edit-lease.test.js`: verifies update and reorder abort before DB writes after lease assertion failure; public methods fail closed with 503 when lock support is absent; lock contention returns 409.
- Added the new test to `npm test`.
- Commits: `79348283424180f5113b95e75860007983291307`, `ea647cb6f5165d6644ef1cd04e0adfe4f0a39d71`, `e1d02341c8830d2124647ab165314e65fea1fb43`.
- Static JS syntax and package JSON checks passed. Runtime tests/lint not executed. PR #2 head is expected to be `e1d02341c8830d2124647ab165314e65fea1fb43`; verify metadata and CI before further work. Keep PR open/draft; do not merge or retarget.


## Latest PR #2 scene lease renewal requirement — 2026-11-20

- Audit found `withProductionOperationLease()` treated `renewProductionOperationLock()` as optional. Without it, the heartbeat was silently skipped while scene edits continued under a non-renewed lease.
- Scene operations now fail closed unless DB acquire, renew and release methods all exist; after acquisition the heartbeat renewal is always started. Renewal failure/exception continues to block subsequent writes through `assertLease()`.
- Added a regression in `test/scene-edit-lease.test.js` proving missing renewal support returns `SCENE_EDIT_LOCK_UNAVAILABLE` / HTTP 503. Existing fixtures now provide a renewal method where required.
- Commits: `6cfc05db9090e561e7c02ab8830ba928298c3733`, `25c0e2e47c86be8de5dc309ad2841a996a3394b5`.
- Static JavaScript syntax and package JSON parsing passed. Runtime tests/lint not executed. Recheck PR #2 head and Actions; keep draft and do not merge.


## Latest PR #2 generation lease heartbeat serialization — 2026-11-20

- Audited generation-wide lease helper and found heartbeat renewals could overlap: `setInterval` assigned a fresh renewal promise without chaining the previous one. A slow renewal could remain in flight after `assertLease()` or `release()` awaited only the newest promise.
- Updated `utils/generation-job-lease.js` to serialize heartbeat renewals through a promise chain. `assertLease()` and `release()` now wait for the complete queued chain, and queued callbacks stop after release or lease failure.
- Added `testHeartbeatRenewalsAreSerialized()` to `test/generation-job-lease.test.js`; verifies a delayed renewal prevents overlap, queued renewal completes before lease assertion, and maximum concurrent renewals remains one. Existing npm test script already includes this test file.
- Commits: `9e1fa4d2f0196fd79dd5afc783d0da7646d7f517`, `529baa9dd4740ddb73d1afdb0e727a226fd28821`.
- Static JS syntax checks passed for generation lease and lease tests; `package.json` parses and includes generation lease test. Runtime tests/lint not executed. Keep PR #2 open/draft; do not merge or retarget.


## Latest production operation lease audit — 2026-11-20

- Found `SceneRepairService.replaceAsset()` calling a missing `withProductionEditLock()` method. Replaced it with the shared `withProductionOperationLease()` wrapper and threaded `assertLease` into `replaceAssetUnlocked()` before bundle access, filesystem writes, scene metadata writes, and revision writes.
- Found `SceneRepairService.rebuild()` still treated DB lock acquire/renew support as optional. It now fails closed with `SCENE_REBUILD_LOCK_UNAVAILABLE` / HTTP 503 unless acquire, renew, and release methods all exist. Local in-process rebuild contention is still checked first and remains HTTP 409.
- Found `ProductionManagementAgent.processContent()` and `resumeProduction()` only checked acquire support and launched independent heartbeat promises. Both now require acquire/renew/release support, return explicit HTTP 503 lock-unavailable errors, and serialize heartbeat renewals so assertions wait for queued renewals.
- Added missing-lock regression coverage for rebuild, job production and resume; routed asset replacement through the shared lease; updated the cache test fixture to supply required lock methods.
- Commits include `0d544b2`, `5a0bfce`, `879881d`, `e7969ed`, `9fcb8ca`, `424252c`, `094e7c8`, `7b1f5ae`.
- Static JS syntax checks passed for changed implementation and tests; package JSON parses and test script includes affected test files. Runtime tests/lint not executed. PR #2 remains open/draft; do not merge or retarget.


## Latest asset-upload lease fencing — 2026-11-20

- Audited stale-worker side effects and found `replaceAssetUnlocked()` wrote uploaded media directly to a deterministic revision path before its lease assertion. If lease verification failed immediately after the write, the file was outside cleanup handling and remained orphaned.
- Uploads now use a unique per-attempt temporary file with exclusive creation, validate that temporary file, assert lease before publication, and rename to a unique revision path. If an error occurs before the scene DB update persists, both temporary and published attempt paths are removed. Once DB update succeeds, the referenced file is retained even if later revision-history work fails.
- Added a regression to `test/scene-edit-lease.test.js`: simulated lease loss after upload write leaves the scene-assets directory empty. Test is wired into `npm test`.
- Commits: `9b445a7841e2df0015c9f5bab00d88f868ae0fa6`, `2f2e9b9df5fea658cdd443bb1ecfe104c8a9ebb2`, `d5e8dac847a45473210a45ade55b894184d3c45a`.
- Static JS syntax checks passed; runtime tests/lint not executed. PR #2 remains open/draft; no merge or base changes.


## Latest image-generation lease fencing — 2026-11-20

- Found that `generateVisualAssets()` swallowed every image-provider error and wrote simulated `.info` artifacts, even when the production lease had been lost. A late image provider response could also be atomically renamed to the published path without an internal lease assertion. `generateThumbnail()` similarly used a millisecond-only shared output name and fell back to simulation for any error.
- The production agent now passes its `assertLease` callback to `generateVisualAssets()` and `generateThumbnail()`. `generateImage()` checks ownership before starting, after provider completion, and immediately before rename; on lease loss it removes the provider attempt file and rethrows without trying another provider. Visual and thumbnail fallback handlers recheck lease ownership before simulation. Simulated artifact writers check before/after writes and clean up on failure. Thumbnail output names include a UUID to prevent same-millisecond collisions.
- Regression coverage added for late provider output being discarded and simulated fallback being blocked after lease loss. Existing fallback cleanup test now writes to and verifies the actual attempt path. Both tests are already included in `npm test`.
- Commits: `963df9d6886807a0544923212191aa5e109639c5`, `a09716ad5e089f1855d7ad5cc1c2bdb7c049e636`, `3afde4bf1c61fe1c12ddc4c6afafdce0df851680`, `e98e5e8039c8a409f9e64f73b1ac73140a2bb549`.
- Static JS syntax checks and package JSON parsing passed. Runtime tests/lint were not executed. PR #2 remains open/draft; no merge or base changes.


## Latest FFmpeg child-process lease cancellation — 2026-11-20

- `utils/ffmpeg.js` previously used promisified `execFile` without an abort signal. A worker could lose its generation lease while FFmpeg continued running and writing its temporary output.
- `runFFmpeg(args, { assertLease, leaseCheckIntervalMs })` now verifies ownership before spawn and polls it while the child runs. Lease failure aborts the child with `AbortController`; the helper waits for the in-flight lease check and propagates the original lease error. Calls without a lease callback retain the prior behavior.
- Threaded `assertLease` through CineCode scene renders, hybrid visual timeline renders, slideshow renders, video muxing, render validation decode, background music mix/validation, and Gemini TTS PCM encoding. Production assembly now passes its lease callback into background music mixing and TTS generation.
- Background music mixing now removes attempt output and manifest files if lease loss happens after the output was published. This complements the existing attempt-scoped paths and caller cleanup.
- Added regression coverage for an active real FFmpeg process being aborted on lease loss (runs when FFmpeg is available), audio mixer receiving the lease guard, production assembly passing the guard, and post-publication mix cleanup. Existing CineCode/audio tests are wired into `npm test`.
- Commits: `028cf9a9fa55646c43d6ef6833d43d8d05dc9a56`, `e97f317a784dbc62937a24b16d0edcdfd6162bda`, `0a00d5511bd969560766b9a28244f19e6a3d40dd`, `5c5d80e901dde39e14fc43f155c80cdb901279bf`, `c50bbb5bf42cbb216d5c62a1e905bb49852ba193`, `7bfd7738f447ef30a4cde6b7a404abb25476bfb3`, `2d8b979362851db3d46352772f83f660330e46f5`, `6e397e3b90b4924c9909574da746f9841b27acca`, `38a5fdd8cc08a1c377fcf6ecd44402bc92a63c9f`, `d451ad7fad6cfce18af34cb2df8f102c2c5b1b00`, `b11ec6b07315385aebaf34519808982cd2180c68`.
- Static JS syntax checks and package JSON parsing passed. Runtime tests/lint were not executed in this environment. PR #2 remains open/draft; no merge or base changes.
