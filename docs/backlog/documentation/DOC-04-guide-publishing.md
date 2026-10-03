# DOC-04 — Guide: publishing

- Status: In progress
- Site: `guide`
- Page: `ja/publishing.html`, `en/publishing.html`
- Audience: Teams publishing from their own repositories
- Depends on: DOC-03

## Purpose

Explain how a team publishes its site: choosing a publishable directory, `site publish` with explicit `--site` and `--source`, running it from CI, and PR previews.

## Scope

- What belongs in `sourcePath` (ready-to-serve HTML/Markdown and resources; no build step).
- Dry-run then publish; what is created, updated, and removed; eligibility checks against the registry.
- Running the same command in CI on merge; optional GitHub Actions only once released.
- PR previews at the level a publisher needs.

## Out of scope

- Internals of reconciliation and locking (DOC-10) and preview storage (DOC-11).

## Primary sources

- [Specification §5 Publishable source directory, §6, §9, §12, §19 preview contract, §22](../../specification.md)
- [GitHub Actions](../../guides/github-actions.md), [Local preview development](../../guides/local-preview-development.md)

## Acceptance criteria

- [x] `ja/publishing.html` and `en/publishing.html` exist with matching structure, localized H1 and `<title>`, and a working language switch.
- [x] Every command, flag, path, and behavior matches the linked primary sources and current CLI help.
- [x] Renders correctly in light and dark themes (including inside the reader app) and at ~400px width without horizontal scrolling.
- [x] Published locally with `site publish --dry-run` then `site publish`, and opened in the local reader.
- [ ] The owner reviewed and approved the page.

## Notes

- Actions are optional and not yet released; confirm with the owner how much to show.

## Dependency on the release shape

This page refers to how components are obtained and pinned. Draft it after the release-shape decision recorded in [DOC-03](DOC-03-guide-getting-started.md#blocker-2026-10-01).

## Draft (2026-10-02, awaiting owner review)

Sections: what to publish (file → URL mapping, page vs resource rules, titles, Git dates, symlinks, "every file is readable"), `site publish` (dry-run/publish, four-step flow, options table, output and exit codes), page text search (`--fulltext` on every publish, what is indexed and how to exclude text), when readers see changes (order, 60 s / 300 s cache bounds, reload, retry), CI (dry-run on PRs, publish after merge, scoped credentials, remote config), previews (`preview publish`, selection, `/_previews/` URLs, View previews / Open previews, PR grouping, no forks, retention, trust), and a troubleshooting table. Pager: Reading ← → Configuration.

Sources checked: spec §5 (publishable source directory, publish order, invalidation), §11, §16, §19 preview contract and CLI interface, §22; `artifact-pages site publish --help`, `preview publish --help`; `docs/architecture/fulltext-search.md`; `docs/guides/local-registered-sites.md` (text output, 12-path groups); `cli/internal/publisher/site_publish.go` (symlink rejection for every target, `.git` skipped, repository/sourcePath check).

### Parts that depend on the release decision (DOC-03)

- How to obtain the CLI: the NOTE callout says it will be covered in Getting started (not yet published) and does not link it. Add the link when DOC-03 exists.
- GitHub Actions: the CI section only says an optional Action exists and that pinning depends on the first release; no workflow is shown. Add a pinned workflow example once a release ref exists. (The site Action currently has no `fulltext` input.)
- Everything else (commands, flags, behavior) is release-independent.

Checked with Playwright (`guide-check.mjs`): all five guide pages in ja/en, light/dark, 400 px and 1280 px have no page-level horizontal overflow and no page or console errors; tables, code, and SVG figures scroll inside their frames. All in-site links return 200; anchors used by cross-links exist. In the reader, in-site links and the pager route to logical `/guide/...` URLs, `target="_top"` architecture links replace the app (no nested app), and page text search for `retention` finds the new Configuration and Publishing pages. `npm run docs:check-assets` passes; published with `site publish --site guide --config artifact-pages.yaml --fulltext` (dry-run first).

## Review fixes (2026-10-02, awaiting owner review)

- CI credentials now list everything a publishing job touches: read the site registry; read and write this site's files, previews, lock, and cache-retry record `_control/site-cache/<site>.json` (key verified in `cli/internal/publisher/site_cache.go`; spec §5; T15 scoped-credential note); and request a CDN cache refresh.
- ja: 索引 → インデックス; callout labels localized (NOTE → 注意, CHECK → 確認, alongside 毎回); half-width spaces removed from aria-labels and the mapping header.
- Checked with Playwright (`guidefix/check.mjs`): all five guide pages in ja/en, light/dark, 400 px and 1280 px have no page-level horizontal overflow and no page or console errors; all 50 distinct links return 200, anchors exist, and every root-absolute cross-site link uses `target="_top"` and resolves to a published architecture page. `npm run docs:sync-assets` and `npm run docs:check-assets` pass; published with `site publish --site guide --config artifact-pages.yaml --fulltext` (dry-run first).

## Second review fixes (2026-10-03, awaiting owner review)

- Release wording (owner direction): one sentence says the `artifact-pages` CLI is distributed through GitHub Releases (single link); the GitHub Actions bullet only says an optional Action wraps the command. No install command, pin format, or "not released" caveat. Release details are expected to change; the "Parts that depend on the release decision" above are superseded by this.
- Dates: a file changed or added in the working tree uses its modification time when newer than its commit date; Git-ignored files take the newest modification time among files in the page's directory and its subdirectories (`latestArtifactFileModTime`) and show no committer (checked in `cli/internal/indexer/build.go`).
- Verification (second round): `npm run docs:sync-assets` and `npm run docs:check-assets` pass; CLI rebuilt; `site publish --site guide|architecture --config artifact-pages.yaml --fulltext` dry-run then publish, and a dry-run right after each publish reports `+ 0 create ~ 0 update - 0 remove` (no search-blob churn). Playwright (`r2/check.mjs`, served from `.local/public-site/storage` by a throwaway static server because the local nginx container on :4179 was returning 500 with a Docker I/O error): all 22 pages, ja/en, light/dark, 400/1280 px (88 runs): no page-level overflow, one H1, no heading-level skips, no duplicate ids, no SVG text outside its viewBox, every scrollable figure frame focusable, no console or page errors; all 91 distinct same-origin links return 200, anchors exist, cross-site links use `target="_top"`. The overview's reader-demo title is now a styled `div` instead of an H3 (it caused an H1→H3 skip). Scene-3 animation re-sampled (`r2/anim.mjs`): order checkout→sre→billing, publishes out of sync with ≥1.7 s between starts, no flicker returning from scene 4, staggered entry from scene 2, reduced motion static.
