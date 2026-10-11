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

Chosen from the Storybook `Concepts/Reader UX 2026-10`/ISSUE-078 stories: variant A. Site cards show the registry description, page counts per top-level folder (for example `en 7 · ja 7`) and a "Start reading" link to the site home. No translation-detection rule is introduced: counts are per top-level folder, without claiming those folders are translations. [TD19](../technical-design/TD19-navigation-metadata-in-the-site-index.md) (2026-10-11) settled that no authored start-page metadata is added: the start point is the site's root README (see Remaining). No operator intro text (variant B) for now.

## Data and trade-off

- Registry description and the page total are in `sites.json` / `meta.json`; per-folder counts are only derivable from the per-site `index.json`.
- The picker reads the indexes of published sites after the first paint: at most 8 sites, 3 at a time, failures silent (the card keeps the metadata total). Unpublished sites are never requested. This relaxes the "load a site's index only when it becomes active" rule for the landing page only; recorded in the specification (Site home).
- Rule: first path segment = folder, root pages = a separate `(root)` bucket; 2 to 4 groups show chips, more than 4 show "N top-level folders", 1 group or no data shows no chips. The total always comes from `meta.json`.
- Index reads share a 30 s in-memory cache (site view and preview page reuse the picker's read), abort on unmount, and are never cached on failure.
- Follow-up (separate from TD19, which changes no index schema): publish per-folder counts in `meta.json`, after which the reader drops the index reads on the landing page. Not scheduled.
- The "Start reading" label is part of the card's single link (no nested links); it is not a second link.

## Acceptance criteria

- [x] Site cards show the registry description, page counts per top-level folder (e.g. `en 7 · ja 7`) without claiming the folders are translations, and a "Start reading" link to the site home. Sites without folders or with one group show only the total. (Unit tests in `web/src/domain/site-folder-counts.test.mjs`, e2e "site cards show the description ...".)
- [ ] The landing page marks a start point per site without authored metadata: the card's "Start reading" link opens the site home, which shows the root README when the site has one (the same README rule as directory pages). Operator intro text is out of scope by the owner decision.
- [ ] Site cards use a deterministic order without authored metadata (TD19 adds none): either keep today's title order or switch to site ID order, and record the choice in the specification.
- [ ] A site home leads with orientation before the update feed: the site description and, when the site root has a `README.md` or `index.*`, that page as the directory page does. Not yet changed.
- [x] Existing site-picker behavior (search, not-published and metadata-unavailable states, `docs/specification.md:155`) is unchanged; the full local-serving e2e suite passes with five index-request assertions updated for the bounded count reads.
- [x] Narrow-screen layout checked at 390 px (Storybook `Navigation/Site picker` Narrow390 stories, Playwright check for no horizontal overflow, screenshot).
- [x] Specification updated for the changed site picker behavior (Site home).

## Remaining

TD19 is decided and adds no metadata, so the three items above are web-only and no longer wait on a design: the site-home orientation (description plus root README), the start point (the root README, reached through "Start reading"), and the site card order. No language model is added; per-folder counts stay as shipped. The item stays In progress because these web changes are not built yet.
