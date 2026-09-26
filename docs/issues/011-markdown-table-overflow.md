# Wide Markdown tables need an overflow cue

- Status: Open
- Priority: P3
- Area: Markdown reader on narrow screens

## Problem

The Markdown reader keeps wide tables within the document area on mobile, but columns extend past the visible edge. The screenshot gives little indication that the table can be scrolled sideways, so readers may assume the remaining columns are missing.

## Evidence and reproduction

1. Set the viewport to approximately 390 px wide and open `/sre/reports/latency-retrospective.md`.
2. In “Outcome at a glance,” the “Recovered” column is outside the initial visible area. The “Timeline” table is also wider than the visible document width.

The review confirmed clipped initial presentation; it did not measure touch scrolling on a physical device.

## Expected outcome

Readers can discover that more columns are available and reach them without moving the entire workspace sideways.

## Acceptance criteria

- [ ] A wide table provides a visible overflow cue at narrow widths.
- [ ] Horizontal scrolling reveals every column while the workspace width remains stable.
- [ ] The cue recedes or disappears when all columns fit.
