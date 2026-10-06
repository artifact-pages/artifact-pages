# Pressing Enter right after typing in the command palette can do nothing or open the wrong page

- Status: Done
- Priority: P2
- Area: Command palette selection (`web/src/components/CommandPalette.tsx`)

## Problem

Regression from PR #34 (ISSUE-048), with two manifestations that both make Enter act on a row other than the typed match.

1. Stale selection. `selectedIndex` was reset in a `useEffect` after the render for a new query or new entries, so for one render the new `entries` were paired with the old `selectedIndex`, and `handleKeyDown` read that pair on Enter. Before #34 the default was almost always 0, so the stale value happened to be correct. Since #34, `defaultSelectionIndex` can return -1 or a value above 0 in the blank state (the open page is skipped), so a fast type-then-Enter does nothing (`entries[-1]`) or opens the wrong row.
2. Hover. `onMouseEnter` selected a row. With the pointer resting where palette rows render, Chromium fires `mouseenter` on the row that appears under it, so the selection moved to the hovered row and Enter opened it instead of the typed match.

## Evidence and reproduction

Observed as intermittent e2e failures in `web/e2e/local-serving.spec.ts` under parallel load:

- T1 "results group by folder, open from the keyboard, and persist through navigation and history": Enter right after `fill('Platform topology')` opened a different page.
- T2 "the collapsed rail searches artifacts and switches sites": the palette stayed open after `fill('>Use system theme')` plus Enter.

Both tests run together, workers 8 and 12:

| Commit | Runs | Failures |
| --- | --- | --- |
| aef55718 (#34, unfixed) | 1,100 | 7 (T1 and T2) |
| 623c7487 (before #34) | 500 | 0 |
| stale-selection fix | 500 | 0 |

One T1 failure was captured with instrumentation in the Enter handler: `query="Platform topology"`, `selectedIndex=-1`, `defaultIndex=0`, `entries.length=2` (the platform-topology artifact plus page-text), hover=false. Enter ran with the blank-state selection from before the reset effect.

Confidence: the stale-selection cause is likely (captured once). That it is a #34 regression is likely (0/500 before #34 against 7/1,100 after). The window is real but rare.

Hover: a probe on unfixed code that rested the pointer with `page.mouse.move(640, 280)`, then opened the palette, filled and pressed Enter failed 37 of 50 runs, with Enter acting on the current-page row.

## Expected outcome

Enter always acts on the selection that belongs to the query and entries on screen. On open the selection is the default; a typed query selects the default for that query; the `@` and blank rules from ISSUE-048 are unchanged. Selection follows only real pointer movement.

## Fix

- The selection is derived during render. A stored `{ key, index }` is resolved by `resolveSelectedIndex` (`web/src/domain/palette-sections.ts`) against a key made of context, site, query and, where the list drives the default, the entry sequence; another key or an index past the list falls back to the current default. Both reset effects are removed.
- Rows select on `onMouseMove` (only when the row is not already selected) instead of `onMouseEnter`. Click behavior is unchanged.

## Test coverage and its limits

- Unit tests in `scripts/palette-sections.test.mjs` cover `resolveSelectedIndex`.
- "typing then pressing Enter at once opens the first match even when the blank default is not the first row" passed on unfixed code (0 of 50 at workers 8, 0 of 200 at workers 12). It is behavior coverage only and does not prove the race; T1 and T2 stay as the natural regression coverage and have no added waits.
- "a resting pointer under the palette does not steal the typed match" rests the pointer on the second blank-palette row, then types a query with two matches and presses Enter. With `onMouseEnter` restored (stale-selection fix kept) it failed 3 of 50 and 3 of 100 runs at workers 8. With `onMouseMove` it passed 100 of 100. It catches the bug only sometimes (about 4%); it is not a reliable guard on its own.

## Acceptance criteria

- [x] The selection is derived during render and no reset effects remain.
- [x] Rows select on pointer movement, not on enter.
- [x] Unit tests cover a stored selection from another key, beyond the entries, and within the entries (`npm run test:palette-sections`: 12 passed).
- [x] e2e coverage added for type-then-Enter and for a resting pointer.
- [x] `npx tsc -b web/tsconfig.json` and `npm run build` pass.
- [x] With `--workers=12` and `--repeat-each=150`, T1, T2, the type-then-Enter test and the resting-pointer test: 600 passed, 0 failed.
- [x] Full suite `CI=1 npm run test:e2e`: 159 passed, 0 failed, no flaky test reported.
