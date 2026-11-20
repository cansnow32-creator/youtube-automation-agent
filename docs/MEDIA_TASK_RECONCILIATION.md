# Media provider task reconciliation

Media generation tasks are persisted before a remote provider submission. If the process loses its lease or the provider request times out before returning an external task ID, the row remains in `submitting` or moves to `submission_unknown`. Automatic retries are blocked in this state so the application cannot accidentally create a second paid provider task.

All endpoints below are intended for the loopback dashboard/operator API. Set `API_KEY` to require the `x-api-key` header; the application also refuses to bind beyond loopback while read-only routes remain unauthenticated.

## Find unresolved tasks

```http
GET /api/media-generation/tasks/unresolved?limit=100
```

The response includes the internal media task ID, job/production ID, scene index, provider, status, current external task ID (if known), and error. The internal task ID is used in the reconciliation actions.

## Attach a task found in the provider dashboard

After locating the matching task in the provider's own dashboard, submit its external task ID:

```http
POST /api/media-generation/tasks/<taskId>/reconcile
Content-Type: application/json
x-api-key: <API_KEY>

{
  "externalTaskId": "<provider-task-id>"
}
```

For Kling tasks, supply the originating task type when known:

```json
{
  "externalTaskId": "<provider-task-id>",
  "providerTaskType": "image2video"
}
```

Allowed task types are `text2video` and `image2video`. The server queries the configured provider before changing the local row. It accepts only a recognized remote status. A running/queued task is resumed by polling the same external ID; a succeeded task becomes `download_pending` so the existing output can be downloaded without generating another video. The final update is conditional on the row still having the status and external task ID that were read before the provider query; if another operator action or worker changed it meanwhile, the API returns `409` and does not overwrite the newer state.

## Resolve an ambiguous submission that does not exist remotely

Use this only after checking the provider dashboard and confirming that no remote task was created for the original submission. This action marks the local row as terminally failed so a future retry may submit a new provider request.

A task that is still in `submitting` is treated as potentially in flight. Manual reconciliation or clearing is blocked for the first 10 minutes after its last update. Wait for that interval, inspect the provider dashboard, and then perform the appropriate action.

```http
POST /api/media-generation/tasks/<taskId>/resolve-no-task
Content-Type: application/json
x-api-key: <API_KEY>

{
  "confirmedNoRemoteTask": true
}
```

The server rejects the request unless the boolean confirmation is exactly `true`, and it refuses to clear a row that already has an external task ID. Do not use this endpoint merely because a provider status request is temporarily unavailable.

## Recovery rules

- `submitting` / `submission_unknown` with no external ID: do not retry automatically; reconcile manually.
- `reconciliation_required` with an external ID: poll the same remote task; do not submit a replacement.
- `download_pending`: query the existing succeeded task and retry its download; do not regenerate it.
- `failed` / `cancelled` with a known terminal provider status: a later retry may create a new task, with the previous external ID retained in `provider_data.previousTasks`.
- Providers without cancellation support may continue working remotely after local lease loss. The local row remains blocked until the remote task is found or its absence is explicitly confirmed.

These steps are recovery controls, not proof of billing status. Confirm charges and task state with the provider's dashboard before resolving an ambiguous submission as absent.
