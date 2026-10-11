# The landing page offers only "Choose a site": no orientation, alphabetical cards, double-counted translations

- Status: Open
- Priority: P1
- Area: Site picker and site home (`web/src/components/SitePicker.tsx`, `SiteHome.tsx`, `web/src/domain/site-count-label.ts`)

## Problem

A first-time visitor to the deployment root sees a list of sites and nothing that says what this is or where to start. The sites appear in alphabetical order, so a newcomer is likely to open Architecture (a reference) before Guide (the place to start). The artifact counts add up translations as separate pages, which overstates the size of a site.

## Evidence and reproduction

From the 2026-10-11 dogfooding of `https://artifact-pages.dev`, confirmed in code on this tree.

1. Open `/`. The screen reads "Choose a site / Browse published artifacts from the sites available in this environment." with two rows, Architecture and Guide. Rows are sorted by site title (`SitePicker.tsx:27`); a site's description is shown when the registry provides one (`SitePicker.tsx:109-111`).
2. Open `/guide`. The site home leads with an update feed: "14 published artifacts. Browse the latest work or jump to an artifact by name." (`SiteHome.tsx:76-80`), then Recently updated. The newcomer's first view is what changed last, not a start point.
3. Counts: the guide site lists "14 artifacts" and architecture "12 artifacts", which are 7 English plus 7 Japanese pages and 6 plus 6. The count is `index.artifacts.length` (`SiteHome.tsx:77`) and `entry.artifactCount` (`SitePicker.tsx:147`).

Design point, hypothesis to check before implementing: both sites keep translations in top-level `en/` and `ja/` folders, which is a path convention. This tree contains no language notion in the specification or the index (a search of `docs/specification.md` and `cli/internal/indexer` found none). Counting "7 pages (en, ja)" therefore needs either a convention the reader detects from parallel folder structure, or explicit metadata (see [TD19](../technical-design/TD19-navigation-metadata-in-the-site-index.md)). Decide and record the detection rule before implementing; a wrong guess would miscount unrelated folders.

## Expected outcome

A visitor can tell what the deployment is, which site to open first, and how large each site really is.

## Owner decision (2026-10-11)

Chosen from the Storybook `Concepts/Reader UX 2026-10`/ISSUE-078 stories: variant A. Site cards show the registry description, page counts per top-level folder (for example `en 7 · ja 7`) and a "Start reading" link to the site home. No translation-detection rule is introduced: counts are per top-level folder, without claiming those folders are translations. A per-site start page waits for TD19 or a new config field. No operator intro text (variant B) for now.

## Acceptance criteria

- [ ] The landing page states what the deployment is (operator-provided text or a short default) and marks a start point. Where the start point comes from (registry config such as a featured or ordered site list, or the site description) is decided in the issue; if it needs registry or config schema changes, split a CLI-side follow-up (Codex-owned).
- [ ] Site cards follow an explicit order when one is provided and fall back to title order otherwise.
- [ ] A site home leads with orientation (the site description and a start-here entry when the site defines one) before the update feed; the update feed remains available.
- [ ] Page counts do not double-count translations for sites whose translations are detected or declared per the recorded rule (for example "7 pages (en, ja)"); sites without translations show plain counts unchanged.
- [ ] Existing site-picker behavior (search, not-published and metadata-unavailable states, `docs/specification.md:155`) is unchanged.
- [ ] Narrow-screen layout checked at 390 px.
- [ ] Specification updated for the changed site picker and site home behavior.
