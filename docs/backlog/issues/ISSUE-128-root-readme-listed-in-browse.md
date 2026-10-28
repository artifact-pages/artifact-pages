# Root README is listed in Browse although Overview renders it

- Status: Done
- Assignee: Claude
- Priority: P3
- Area: Reader sidebar (Browse)

## Problem

A folder's index page has no row of its own in Browse when the folder has other children: the folder row stands for it. The site root was excluded, so the root introduction (`README.md`, else `index.md`) still appears as a file row at the bottom of Browse even though the site's Overview already renders it. The same page is offered twice.

## Evidence and reproduction

1. Open https://artifact-pages.dev/ja (the docs site) at a wide viewport.
2. Look at the last row of the Browse tree in the left sidebar.
3. Observed: a row "Artifact Pages ドキュメント" tagged MD (`README.md`), duplicating the Overview section.

## Expected outcome

At the top level of Browse, the root introduction has no row when the root has other children; Overview stands for it, like a folder row stands for its index page.

## Acceptance criteria

- [x] With folder links on, an empty filter query and other children at the root, the root `README.md` (else `index.md`, case-insensitive; never `index.html`) has no row in Browse. The choice is the one Overview makes.
- [x] A site whose only page is its README keeps that row.
- [x] While the filter has a query, the page is listed like any other page.
- [x] Folder counts, ordering, the Files section, the directory page, the palette and search are unchanged.
- [x] Unit tests cover README hidden, index.md hidden without README, index.html not hidden, README shown while filtering (existing tree logic, query handled in `ArtifactTree`), and the README-only site; an e2e assertion covers the sidebar row.
