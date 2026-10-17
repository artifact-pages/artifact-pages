# Catalog, site-index and Markdown errors offer no retry action

- Status: Done
- Assignee: Claude
- Priority: P2
- Area: Reader / data-load recovery
- Implementer: Claude
- Source: hands-on project review 2026-10-15, N2; monorepo `86841bb1`
- Related: [ISSUE-101](ISSUE-101-registry-and-site-index-loads-have-no-deadline.md), [ISSUE-106](ISSUE-106-known-html-failure-has-no-reader-guidance.md), [T24](../verification/T24-pre-launch-browser-and-keyboard-matrix.md)

## Problem

The reader tells users to try again after a temporary load failure but supplies no action that retries the failed read. Browser reload is a workaround. Returning to `/` through SPA navigation does not remount the application or re-run catalog discovery.

## Evidence and reproduction

1. Serve the built reader with `/_indexes/sites.json` returning HTTP 503 and open `/`.
2. The page shows “The site catalog could not be loaded (HTTP 503). Please try again in a moment.” No retry control is present.
3. Restore a valid registry response. The error remains; reloading the browser recovers. This was reproduced on loopback using the reviewed production build.
4. `App` in `web/src/App.tsx` runs discovery in an effect with an empty dependency list. `ErrorPage` renders the error and an optional All sites action but no retry callback.
5. Site-index errors use that same error component. `MarkdownArtifact` fetches on `artifactUrl` changes and its error branch has no retry action. These two surfaces were checked in source; the HTTP 503 browser sequence above covers the catalog.

Supplementary workspace evidence: `reviews/2026-10-15-project/registry-error.jpg` and `review-server.py`.

## Expected outcome

A reader can recover from a temporary catalog, active-index or Markdown transport failure without discarding the current route through a full browser reload. Permanent data-format errors retain their appropriate publisher/administrator guidance.

## Acceptance criteria

- [x] Catalog, site-index and Markdown transport errors expose an accessible retry action that performs a fresh read.
- [x] A 503/offline failure followed by a healthy response recovers through that action.
- [x] Retrying preserves the logical route and applicable query/fragment; duplicate retry activation does not create competing updates.
- [x] Retry works after a deadline failure and a rejected shared-cache entry.
- [x] Invalid data and unsupported schema states remain distinct from transient transport errors, with republish guidance where appropriate.

## Verification

- e2e in `web/e2e/local-serving.spec.ts`: catalog 503 -> Try again (focus stays on the button after a second failure) -> site list without reload; site index 503 -> Try again -> same route with `?q=` and hash; Markdown 503 -> Try again -> document; registry stall -> timeout message -> Try again recovers. Invalid-data catalog error shows the administrator message and no retry button (existing malformed-registry test updated).
- Unit: registry JSON/validation failures carry `invalidData`.
- `npm run build`, `npm run test:web-unit` and the full e2e (227 tests) pass.
- Not covered by an automated test: duplicate rapid activation (the retry sets state to loading, which unmounts the button, so a second click cannot start a competing read).
