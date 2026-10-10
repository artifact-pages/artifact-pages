# Modified-click new-tab and route.fetch e2e tests fail intermittently under parallel load

- Status: In progress
- Assignee: Claude
- Priority: P2
- Area: e2e tests / new-tab navigation and route mocking (`web/e2e/local-serving.spec.ts`)

## Problem

Three e2e tests fail intermittently when run in parallel, so full runs need reruns and real regressions are easy to dismiss as noise:

- `release UX fixes › sidebar Browse rows, Pinned items and breadcrumb menu entries are links`
- `release UX fixes › navigation rows are real links that keep modified clicks for the browser`
- `reader compatibility rules › unknown fields in every published format are ignored`

There is no product impact; the failures are test-harness races. The fix also covers latent cases of the same patterns: the "result links keep ?q=" new-tab test and the preview raw-resource popup test.

## Evidence and reproduction

Playwright 1.63.0, Chromium, nginx e2e stack, origin/main aef55718. Subset recipe (see Verification) with `--repeat-each=30 --workers=8` unless noted.

### A1. `tab.waitForURL` on a Ctrl-click or middle-click tab (confirmed)

- Sites: `waitForURL` on the tab at the four modifier/middle-click call sites (page text search result link, the `/sre` link with Ctrl and with middle click, the Browse row).
- The `page` event is created before the click, so that is not the bug. For such tabs Playwright sometimes receives the `page` event before it sees the main-frame navigation. The tab has the real app loaded (`readyState` is `complete`, `location.href` is the expected URL, all requests returned 200) but Playwright's `tab.url()` stays `about:blank` and no `framenavigated`, `domcontentloaded` or `load` event is delivered, so `waitForURL` never resolves and the test dies at the 30 s timeout.
- Probe with 8 concurrent contexts: 12-16 of 32-48 timed out; one at a time 0 of 30; three concurrent 2 of 30. `waitForLoadState('load')` then `url()` does not help; reading `location` inside the page does (0 of 48 failures).
- Real tests, baseline: "sidebar Browse rows, Pinned" 0/30 at 1 worker, 3/30 and 7/30 at 8 workers; "navigation rows are real links" 1/30 at 1 worker, 1/30 and 3/30 at 8 workers. The same pattern in "result links keep ?q=" and in the preview popup cases (`toHaveURL` on the popup, `candidate.url()` poll) did not fail in 120 runs and is fixed as a latent case.

### A2. `route.fetch()` response read after the context is closed (likely)

- Site: the `mutateJson` helper, `await response.json()` after `route.fetch()`. One real failure in 200 runs at `--workers=12`: `apiResponse.json: Response has been disposed`.
- The test's last assertions do not wait for the data its handlers fetch, so the test can end while a `route.fetch()` is in flight; fixture teardown then closes the context and disposes the response. A probe of the same flow had a handler in flight at the end of the test in 201 of 240 runs and hit `disposed` in 105 of 240; with `page.unrouteAll({ behavior: 'wait' })` before teardown both were 0 of 240. The same hazard exists for every other `route.fetch()` handler in the file.

### A3. Residual: the context `page` event is sometimes not delivered for a Ctrl-click tab (loss confirmed, cause unconfirmed, not fixed)

After the A1 fix, "navigation rows are real links" still failed intermittently at 8 workers, at an earlier step: `context.waitForEvent('page')` for the first Ctrl-click tab timed out. The trace shows the click completed and a second page with its own network requests (including `GET /sre` and `/_indexes/sre/*`), so the tab opened and loaded, but the context `page` event never reached the test.

A bounded experiment replaced `Promise.all([context.waitForEvent('page'), click])` at all four sites with a helper that snapshots `context.pages()`, clicks, and polls `context.pages()` for a new page (15 s). It failed more often: 2 of 400 in each of two 400-run batches. The traces again show the new page loading `/sre`, yet `context.pages()` never contained it within 15 s. So the event and `pages()` are both sometimes missing for a Ctrl-click tab under 8-worker load, and the experiment was reverted. The loss of the context `page` event is confirmed. Its cause is unconfirmed; it looks like a Playwright/Chromium target-tracking issue (inferred).

