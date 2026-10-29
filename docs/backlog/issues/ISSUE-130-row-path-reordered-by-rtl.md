# Paths in the Files lists are shown in the wrong order when they start with digits

- Status: Done
- Assignee: Claude
- Priority: P2
- Area: Web / site home, folder page

## Problem

The path under each title in "Recently updated" (Files) is rendered with `direction: rtl` so that a long path is truncated at its start. Because the path is Latin text inside a right-to-left box, the bidi algorithm moves leading neutral and numeric runs: `01-features/01-publish-and-review.html` is displayed as `features/01-publish-and-review.html-01`. Readers see paths that do not exist. The docs site, whose folders are numbered, shows it on every row.

## Evidence and reproduction

1. Open https://artifact-pages.dev/ja?section=files at 1440 px (web 0.4.9).
2. Look at the paths under "Recently updated".
3. Observed: `features/01-publish-and-review.html-01`, `reference/06-versions.html-05`. The DOM text is correct (`01-features/01-publish-and-review.html`).

Cause: `.artifact-row-path { direction: rtl }` (`web/src/styles.css`) without isolating the path text. Found in the ja docs review of 2026-10-29 (workspace `reviews/2026-10-29-ja-site/REVIEW.md`, B1).

## Expected outcome

Every path shown in a list reads exactly as the file path, in its normal order, whatever characters it starts or ends with. When it does not fit, it is shortened at the start with an ellipsis, so the file name stays visible.

## Acceptance criteria

- [x] Paths starting with digits, `-`, `_`, `.` or containing them (e.g. `01-features/01-publish-and-review.html`, `_drafts/x.md`, `.well-known/a.html`) display in their real order in every list that shows a row path (Recently updated, folder page rows, and any other component using the same treatment), in light and dark, at 390 px and 1440 px.
- [x] A path wider than its column is still truncated at the start with an ellipsis and the file name end stays visible.
- [x] Unit or Playwright tests cover a digit-leading path and a truncated long path.

Released in web v0.4.10 (#239) and deployed to production on 2026-10-30 (admin #38).
