# Publishing approval claim

The publisher performs user-facing review and readiness checks before starting an upload. The durable SQLite upload claim repeats the approval requirement in the same conditional UPDATE that changes a schedule row to `uploading`.

The claim branches on the schedule's `metadata.contentType`: a long-form production requires a matching `content_reviews.status = 'approved'` row; a Short requires a matching schedule-linked `shorts_clips` row with a non-null approval timestamp, ready inherited evidence, an eligible scheduled/retry status, and a still-approved source production review. Short schedule linkage is checked against both `metadata.shortClipId` and `metadata.sourceProductionId`, because the schedule's `production_id` is the Short ID while the clip's `production_id` is its source production. A long-form approval cannot authorize an unapproved Short, and a Short approval cannot outlive revocation of its source production approval.

This closes the gap where approval could be revoked after the publisher's initial read but before the durable upload claim. A failed claim returns no row and must not call YouTube. Existing upload-attempt IDs continue to fence stale upload workers after the claim.

## Approval invalidation and edit serialization

Editing the content editor data after approval now revokes the prior approval, clears the prior quality-check results, and returns the production to `needs_review`. A no-op save does not revoke approval. Content edits and operator approval both run under the same production operation lease, so a concurrent edit cannot race a quality check and then be overwritten by a stale approval. The approval path also lease-fences schedule creation/update, review persistence, and the production status transition. Upload claims continue to re-check the durable review state before calling YouTube. The same atomic claim also refuses to proceed while an unexpired production operation lease exists for the source production, preventing the scheduler from racing an edit, approval, rejection, or review refresh.


## Shorts edit serialization

Short draft edits use the same source-production operation lease as Short approval and rendering. The edit route acquires the lease before reading the clip, and the database update rechecks the lease, source-production identity, and editable clip status in one isolated SQLite transaction. This prevents an edit from racing approval and changing a Short after its schedule has been attached. A stale owner or a clip that has entered rendering/approval/scheduling is rejected with a conflict.