Measured residual rate with the shipped fix: "navigation rows are real links" 2 of about 800 runs at 8 workers (0.25%, about 20 times lower than the 5% baseline); "sidebar Browse rows, Pinned" 0 of about 700; "result links keep" 0 of about 700.

### A4. Plain click stalls in actionability (cause unconfirmed)

After the A3 change, "navigation rows are real links" occasionally stalls in a Playwright click until the 30 s test timeout. Rates at 8 workers: 2 in about 1000 runs of this test inside the 4-test subset (the plain click, "waiting for element to be visible, enabled and stable"), 0 in 1600 runs of the test alone. A later 3-batch re-run with traces kept (listener removed before the plain click, `page.mouse.move(0, 0)` added) had 1 more stall in 1200 subset runs of the test (see the results below), this time at the first Ctrl-click.

Reviewer analysis (code reading): the recording listener, stuck mouse buttons, middle-click autoscroll, hover/overlay interference and a re-render of the link are ruled out. The remaining hypothesis is renderer frame starvation under 8-worker load, the same family as A3 (inferred).

Trace of the stall (`run-1`, kept under `.local/e2e-072-traces/`, untracked): the log shows "element is visible, enabled and stable", "scrolling into view", "performing click action", and then nothing for about 29 s until the timeout; the `afterEach` hook then also timed out. Network and console were clean (all requests 200 except the expected 404 for unpublished placeholder sites). The screencast has only 4 frames, the last one before the click, so the renderer produced no frame after the input was dispatched: the input event was never acknowledged, which fits a stalled renderer and not an application error (inferred; no renderer-side evidence).

### A3 resolution

