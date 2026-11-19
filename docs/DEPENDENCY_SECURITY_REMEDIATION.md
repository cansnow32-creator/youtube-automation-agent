# Dependency security remediation

This branch updates the runtime dependency baseline and removes an unused Google OAuth helper after the November 2026 npm audit review.

## Runtime requirements

- Node.js `>=20.17.0`. This satisfies sharp 0.35.x and the supported prebuilt-binary range documented by sqlite3 6.x.
- `sqlite3` 6.0.1: the application continues using its existing callback-based Database API. The upstream project is marked deprecated/unmaintained, so this is a security update rather than a long-term maintenance solution.
- `sharp` 0.35.5: thumbnail generation continues using the existing create/resize/composite API. Tests read the version through the public `sharp.versions.sharp` property because the package no longer exports `sharp/package.json`.
- `node-cron` 4.6.0: scheduler tasks are created stopped with `cron.createTask()`, then explicitly started by the existing scheduler initialization loop. This replaces the removed v3 `scheduled: false` option.
- `googleapis` 190.0.0: updates the YouTube/OAuth client to the current release line. The application uses the stable YouTube Data API v3 surface and Google OAuth2 client.
- `@google-cloud/local-auth` was removed because repository code uses the OAuth2 flow implemented by `googleapis`; no import or runtime use of the helper was found.

## CineCode render integrity

- Source assets are decoded with Sharp before FFmpeg rendering; extension-only or corrupt image files are rejected.
- Hybrid assembly writes to temporary files, verifies that the final MP4 has a readable positive duration, and runs an FFmpeg decode pass before promoting it to the final output path.
- Temporary visual and finalizing files are removed on both success and failure. CineCode errors remain explicit and do not fall back to slideshow rendering.

## Shorts render integrity

- The Shorts renderer writes to a temporary MP4 and promotes it to the final output only after a successful FFmpeg decode pass.
- Rendered output is probed for duration and dimensions. Duration must remain within a bounded tolerance of the requested excerpt, and the frame must be portrait 9:16 before the draft can be marked rendered.
- Render metadata (duration, width, height, and audio presence) is retained with the Short record. Failed renders remove temporary output and remain blocked from approval.
- FFprobe is preferred; when it is unavailable, FFmpeg's own input metadata is parsed as a local fallback.

## Lockfile and verification

The CI workflow regenerates `package-lock.json` from the declared dependency ranges before `npm ci`, runs lint and the full test suite, and commits the generated lockfile only from a successful branch-push run. No production publishing or PR merge is performed by this workflow.
