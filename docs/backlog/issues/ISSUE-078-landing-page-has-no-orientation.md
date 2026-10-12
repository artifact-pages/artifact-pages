# The landing page offers only "Choose a site": no orientation, alphabetical cards, double-counted translations

- Status: Done
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
- [x] The landing page marks a start point per site without authored metadata: the card's "Start reading" link opens the site's root-level README page (the directory-page README rule) when the site index has one, and the site home otherwise. (Owner decision 2026-10-12; unit tests in `web/src/domain/site-start.test.mjs`, e2e "site cards show the description ...".)
- [x] Site cards use a deterministic order without authored metadata: title order, compared by lower-cased code points then exact code points, with the site ID as tie-breaker; recorded in the specification (owner decision 2026-10-12; unit tests in `web/src/domain/site-start.test.mjs`, e2e title-order assertion).
- [ ] Planned web change for ISSUE-078 (proposed by Claude, 2026-10-11, following the README rule of TD19 and directory pages), not yet specified: a site home leads with orientation before the update feed: the site description and, when the site root has a `README.md` or `index.*`, that page as the directory page does. The specification's site-home rule will be amended with the implementation. Not yet changed.
- [x] Existing site-picker behavior (search, not-published and metadata-unavailable states, `docs/specification.md:155`) is unchanged; the full local-serving e2e suite passes with five index-request assertions updated for the bounded count reads.
- [x] Narrow-screen layout checked at 390 px (Storybook `Navigation/Site picker` Narrow390 stories, Playwright check for no horizontal overflow, screenshot).
- [x] Specification updated for the changed site picker behavior (Site home).

## Owner decisions (2026-10-12) and what shipped

- Card order: keep title order (option a), made deterministic. The previous `localeCompare` depended on the browser locale; the order is now `compareSites` in `web/src/domain/site-start.ts` (title by lower-cased code points, then exact, then site ID). The specification says operators control the order through site titles (or IDs as the tie-break).
- "Start reading" destination: the root-level README page when the site top level has one (same detection as directory pages: `README.md`, `index.md`, `index.html`, `index.htm`, without case; a subfolder README does not count), otherwise the site home. It uses only the existing `index.json` read the picker already makes for folder counts (`useSiteFolderCounts` now also returns `startPaths`); no schema change. Until that read finishes, for sites beyond the 8 read, and when the read fails, the card links to the site home. The card stays one link. Story `Navigation/Site picker/StartAtRootReadme` added.
- Still open: the site home leading with orientation (description plus root README) before the update feed.

## Remaining

TD19 is decided and adds no metadata. The start point (the root README, reached through "Start reading") and the deterministic card order were decided by the owner on 2026-10-12 and shipped (see above). The site-home orientation (description plus root README) is done (2026-10-12): the site root is now the root folder's directory page with the site header, the root list and the root README. "Start reading" opens the site root. No language model is added; per-folder counts stay as shipped. The item stays In progress until the shipped changes pass the production check after the next web release.

## Production check (2026-10-12)

web/v0.3.0 deployed to https://artifact-pages.dev (admin App deploy run 38226554352). The landing page lists Architecture then Guide in title order, each card with its description, per-folder chips (`en 7 · ja 7`) and "Start reading". `/guide` is the root directory page with the site header (title, description, "14 pages · updated Oct 11, 2026", View previews, Jump to a page), the root folders and Recently updated. Done.
