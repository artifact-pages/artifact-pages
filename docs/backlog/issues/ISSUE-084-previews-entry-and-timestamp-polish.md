# "View previews" is a button, and preview times carry no timezone

- Status: Done
- Assignee: Claude
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

- [x] "View previews" is an anchor with `href` `/<site>/_previews` and in-app navigation on plain click (same pattern as `followInApp`); the disabled and no-previews states keep their current semantics.
- [x] Preview times include the timezone (for example `timeZoneName: 'short'`), or are exposed through a `<time>` element with a full-precision title; the choice is recorded.
- [x] Existing preview e2e tests pass; a case opens "View previews" in a new tab.

## Resolution

- "View previews" is now `<a href="/<site>/_previews">` with `followInApp` for a plain click, so a new tab, middle-click and copy link address work. With no previews the anchor has no `href` and keeps `role="link"`, `aria-disabled="true"`, focusability and its description.
- Times: both. `PreviewListPage` renders `<time datetime>` whose text includes the short zone name (`timeZoneName: 'short'`, for example "Oct 11, 2026, 3:03 PM GMT+9") and whose `title` is the full-precision UTC instant (`2026-10-11 15:03:09 UTC`). Logic lives in `web/src/domain/preview-time.ts` with `preview-time.test.mjs`.
- Tests: existing preview e2e updated to the link role; the site-home preview case now also opens "View previews" in a new tab and checks the `<time>` attributes.
- Registry/index date mismatch (still not confirmed): the site picker and the site home format their dates with the same function in the same way (`SitePicker.tsx`, `Sidebar.tsx`), so the web does not create the difference. It comes from different data: the picker reads `meta.json` `generatedAt`, the home reads `index.json` `generatedAt`. The publisher's `preserveGeneratedAt` (`cli/internal/publisher/site_publish_manifest.go`) keeps each object's timestamp when only that object's projection is unchanged, so the two can legitimately differ after a publish that changed one of them. Nothing was changed; if it matters, it is a CLI (Codex) question.
