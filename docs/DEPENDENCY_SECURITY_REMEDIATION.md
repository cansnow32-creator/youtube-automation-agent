# Dependency security remediation

This branch updates three direct runtime dependencies after the November 2026 npm audit review.

## Runtime requirements

- Node.js `>=20.17.0`. This satisfies sharp 0.35.x and the supported prebuilt-binary range documented by sqlite3 6.x.
- `sqlite3` 6.0.1: the application continues using its existing callback-based Database API. The upstream project is marked deprecated/unmaintained, so this is a security update rather than a long-term maintenance solution.
- `sharp` 0.35.5: thumbnail generation continues using the existing create/resize/composite API. Tests read the version through the public `sharp.versions.sharp` property because the package no longer exports `sharp/package.json`.
- `node-cron` 4.6.0: scheduler tasks are created stopped with `cron.createTask()`, then explicitly started by the existing scheduler initialization loop. This replaces the removed v3 `scheduled: false` option.

## Lockfile and verification

The CI workflow regenerates `package-lock.json` from the declared dependency ranges before `npm ci`, runs lint and the full test suite, and commits the generated lockfile only from a successful branch-push run. No production publishing or PR merge is performed by this workflow.
