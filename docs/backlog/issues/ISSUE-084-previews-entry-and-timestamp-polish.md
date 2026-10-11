# "View previews" is a button, and preview times carry no timezone

- Status: Open
- Priority: P3
- Area: Site home and preview list (`web/src/components/SiteHome.tsx`, `PreviewListPage.tsx`)

## Problem

Two small defects from the previews entry points, folded into one item because both are one-line-scale changes.

1. "View previews" on the site home is a `<button>`, not a link, so it cannot be opened in a new tab, middle-clicked or copied.
2. The preview list shows times such as "Oct 11, 2026, 3:03 PM" without a timezone, so a reviewer in another zone cannot tell when a preview was built.

## Evidence and reproduction

From the 2026-10-11 dogfooding of `https://artifact-pages.dev`, confirmed in code.

1. `SiteHome.tsx:84-89`: `<button className="site-home-preview-link" onClick=...>View previews</button>`. Its target is `/<site>/_previews`. The site picker rows and artifact rows are anchors with in-app navigation (`SitePicker.tsx:101-105`, `ArtifactTree.tsx:261`), so the previews entry is inconsistent with them.
2. `PreviewListPage.tsx:194` formats with `new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' })`; no `timeZoneName`. The browser's local zone is used silently.

Not confirmed, left out: a mismatch between the site list's "updated Oct 9" and the site index's "Index generated Oct 10" was observed on the live site. The site picker uses `meta.json` `generatedAt` and the home uses the index; the cause (registry or site sync lag) was not investigated.

## Expected outcome

The previews entry behaves like other navigation links, and preview times state their timezone.

## Acceptance criteria

- [ ] "View previews" is an anchor with `href` `/<site>/_previews` and in-app navigation on plain click (same pattern as `followInApp`); the disabled and no-previews states keep their current semantics.
- [ ] Preview times include the timezone (for example `timeZoneName: 'short'`), or are exposed through a `<time>` element with a full-precision title; the choice is recorded.
- [ ] Existing preview e2e tests pass; a case opens "View previews" in a new tab.
