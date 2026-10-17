# The SPA shell has generic metadata for search and share cards

- Status: In progress
- Priority: P3
- Area: App shell
- Implementer: Claude
- Assignee: Claude
- Source: public-launch review 2026-10-13, section 6 (last paragraph)

## Problem

`web/index.html` carries a generic title and no description, Open Graph tags or canonical link, and the repository has no sitemap. Route titles update only after JavaScript runs. This matters only if search traffic and share cards are a launch goal; it is not required for internal readers. The soft 404 with noindex ([ISSUE-083](ISSUE-083-unknown-urls-return-http-200.md)) stays as accepted.

## Evidence and reproduction

1. `web/index.html` has a generic `<title>` and no description, Open Graph or canonical tags (checked at `04783fb3`).
2. Per-route titles are set by the client after load.

## Expected outcome

The app home has a meaningful title, description and share card. Whether per-route metadata or a sitemap is wanted is an owner decision that stays open in this issue.

## Acceptance criteria

- [x] The shell has a descriptive title, description and Open Graph tags for the app home.
- [ ] This issue records the owner's decision on per-route metadata and a sitemap (wanted or not, with the reason).

## Verification

- `web/index.html` keeps its `<title>` and now has a `description` meta, Open Graph tags (`og:type`, `og:site_name`, `og:title`, `og:description`) and `twitter:card` `summary` for the app home.
- No canonical link, `og:url` or `og:image`: the same bundle is deployed to hosts chosen by each operator, so an absolute URL cannot be known at build time.
- `npm run test:web-packaging` passes. No test asserts the content of the built `index.html` (the packaging test uses a fake one), so none was added.

## Owner decision

Pending: per-route metadata and sitemap. Recommendation recorded 2026-10-17: not wanted (internal readers; soft-404 policy ISSUE-083).
