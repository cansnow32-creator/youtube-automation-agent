# Artifact Retention and Garbage-Collection Safety

Status: design and inventory only. No permanent artifact garbage collector is enabled by this document.

## Why cleanup must be reference-aware

Production outputs are referenced from several independent database records. A file that looks old or is not referenced by the current `productions.assets` object may still be required for recovery, scene revision, a rendered Short, an experiment, or a user-supplied reference video. A timestamp-only sweep is therefore not safe.

The current scene-repair cleanup is intentionally narrower: it targets attempt-scoped temporary render, caption-writing, and audio-writing files for one production after acquiring that production's operation lease. It does not delete final video, narration, scene assets, Shorts, thumbnails, or user reference videos.

## Persistent reference inventory

A future collector must inspect all of the following before considering a path unreferenced:

| Table / record | Path-bearing fields | Retention concern |
| --- | --- | --- |
| `productions` | Serialized `assets` and `timeline` | Main production manifest; nested paths include visual assets, audio, captions, final/clean video, background music, thumbnails, and attempt/workflow metadata |
| `production_scenes` | `asset_path`, `audio_path` | Current scene media and narration |
| `production_scene_revisions` | `before_state`, `after_state`, `cost_evidence` | Historical revisions may be needed for audit or restore |
| `generation_checkpoints` | Serialized `artifact` | Resume/recovery artifacts for each generation stage |
| `media_generation_tasks` | `output_path`, serialized `provider_data` | Completed remote-provider output and reconciliation history |
| `shorts_clips` | `output_path`, `captions_path`, serialized `render_metadata` | Approved, rendered, or scheduled Shorts |
| `thumbnails` | `path` | Thumbnail records linked to scripts and productions |
| `experiment_arms` | `thumbnail_path`, serialized result fields | A/B test variants and their historical metrics |
| `production_snapshots` | Serialized `strategy`, `script`, `thumbnail`, `seo` | Saved reconstruction snapshot; thumbnail payload may include a path |
| `content_reviews` | Serialized `editor_data`, `quality_checks` | Review/editor state may retain asset references |
| `reference_videos` | `file_path`, `frame_paths_json`, `analysis_json` | User-provided source media; never auto-delete as ordinary generated output |
| `publish_schedule` | Serialized `metadata` | Publishing metadata may retain output references |
| Other serialized JSON/text | Any nested absolute or data-root-relative path | Future schemas and provider metadata must not silently fall outside the reference scan |

The schema inventory is based on `database/db.js`. The collector must be forward-compatible: scan every string leaf in known serialized JSON fields for exact normalized path matches, not just a fixed list of property names. It must not treat arbitrary URLs, prompts, or basenames as filesystem paths.

## Required deletion safeguards

A production-grade collector must not be enabled until all of these are implemented and tested:

1. **Dry-run first.** The default operation only reports candidate paths, their age, their owning production/job if known, and why no database reference was found. Deletion requires a separate explicit configuration switch.
2. **Age threshold.** Generated candidates must be older than a conservative minimum (at least 24 hours initially). Age is a filter, never proof that a file is orphaned.
3. **Path confinement.** Resolve each candidate against the configured data root, reject paths outside that root, reject traversal, and refuse symlinks/reparse points. Never recursively remove an arbitrary directory.
4. **Reference recheck.** Re-read every path-bearing table and serialized field immediately before unlinking. Normalize paths consistently for Windows and POSIX and compare exact resolved paths.
5. **Active work exclusion.** Skip candidates belonging to a production or generation job with a live operation lease. The job-level lease keys (`generation:<jobId>` and `job:<jobId>`) and production-level lease key are distinct and all matter.
6. **Writer coordination.** A reference scan alone is not enough: a worker could commit a new reference immediately after the scan. Deletion must be coordinated with every writer that can add references, using a shared GC barrier or an exclusive per-owner lease. Until this is proven, only report candidates.
7. **Immutable attempt outputs.** Never delete an artifact from an active/current attempt. Attempt IDs and media task IDs should be retained in the candidate report.
8. **User/source retention.** Never automatically delete user-supplied reference videos or their extracted frames. Do not delete assets used by published content, scheduled content, approved Shorts, experiments, or scene-revision history unless a separate retention policy explicitly permits it.
9. **Recheck after coordination.** After obtaining the required lock/barrier, repeat the full reference scan, then unlink one file at a time. On any uncertainty, preserve the file.
10. **Audit trail.** Record candidate, decision, reason, owner, timestamp, and deletion outcome. Do not store secrets or provider credentials in the audit record.

## Safe rollout sequence

- Phase A: read-only inventory and dry-run candidate report.
- Phase B: add reference-scan tests covering every table above, nested JSON, Windows path normalization, symlink rejection, active leases, and a reference added during the scan.
- Phase C: implement a writer/collector coordination barrier and prove all production, scene-repair, generation, Short-render, thumbnail, and reference-video writers participate.
- Phase D: opt-in deletion of generated temporary artifacts only.
- Phase E: consider broader retention classes separately. User references, published assets, experiment evidence, and revision history remain excluded by default.

## Current behavior and decision

The existing `cleanupStaleRepairTemps(productionId)` only targets narrowly named temporary files and runs after a production-scoped lock is acquired. Production-stage failure handling deliberately preserves all artifacts when a lease is lost or cannot be verified; the stale worker no longer runs broad narration/editing cleanup because it may race with the new owner or recovery. Shorts rendering claims a clip with one conditional database update scoped to `(clip_id, production_id)` and only from `proposed`, `failed`, or `rendered`; when a production lease is present, both the claim and final render/failure persistence verify that lease inside the same SQLite transaction as the write. Each render writes UUID-scoped MP4, temporary MP4, and SRT files, and final persistence is conditional on the same render attempt ID. Strategy, script, SEO, and thumbnail record inserts now verify the generation/job lease inside the same SQLite transaction as the insert. These safeguards reduce stale-writer risk but do not constitute a global garbage-collection barrier. The broader artifact collector described here is not implemented. No final media, audio, image, caption, Short, thumbnail, experiment, or user reference file should be deleted by an unreferenced-file sweep until the writer-coordination barrier exists.
