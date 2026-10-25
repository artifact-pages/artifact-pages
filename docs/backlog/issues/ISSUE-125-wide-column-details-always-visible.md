# Wide reader column hides Details behind a floating overlay

- Status: Done
- Assignee: Claude
- Priority: P2
- Area: Web / reader context column

## Problem

Since #218 (IMP-86), at 1200 px and wider the reader column shows only the update date (preview: Built) and a Details button, and Details opens as a floating overlay over the column. A floating panel next to a persistent column hides Contents and reads as out of place. The owner preferred the earlier always-visible Details that scrolls away on Markdown (2026-10-25), after comparing an inline-expanding concept. This withdraws, for wide screens only, the 2026-10-24 UI/UX review agreement to move author/source details behind Details.

## Evidence and reproduction

1. Production web v0.4.7, open a preview document at 1440 px wide.
2. Choose Details in the column.
3. Observed: Details opens over the column (owner screenshots, 2026-10-25).

## Expected outcome

The wide column shows Details on top and Contents below, with no Details button or overlay. Below 1200 px the behavior of #218 stays.

## Acceptance criteria

- [x] At 1200 px and wider the column shows Details (published: byline/avatar, Updated, source link; preview: PR, Revision, Built, links, More details, Path/Format) on top and Contents below, with no Details button or overlay.
- [x] On a Markdown page Details scrolls away with the document and Contents stays; beside an HTML frame the column scrolls on its own.
- [x] Narrow behavior of #218 is unchanged (Contents modal dialog, Details overlay and its focus rules).
- [x] Widening past 1200 px closes an open overlay and moves focus to the matching column part, as in the specification.
- [x] At wide widths the Details and Contents commands focus the column part.
- [x] `docs/specification.md` is updated and the e2e suite is green.

## Verification

`npx tsc -b web/tsconfig.json`, `npm run build`, `npm run build-storybook` and `npm run test:web-unit` (the only failure is the pre-existing `site-folder-counts` case, which also fails on origin/main) ran on the branch. The full e2e suite (`CI=1`, project `claude-issue-125`) passed 359 of 359.
