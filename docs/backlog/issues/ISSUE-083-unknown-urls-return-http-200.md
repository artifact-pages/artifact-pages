# Unknown URLs return HTTP 200 with the app shell (soft 404)

- Status: Open
- Priority: P3
- Area: Split. Web part (Claude-owned): robots meta and nearest-page suggestion in the not-found view. Edge part (Codex-owned: Terraform modules, CLI-produced registry data): HTTP status; announce in `STATUS.md` before starting.

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

- [ ] Decide whether a cheap partial fix is worth it: the client not-found view adds `<meta name="robots" content="noindex">` so indexers do not keep the shell (web only, small), and offers the nearest existing directory or page instead of only "Back to site".
- [ ] Decide whether the edge can serve 404 for routes absent from the registry and indexes (Cloudflare Worker or rule in the module; AWS equivalent). Record the cost and the constraint with the static fallback; if declined, mark this issue Won't fix with the reason.
- [ ] If implemented, `curl -I` on an unknown route returns 404 with the shell body, known routes and directory routes still return 200, and the provider-delivery checks cover both.
