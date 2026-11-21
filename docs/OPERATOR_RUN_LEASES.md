# Autonomous operator run leases

The autonomous channel operator is a singleton across all application processes, not merely within one Node.js process.

- The operator acquires the shared `operator:active` row in `production_operation_locks` before creating or resuming a run.
- The owner renews the 60-second lease every 15 seconds for the full research/production lifecycle.
- Operator state writes validate the lease in the same isolated SQLite transaction as the update.
- A process without the lease may request cooperative cancellation, but cannot overwrite progress, results, or terminal status.
- Startup recovery interrupts queued/running/cancelling operator rows only when no unexpired `operator:active` lease exists.
- Lease loss fences later operator writes. Generation workers retain their own independent generation leases and are not cancelled implicitly.

This is process coordination, not a publishing authorization. Operator completion never grants permission to publish or schedule a video.
