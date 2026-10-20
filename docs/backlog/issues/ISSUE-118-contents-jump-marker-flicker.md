# The Contents marker flickers along the rail when a far entry is activated

- Status: In progress
- Assignee: Claude
- Priority: P3
- Area: Web / reader context, Contents

## Problem

In the reader's right column, Contents shows the headings on a rail and marks the heading being read (the scroll spy from ISSUE-108/ISSUE-114). When the reader activates an entry far down the list, the document scrolls to it and the marker steps through every intermediate heading on the way, so the dots flicker along the rail instead of reading as one smooth change.

## Evidence and reproduction

1. Open a long document with a persistent Contents column (1200 px or wider) and activate an entry near the end.
2. Owner report, 2026-10-20: the dots of the intermediate entries become current one after another during the scroll.
3. Source: `useCurrentHeading` re-measures on every scroll event and picks the last heading above the reading line, so each position passed during a navigation scroll is marked; `jumpFromColumn` only navigates to the fragment.

Related: ISSUE-108 (the column and scroll spy), ISSUE-114 (the rail and dots).

## Expected outcome

Activating an entry marks it at once and the marker stays on it while the navigation scroll runs. Normal tracking resumes after the scroll settles or as soon as the reader scrolls.

## Acceptance criteria

- [ ] Activating a Contents entry (click or keyboard) marks that entry current immediately, and the marker does not pass through intermediate entries while the resulting navigation scroll runs, in Markdown and in same-origin HTML.
- [ ] Once the scroll has settled, normal tracking resumes. The reader's own scrolling (wheel, touch, keyboard scrolling, scrollbar drag) resumes tracking at once. Tracking never stays stuck: a target that cannot reach the reading line (near the end of the document) keeps the clicked entry current after settling until the reader scrolls, and timers end the held state even when no scroll end event arrives.
- [ ] Ordinary reading scroll, heading navigation targets, focus behaviour, the narrow-layout Contents panel and the HTML (best effort) and Markdown cases keep working; `prefers-reduced-motion` is respected as before.
- [ ] No visual redesign of the rail or dots.
- [ ] Regression coverage proves no intermediate entry becomes current during the navigation scroll and that tracking resumes afterwards and on user scroll.