The test `navigation rows are real links that keep modified clicks for the browser` exists to prove that the app does not intercept modified clicks. Whether the browser then opens a tab is browser behavior, and A3 shows that Chromium/Playwright sometimes never reports the tab. The test therefore no longer waits for a tab. Before clicking, it installs bubble-phase `click` and `auxclick` listeners on `window` (they run after the app's React root handler in `spa-link.ts`, which ignores `button !== 0` and any modifier). For events inside the `/sre` link the listener records `defaultPrevented` and then calls `preventDefault()` so no tab opens. The test performs the real Ctrl/Meta click and middle click and asserts that each was delivered (`click` with the modifier, `auxclick` button 1), that `defaultPrevented` was `false`, that the URL stayed `/`, that no document reload happened (`__kept`) and that `context.pages()` did not grow. The plain-click and site-home parts are unchanged.

Real new-tab coverage stays in `sidebar Browse rows, Pinned items and breadcrumb menu entries are links` and `result links keep ?q=`, which still open real tabs and use `expectTabLocation`. They are the only tests exposed to A3 now; "result links keep" lost its tab once in about 1000 runs after this change (earlier measurement: 0 of about 700), and "sidebar Browse rows" lost none.

## Expected outcome

The three tests no longer fail from the two root causes above, and the remaining new-tab event loss is documented with its rate.

## Acceptance criteria

- [x] The root cause of each of the three tests is recorded (A1, A2; A3 for the residual).
- [x] All `waitForURL` calls on modifier-click or middle-click tabs use the in-page location helper `expectTabLocation`; no timeout raised and no retries added. The two latent popup cases use the same wait.
- [x] Route-mock handlers cannot outlive the test: a file-wide `test.afterEach` calls `page.unrouteAll({ behavior: 'wait' })`, and the two tests that create their own page and register `route.fetch` handlers call it before closing the page.
- [ ] Verification with `--workers=8`: `-g "sidebar Browse rows, Pinned|navigation rows are real links|result links keep|unknown fields in every published format" --repeat-each=100` reports 0 failures. Result after the A3 change: the first two 400-run batches had 1 failure and 0; across 10 batches (4000 tests) there were 3 failures: two in "navigation rows are real links" (a plain-click `locator.click` stuck in "waiting for element to be visible, enabled and stable" in the plain-click step (A4), not reproduced in 1600 further runs of that test alone; traces were not retained; see A4 for the later run with a trace) and one A3 tab loss in the untouched "result links keep". Not met strictly: the required pair of batches was not both clean, and a residual flake of about 1 in 1000 remains.
- [x] `-g "reader compatibility" --repeat-each=40 --workers=12`: 400 passed, 0 failed.
- [x] `CI=1 npm run test:e2e` passes 3 consecutive times with 0 failed and 0 flaky. Result after the A3 change: 161 passed, 0 failed, 0 flaky in all three runs (the earlier palette flakes are tracked in ISSUE-073). Deviation: I ran `CI=1 node node_modules/@playwright/test/cli.js test --config web/playwright.config.ts` against my own compose stack on port 4311, not `npm run test:e2e`. `scripts/run-e2e.mjs` runs the same command (same config, inheriting `CI=1`, so `retries: 1` and flaky reporting are identical) after preparing storage and bringing up its own compose project on `E2E_PORT` (default 4174); only the stack and port differ.
- [x] The `PLAYWRIGHT_BASE_URL` subset-run recipe is recorded.
- [x] The residual new-tab-event failure is documented with its measured rate. Documented in A3 and the A3 resolution (target: at most 1 in 400 at 8 workers): the test that lost tabs most often no longer depends on a tab; the two remaining real-tab tests lost 1 in about 2000 runs combined, within the at-most-1-in-400 target.

## Verification

Subset-run recipe (`scripts/run-e2e.mjs` forwards no arguments, so bring the stack up on a free port and call Playwright directly):

```sh
npm run build
node -e "import('./scripts/prepare-e2e-storage.mjs').then(m=>m.prepareE2eStorage())"
STORAGE_ROOT=./.local/e2e/storage COMPOSE_PROJECT_NAME=e2e-stab-072 WEB_PORT=4292 \
  WEB_ROOT=./web/dist PREVIEW_ROOT=./fixtures/storage/_previews \
  docker compose -p e2e-stab-072 up --detach
PLAYWRIGHT_BASE_URL=http://127.0.0.1:4292 \
  node node_modules/@playwright/test/cli.js test --config web/playwright.config.ts \
  -g "navigation rows are real links" --repeat-each=100 --workers=8 --reporter=line
docker compose -p e2e-stab-072 down --remove-orphans
```

Results with the shipped change (all `--workers=8` unless noted):

| Command | Result |
| --- | --- |
| 4-test subset (`sidebar Browse rows, Pinned`, `navigation rows are real links`, `result links keep`, `unknown fields in every published format`), `--repeat-each=100` | 399 passed, 1 failed (A3); repeat: 400 passed |
| the preview raw-resources popup test, `--repeat-each=50` | 50 passed |
| `reader compatibility`, `--repeat-each=40 --workers=12` | 400 passed |
| `navigation rows are real links`, `--repeat-each=150` | 150 passed; repeat: 149 passed, 1 failed (A3) |
| three new-tab tests, `--repeat-each=300` | 900 passed |
| `CI=1 npm run test:e2e` x3 | 156 passed + 1 flaky; 157 passed; 156 passed + 1 flaky |

Results after the A3 change (compose project `claude-issue-072`, `--workers=8`):

| Command | Result |
| --- | --- |
| 4-test subset, `--repeat-each=100`, first two batches | 399 passed, 1 failed (navigation rows, plain click stuck at "stable"); 400 passed |
| the same subset, 8 more batches | 1 batch with 2 failures (1 in "navigation rows", same step; 1 A3 tab loss in "result links keep"); the other 7 batches 400 passed |
| `navigation rows are real links`, `--repeat-each=400` | 400 passed (and 3 further 400-run batches: 1200 passed) |
| full e2e, `CI=1`, run directly against the compose stack (3 runs) | 161 passed, 0 failed, 0 flaky each |
| `tsc -b web/tsconfig.json` (includes `e2e`) | clean |
| after review changes: 4-test subset x100, 3 batches with `--output=.local/e2e-072-traces/run-N` | 399 passed + 1 failed (A4, the first Ctrl-click stalled); 400 passed; 400 passed |

The two flaky tests in the full runs passed on retry and are unrelated to these patterns: `page text search › results group by folder, open from the keyboard, and persist through navigation and history` (expected `.../architecture/platform-topology/index.html?q=latency` but the URL was `.../guides/markdown-style-gallery.md?q=latency` after a palette search plus Enter) and `the collapsed rail searches artifacts and switches sites` (the command palette stayed visible after Enter on `>Use system theme`). Both look like palette-selection races and deserve their own issue.
