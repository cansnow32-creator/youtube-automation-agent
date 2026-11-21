# Publishing approval claim

The publisher performs user-facing review and readiness checks before starting an upload. The durable SQLite upload claim repeats the approval requirement in the same conditional UPDATE that changes a schedule row to `uploading`.

The claim branches on the schedule's `metadata.contentType`: a long-form production requires a matching `content_reviews.status = 'approved'` row; a Short requires a matching schedule-linked `shorts_clips` row with a non-null approval timestamp, ready inherited evidence, an eligible scheduled/retry status, and a still-approved source production review. Short schedule linkage is checked against both `metadata.shortClipId` and `metadata.sourceProductionId`, because the schedule's `production_id` is the Short ID while the clip's `production_id` is its source production. A long-form approval cannot authorize an unapproved Short, and a Short approval cannot outlive revocation of its source production approval.

This closes the gap where approval could be revoked after the publisher's initial read but before the durable upload claim. A failed claim returns no row and must not call YouTube. Existing upload-attempt IDs continue to fence stale upload workers after the claim.
