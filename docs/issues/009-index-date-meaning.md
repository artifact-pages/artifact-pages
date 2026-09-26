# Index date appears older than artifact update dates

- Status: Done
- Priority: P3
- Area: Publication metadata display

## Problem

The SRE sidebar says “Index updated Sep 22,” while several artifacts are marked “Sep 24.” The dates may refer to different events, but their current labels make the index appear older than the content it lists and can undermine confidence in freshness.

## Evidence and reproduction

1. Open `/sre`.
2. Compare the sidebar footer's “Index updated Sep 22” with the Sep 24 dates on “Mermaid rendering catalog,” “Markdown styles in the reader,” and “Latency Retrospective.”

The observation is about the displayed fixture data and labels; it does not establish a caching or publishing defect.

## Expected outcome

The displayed dates have clear meanings and do not imply an unexplained freshness mismatch.

## Acceptance criteria

- [x] Fixture metadata and artifact dates are internally consistent, or the labels explain why they differ.
- [x] A reader can tell whether the footer date is the index generation time, publication time, or another event.

## Verification

- `npm run build`
- Playwright: discovery metadata matches index metadata and generation timestamps follow artifact updates across all three fixture sites
- Full Playwright suite: 35 tests passed
- In-app browser confirms the SRE footer reads “Index generated Sep 25”
