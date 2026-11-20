# Production Stage Workflow

The production manager records the execution of its production stages in
`production.timeline.productionWorkflow`. The workflow is persisted with the
production timeline, so the current stage and the last completed stage remain
visible after a restart.

## Stages

1. **Research** — initialized as completed only after the selected video concept
   has passed the approved-concept gate. The approved concept ID is retained as
   evidence.
2. **Visuals** — records the visual asset generation step.
3. **Narration** — records the narration generation step and its returned
   artifact path.
4. **Editing** — records captions, final assembly, and the scene-addressable
   production manifest.

Each stage moves through `pending`, `in_progress`, and then either
`completed` or `failed`. A stage cannot start while another stage is active,
and a later stage cannot start until its predecessor is completed. A failed stage is retained in the workflow record with a bounded error
message. On resume, an interrupted or failed stage is retried while completed
stages are preserved. Each new attempt increments its attempt counter.

The workflow is execution tracking, not a publishing approval. A completed
editing stage does not publish a video or enable automatic publishing. Existing
publishing controls and gates remain responsible for any later upload action.

## Persisted shape

The workflow is stored under the production's serialized timeline:

- `version`: workflow schema version
- `currentStage`: active stage name, or `null`
- `stages`: per-stage status, timestamps, and result/error metadata
- `updatedAt`: last transition timestamp

The stage helper is in `utils/production-stage-workflow.js`; its behavior is
covered by `test/production-stage-workflow.test.js` and included in `npm test`.


## Resuming production

`ProductionManagementAgent.resumeProduction(productionId)` reloads the production bundle and its saved stage state. It revalidates the approved concept, preserves completed stages, and retries the first failed or interrupted stage. The production strategy, script, thumbnail, and SEO snapshot are saved alongside the production record so the job can be reconstructed after a restart. Resuming production does not approve or publish a video.


## Dashboard retry behavior

The existing protected `POST /api/content/:productionId/retry` endpoint now resumes a failed or interrupted production when a persisted stage workflow exists. It reuses the saved script, approved concept, and completed stage artifacts, then retries from the first failed or interrupted stage. Older productions without a persisted workflow keep the existing full-generation retry behavior. The endpoint does not schedule or publish content as part of recovery; the separate operator approval and publishing gates remain in force.
