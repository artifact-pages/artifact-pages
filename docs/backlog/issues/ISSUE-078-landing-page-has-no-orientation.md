# The landing page offers only "Choose a site": no orientation, alphabetical cards, double-counted translations

- Status: In progress
- Assignee: Claude
- Priority: P1
- Area: Site picker and site home (`web/src/components/SitePicker.tsx`, `SiteHome.tsx`, `web/src/domain/site-count-label.ts`)

## Problem

A first-time visitor to the deployment root sees a list of sites and nothing that says what this is or where to start. The sites appear in alphabetical order, so a newcomer is likely to open Architecture (a reference) before Guide (the place to start). The artifact counts add up translations as separate pages, which overstates the size of a site.

## Evidence and reproduction

From the 2026-10-11 dogfooding of `https://artifact-pages.dev`, confirmed in code on this tree.

1. Open `/`. The screen reads "Choose a site / Browse published artifacts from the sites available in this environment." with two rows, Architecture and Guide. Rows are sorted by site title (`SitePicker.tsx:27`); a site's description is shown when the registry provides one (`SitePicker.tsx:109-111`).
2. Open `/guide`. The site home leads with an update feed: "14 published artifacts. Browse the latest work or jump to an artifact by name." (`SiteHome.tsx:76-80`), then Recently updated. The newcomer's first view is what changed last, not a start point.
3. Counts: the guide site lists "14 artifacts" and architecture "12 artifacts", which are 7 English plus 7 Japanese pages and 6 plus 6. The count is `index.artifacts.length` (`SiteHome.tsx:77`) and `entry.artifactCount` (`SitePicker.tsx:147`).

Design point (resolved by the owner decision below): both sites keep translations in top-level `en/` and `ja/` folders, which is only a path convention; the specification and the index have no language notion. The reader therefore reports counts per top-level folder and does not claim the folders are translations.

## Expected outcome

A visitor can tell what the deployment is, which site to open first, and how large each site really is.

## Owner decision (2026-10-11)

Chosen from the Storybook `Concepts/Reader UX 2026-10`/ISSUE-078 stories: variant A. Site cards show the registry description, page counts per top-level folder (for example `en 7 · ja 7`) and a "Start reading" link to the site home. No translation-detection rule is introduced: counts are per top-level folder, without claiming those folders are translations. A per-site start page waits for TD19 or a new config field. No operator intro text (variant B) for now.

## Data and trade-off

- Registry description and the page total are in `sites.json` / `meta.json`; per-folder counts are only derivable from the per-site `index.json`.
- The picker reads the indexes of published sites after the first paint: at most 8 sites, 3 at a time, failures silent (the card keeps the metadata total). Unpublished sites are never requested. This relaxes the "load a site's index only when it becomes active" rule for the landing page only; recorded in the specification (Site home).
- Rule: first path segment = folder, root pages = a separate `(root)` bucket; 2 to 4 groups show chips, more than 4 show "N top-level folders", 1 group or no data shows no chips. The total always comes from `meta.json`.
- Index reads share a 30 s in-memory cache (site view and preview page reuse the picker's read), abort on unmount, and are never cached on failure.
- Follow-up (TD19, Codex-owned indexer): publish per-folder counts in `meta.json`, after which the reader drops the index reads on the landing page.
- The "Start reading" label is part of the card's single link (no nested links); it is not a second link.

## Acceptance criteria

- [x] Site cards show the registry description, page counts per top-level folder (e.g. `en 7 · ja 7`) without claiming the folders are translations, and a "Start reading" link to the site home. Sites without folders or with one group show only the total. (Unit tests in `web/src/domain/site-folder-counts.test.mjs`, e2e "site cards show the description ...".)
- [ ] Deferred to TD19: the landing page marks an explicit start point per site (registry-provided start page); operator intro text is out of scope by the owner decision. The "Start reading" link to the site home is the satisfied part.
- [ ] Deferred to TD19: site cards follow an explicit order when one is provided and fall back to title order otherwise. Today cards are in title order.
- [ ] Deferred to TD19 (start-here entry): a site home leads with orientation (the site description and a start-here entry when the site defines one) before the update feed. The site-home half has no start page to show until TD19 and was not changed.
- [x] Existing site-picker behavior (search, not-published and metadata-unavailable states, `docs/specification.md:155`) is unchanged; the full local-serving e2e suite passes with five index-request assertions updated for the bounded count reads.
- [x] Narrow-screen layout checked at 390 px (Storybook `Navigation/Site picker` Narrow390 stories, Playwright check for no horizontal overflow, screenshot).
- [x] Specification updated for the changed site picker behavior (Site home).

## Remaining

Only the TD19-dependent items (explicit start page, explicit site order, site-home start-here entry) remain. They cannot start before TD19 settles the metadata contract; the item stays In progress until the owner decides whether to split them into a follow-up and mark this one Done.
