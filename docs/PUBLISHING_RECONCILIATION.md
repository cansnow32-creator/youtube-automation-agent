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
