# Unknown-site error exposes an internal storage path

- Status: Open
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

- [ ] A missing site shows a specific, plain-language not-found state with an “All sites” action.
- [ ] The primary message does not display `/_indexes/` or another storage path.
- [ ] A genuine index-loading failure is distinguishable from an unknown-site response.
