# A site without previews makes every page load log a failed request

- Status: In progress
- Assignee: Codex
- Priority: P3
- Area: Web / previews, publisher

## Problem

When a site has never had a preview, `/_previews/<site>/catalog.json` does not exist. The reader requests it on site pages (for the Previews count) and treats 404 as "no previews", which is correct, but the browser logs "Failed to load resource: 404" in the console on every load. Operators checking the console, and monitoring that counts 4xx, see an error that is not one. Found in the ja docs review of 2026-10-29 (B2): every page of https://artifact-pages.dev/ja logs it.

## Expected outcome

A site with no previews loads without a failed request, or the 404 is explicitly accepted as the contract and documented for operators.

## Decision

Backend designer (Terra xhigh, 2026-10-29): option (a). The 404 for a missing catalog stays the contract and is documented. An empty catalog per site (b) would be expired by the `_previews/` lifecycle and risks overwriting a catalog that still holds revision ownership history; advertising preview presence in `meta.json`/`sites.json` (c) cannot remove the request for existing data and adds an ownership/ordering problem between writers; synthesising an empty response at the edge (d) hides real failures. A 404 does not prove that a site never had previews (retention expiry or a delivery problem look the same), so monitoring must not ignore it blindly where previews are expected.

## Acceptance criteria

- [x] The product specification records that a missing preview catalog may return HTTP 404 and that the preview list treats it as empty; this does not assert that the site has never had previews.
- [x] Operator documentation explains the expected browser console and 4xx-monitoring effects, distinguishes this response from an unexpected missing catalog when previews are expected, and does not recommend suppressing all preview errors.
- [ ] Regression coverage verifies that a missing catalog produces the empty preview list and count, while a non-404 catalog failure remains an error and a populated catalog retains its existing list and count behavior.
- [ ] A direct revision URL remains readable when its catalog is missing, with the existing unavailable-details state.
- [x] No published format or schema version, publisher behavior, cache policy, lifecycle policy, or existing-data migration is required by this decision.

## Verification

The specification and recovery guide record the decision; the change requires no product, format, publisher, cache, lifecycle, or migration changes. `LANG=en_US.UTF-8 npm run test:web-unit` and `npm run build` passed. Playwright coverage includes the missing-catalog count assertion and existing error, populated-catalog and direct-revision cases, but remains unverified: the sandbox denied access to the Docker daemon, so the isolated Compose stack could not be started safely.
