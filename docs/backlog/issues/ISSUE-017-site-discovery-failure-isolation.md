# Keep site discovery usable when one site's metadata is unavailable

- Status: Open
- Priority: P1
- Area: Site discovery / registered-site onboarding
- Review: 2026-09-28, finding 04, source revision `50c327d886c71fc5e0d086a5967b90cd9038e01e`
- Related backlog: [IMP-21](../implementation/IMP-21-registered-discovery.md), [T13](../verification/T13-registered-flow.md)

## Problem

Discovery uses an all-or-nothing metadata fetch. A newly registered site has no meta/index until its first publish, so ordinary registration can break the entire root view, including unrelated healthy sites. A malformed or failed metadata response has the same effect.

## Evidence and reproduction

1. Register two sites and publish artifacts for only one; registry publication itself creates no per-site meta/index.
2. Load `/` with the second site's meta returning 404.
3. The root shows 'Unable to load this site' although the healthy site's index returns 200. The review also identified the all-or-nothing Promise.all path for malformed/failing metadata.

Reviewed source: [src/data/indexes.ts:128](../../../src/data/indexes.ts). The review's supplementary local evidence is `.local/reviews/2026-09-28/browser-evidence.json / oneMissingSite`; it is ignored and is not required to understand or reproduce this issue. Preserve the reproduction as a committed regression when implementing the fix.

## Expected outcome

Visitors can discover and open healthy registered sites independently of another site's first-publication or metadata failure.

## Acceptance criteria

- [ ] Multi-site E2E covers a registered-but-unpublished site alongside a healthy published site, before and after the first publish.
- [ ] A single 404, invalid metadata response, or network failure does not discard healthy discovery entries or prevent their navigation/search.
- [ ] The unavailable site's state is understandable without fabricating artifact counts or silently treating it as an unregistered site.
- [ ] Current-site loading failures remain scoped and distinguishable from catalog-loading failures; other indexes stay lazy.
