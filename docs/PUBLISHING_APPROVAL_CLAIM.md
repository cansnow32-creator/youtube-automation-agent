# Publishing approval claim

The publisher performs user-facing review and readiness checks before starting an upload. The durable SQLite upload claim repeats the approval requirement in the same conditional UPDATE that changes a schedule row to `uploading`.

A long-form production claim requires a matching `content_reviews.status = 'approved'` row. A Short claim requires a matching schedule-linked `shorts_clips` row with a non-null approval timestamp, ready inherited evidence, and an eligible scheduled/retry status.

This closes the gap where approval could be revoked after the publisher's initial read but before the durable upload claim. A failed claim returns no row and must not call YouTube. Existing upload-attempt IDs continue to fence stale upload workers after the claim.
