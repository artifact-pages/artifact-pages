# Site cards present unchanged metadata-generation time as content freshness

- Status: Open
- Priority: P2
- Area: Site discovery / publisher metadata and reader labels
- Implementer: Codex + Claude
- Source: hands-on project review 2026-10-15, N5; production CLI 0.4.2 / web 0.3.2 and monorepo `86841bb1`
- Related: [ISSUE-084](ISSUE-084-previews-entry-and-timestamp-polish.md), [ISSUE-095](ISSUE-095-home-folder-counts-load-full-indexes.md)

## Problem

A site's card says “updated” using the metadata object's generation time. If content changes without changing the page count or other metadata fields, that timestamp is preserved, so the card's apparent content freshness stays old. The site home reads newer index/content data and shows a different update date.

This concerns the meaning of the reader-facing “updated” label. Independent projection timestamps may legitimately differ; this issue does not require every object's generation time to be identical or reopen ISSUE-084's completed preview/timestamp work.

## Evidence and reproduction

1. Publish a local registered site containing one Markdown page with a stable H1. Read its metadata and artifact-index `generatedAt` values.
2. In a later clock second, change only its body, commit the change and run `site sync` again. Keep the title, page count and registry mapping unchanged.
3. Observed before: meta and index both `2026-10-15T11:38:03Z`. After: meta still `11:38:03Z`, index `11:39:39Z`.
4. Production Guide also showed “updated Oct 9” on the site card versus Oct 11 inside the site. HTTP reads found meta generation `2026-10-09T08:59:50Z`, index generation `2026-10-11T06:19:16Z`, latest artifact update `2026-10-11T06:18:49Z`.
5. `preserveGeneratedAt` in `cli/internal/publisher/site_publish_manifest.go` reuses each object's bytes when `sameGeneratedProjection` finds equality after removing `generatedAt`. Metadata has no body-generation signal. `catalogStatusLabel` in `web/src/components/SitePicker.tsx` displays that value as “updated”.

Supplementary workspace evidence: `reviews/2026-10-15-project/metadata-freshness.json`, `freshness-sync.log` and `production-dates.json`.

## Expected outcome

Site-card freshness labels truthfully describe the data they represent. A metadata-only generation time is not presented as the last content update. The choice of correcting the label or projecting content freshness is left to the implementation brief.

## Acceptance criteria

- [ ] The same-page-count body-change sequence no longer leaves a misleading content-update label on the card.
- [ ] A no-op publish does not manufacture a new content update.
- [ ] Metadata-generation, content-update and index-generation concepts are not silently conflated in the chosen display.
- [ ] The solution does not add full-index fetching for unvisited sites solely to obtain the displayed date.
- [ ] A regression covers a body-only change as well as unchanged publication; preserve existing projection no-op behavior where appropriate.
