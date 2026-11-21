# YouTube upload reconciliation

A schedule entry in `uploading` or `reconciliation_required` is deliberately blocked from automatic retry. The original request may have reached YouTube even if the application never received or persisted its response. Do not reset these rows or call the upload endpoint again until the outcome has been checked.

## List unresolved uploads

Call the protected operator endpoint:

```http
GET /api/publishing/unresolved
```

It returns the schedule ID, production ID, title, current state, and last error. The endpoint accepts an optional `limit` query parameter (1–200).

## Attach an existing YouTube video

1. Open YouTube Studio for the Google account configured in this application.
2. Locate the upload, including private, unlisted, scheduled, and draft videos. Confirm that its title corresponds to the unresolved schedule entry.
3. Copy the 11-character video ID from the video's URL.
4. Submit the ID:

```http
POST /api/publishing/{scheduleId}/reconcile
Content-Type: application/json

{ "videoId": "VIDEO_ID_FROM_YOUTUBE" }
```

The application independently verifies the ID with `videos.list`, verifies that the video's channel ID matches the authenticated account's `channels.list(mine=true)` result, and checks that the normalized video title matches the scheduled title. A video from another channel, an unknown ID, or a title mismatch is rejected without changing the schedule.

A successful compare-and-set changes the schedule to `published`, stores the video ID and URL, and synchronizes a linked Short. Concurrent or stale operator actions cannot overwrite a newer decision.

## Confirm that no upload exists

Only use this path after manually checking the correct YouTube Studio channel and confirming that the original upload did not create a video. Check all visibility states and scheduled/draft content; a missing response is not evidence that YouTube rejected the upload.

```http
POST /api/publishing/{scheduleId}/resolve-no-upload
Content-Type: application/json

{ "confirmedAbsent": true }
```

This explicit operator decision records an audit entry in schedule metadata and changes the unresolved entry to `failed`. The database records the upload attempt start time and enforces a **10-minute minimum grace period** before accepting an absence decision, even if the row is still marked `uploading`. If the grace period has not elapsed, the API returns `UPLOAD_GRACE_PERIOD_ACTIVE`; wait, re-check YouTube Studio, and try again. A known-failed entry can then be retried through the normal manual publishing flow. The application does not automatically infer absence and does not automatically retry an unresolved upload.

## Access and safety

Both mutation endpoints use the same API-key middleware as the other operator APIs. Set `API_KEY` and send it in the `x-api-key` header. If no key is configured, the application must remain bound to loopback; the server refuses non-loopback binding because the dashboard does not have session authentication.

Never attach a video ID based only on its title or a public search result. The authenticated-channel check is mandatory. If the authenticated Google account is not the channel that owns the video, resolve the account/credential configuration first.


The automatic recovery path for a previously recorded video ID applies the same ownership and normalized-title checks as operator reconciliation. It updates the schedule only with a compare-and-set against the exact previously observed status and video ID; stale verification results are rejected.

## Scheduled queue recovery

The publishing scheduler reloads `scheduled` and `paused` entries from SQLite on every 15-minute processing tick. This makes overdue scheduled rows eligible for catch-up after an application restart and prevents the scheduler from relying on a stale in-memory snapshot. If the database read fails, the in-memory queue is cleared and that tick does not publish from stale data.

A scheduled row with an invalid `publish_time` is moved to `failed` with an explanatory error instead of being treated as due. Correct the schedule through the normal operator flow before retrying. Entries in `uploading` or `reconciliation_required` remain excluded from the automatic queue and must follow the reconciliation procedure above. Atomic SQLite upload claims remain the final cross-process duplicate-upload guard. Every claim also receives a fresh opaque `upload_attempt_id`. The accepted YouTube ID, post-upload thumbnail/caption metadata, and final published/failed/reconciliation state are written only when that exact attempt ID still owns the schedule row. If an older worker resumes after a retry has claimed the same row, its compare-and-set affects zero rows and it cannot attach an old video ID or downgrade the newer schedule.

## Schedule creation idempotency

Schedule creation is idempotent per production ID. SQLite performs the existence check and insert in one conditional write statement; concurrent callers reuse the winning schedule row. The regression test uses two independent SQLite connections and verifies that only one row is persisted for the production.

## Persisting the accepted upload response

As soon as `videos.insert` returns a video ID, the publisher stores that exact ID, URL, and metadata with the atomic `recordScheduleEntryUploadResult` database operation. The write only succeeds for the schedule currently claimed as `uploading` with no prior YouTube ID; repeating the same ID is idempotent, while a different ID cannot overwrite it. The schedule remains `uploaded` until the publishing flow completes its final status update.

Thumbnail and caption uploads are separate post-upload asset steps. Their outcomes are recorded independently in `metadata.thumbnailUpload` and `metadata.captionUpload`; a failure does not change the accepted video's upload state or trigger another video upload. Repair a failed thumbnail through `POST /api/content/{productionId}/retry-thumbnail` and failed captions through `POST /api/content/{productionId}/retry-captions`. Both endpoints require a recorded YouTube video ID and a recorded failed asset state, reuse that video ID, and never call `videos.insert`. If persistence or finalization becomes uncertain after YouTube accepted the video, the durable upload state and reconciliation flow take precedence over any retry.

## Recorded YouTube ID takes precedence

If a schedule row contains a YouTube video ID, every publish attempt verifies that existing remote video before checking local narration/assets or considering a new upload. This allows recovery even if local assets later become unavailable. Schedules with a recorded YouTube ID cannot be rescheduled or deleted, and content approval cannot reset their state; reconcile the existing upload first. Regression coverage lives in `test/publishing-recorded-upload.test.js`.
