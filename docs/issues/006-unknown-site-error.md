# Unknown-site error exposes an internal storage path

- Status: Done
- Priority: P2
- Area: Site loading error state

## Problem

An unknown logical site route shows a generic load failure with the internal index URL. This presents a storage implementation detail as the main error message and does not distinguish an unknown site from a temporary loading failure.

## Evidence and reproduction

1. Navigate directly to `/unknown-site`.
2. The page says “Unable to load this site” and displays `Request failed with status 404: /_indexes/unknown-site/index.json`.
3. An “All sites” recovery action is available.

## Expected outcome

The page explains that the requested site was not found and makes the site list the clear next action. Diagnostic storage paths stay out of the primary user-facing message.

## Acceptance criteria

- [x] A missing site shows a specific, plain-language not-found state with an “All sites” action.
- [x] The primary message does not display `/_indexes/` or another storage path.
- [x] A genuine index-loading failure is distinguishable from an unknown-site response.

## Verification

- `npm run build`
- Playwright: unknown site, invalid site ID, and HTTP 503 index failure cases
- In-app browser: verified the not-found state and “All sites” navigation
