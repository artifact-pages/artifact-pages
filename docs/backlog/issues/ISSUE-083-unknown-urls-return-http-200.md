# Unknown URLs return HTTP 200 with the app shell (soft 404)

- Status: Won't fix
- Assignee: Claude
- Priority: P3
- Area: Web part (done): robots meta and nearest-page suggestion in the not-found view. Edge part (HTTP status at the edge): declined, see Decision.

## Problem

A non-existent reader URL such as `/guide/en/nope.html` returns the single-page-app shell with HTTP 200 and shows "Page not found" only after the script runs. Crawlers, link checkers and edge logs see success.

## Evidence and reproduction

From the 2026-10-11 dogfooding of `https://artifact-pages.dev`.

1. `curl -I` on `/nosuch`, `/guide/en` and `/guide/en/nope.html` all return `200 text/html` (the 453-byte shell). `/guide/en/publishing` (no `.html`) also returns 200 and is not redirected. `/_artifacts/guide/en/nope.html` correctly returns 404.
2. This is documented, accepted behavior: `docs/specification.md:151` says the not-found view is "an SPA presentation contract, not an HTTP-status ... mechanism; an edge-served SPA shell may still have HTTP status 200", and missing artifact resources must return a real 404 (`docs/specification.md:369`, `:768`).

Constraint: the reader is a static SPA served with a catch-all fallback to its shell for client-side routes. Returning 404 for an unknown route requires the edge to know which routes exist (site IDs and artifact paths from the registry and indexes), so it cannot be a simple static rule. Directory routes also become valid routes after [ISSUE-075](ISSUE-075-directory-routes-have-no-page.md), which changes which URLs are unknown.

## Expected outcome

Record the constraint and the options; do nothing until it is shown to matter.

## Acceptance criteria

- [x] Decide whether a cheap partial fix is worth it: the client not-found view adds `<meta name="robots" content="noindex">` so indexers do not keep the shell (web only, small), and offers the nearest existing directory or page instead of only "Back to site".
- [x] Decide whether the edge can serve 404 for routes absent from the registry and indexes (Cloudflare Worker or rule in the module; AWS equivalent). Record the cost and the constraint with the static fallback; if declined, mark this issue Won't fix with the reason. Declined by the owner on 2026-10-12; see Decision.
- [ ] (not applicable: declined) If implemented, `curl -I` on an unknown route returns 404 with the shell body, known routes and directory routes still return 200, and the provider-delivery checks cover both.

## Progress

Web part done (Claude): every not-found view (unmatched artifact in a site, unknown or invalid site, unknown preview site) adds `<meta name="robots" content="noindex">` while it is shown (`usePageNoindex`), and an unmatched artifact route lists up to five similar pages ("Similar pages", `nearbyArtifacts`: shared leading folders and shared path or title words, best first, none when nothing is shared). Specification "Site discovery" is updated. Tests: `nearby-pages.test.mjs` (`npm run test:reader-shell`) and Playwright "a missing page is not indexable and suggests similar pages" and the no-suggestion and unknown-site case. Storybook: `Product/Workspace` > "Page not found".

The edge part was not started and is closed: the owner declined it on 2026-10-12 (the second acceptance criterion), so the third does not apply. See Decision.

## Decision (2026-10-12)

The edge part is Won't fix. The existing blanket shell rewrite cannot know which routes exist, so a truthful edge 404 needs route authority synchronized from the registry, the page indexes and the directory indexes. Cloudflare could do it with a Worker plus a per-site route map, which adds a runtime fetch, cache staleness and fail-open contracts. AWS would need CloudFront Functions plus KeyValueStore, which brings new IAM and a write lifecycle, and the 5 MB store and 512-byte key limits apply. Baking the paths into Terraform would break independent per-site publishing. The owner accepted keeping the soft 404, with the web `noindex` and the similar-pages view (done), until real impact is shown.

References:

- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/r2/reference/consistency/
- https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html
- https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-function-restrictions.html
