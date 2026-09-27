# IMP-09 — Site-local preview discovery

- Status: Done
- Phase: Phase 1 local preview product
- Depends on: [IMP-01](IMP-01-preview-records.md), [IMP-07](IMP-07-local-serving.md); fixture catalog can precede publication.
- Proves: [T7](../verification/T7-discovery-performance.md), [T8](../verification/T8-stale-reference-cleanup.md)

## Outcome

Add the quiet site-home link, dedicated Previews list and separate in-site palette tab. Read only the active site's catalog when entering preview surfaces. The optional group-list URL resolves through the latest catalog entry, unlike revision-specific document URLs.

## Evidence

The site-home link, dedicated list, lazy site-scoped catalog load, group query filter, missing-manifest hiding, provider-error-as-unknown state, and separate Previews palette tab are covered by Playwright. Added E2E cases cover production Browse/Recently updated/search exclusion, the site-home link, malformed/mismatched manifests, missing and empty states, catalog errors, and list/palette loading recovery. `npm run test:e2e` passed all 55 browser cases on 2026-09-27. T7's 20-site/1,000-group browser characterization and limitations are recorded in [T7](../verification/T7-discovery-performance.md) and its linked report.

## Acceptance criteria

- Previews do not enter production Browse, Recently updated or normal page search. Empty/missing group and missing manifest show appropriate empty states.
- Validate candidate manifests before presenting entries; confirmed missing is hidden, provider read error is not falsely classified as expiry.
- No other site's catalog loads when one site opens Previews. Multi-site/group transfer, parse, memory and input-to-paint are measured under T7 before introducing sharding; the measured local envelope did not justify a projection change.
- List and palette navigate to revision-specific documents; loading/error states do not block the rest of the site.
