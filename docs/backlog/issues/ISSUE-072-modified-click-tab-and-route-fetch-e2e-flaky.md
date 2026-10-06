# Modified-click new-tab and route.fetch e2e tests fail intermittently under parallel load

- Status: In progress
- Priority: P2
- Area: e2e tests / new-tab navigation and route mocking (`web/e2e/local-serving.spec.ts`)

## Problem

Three e2e tests fail intermittently when run in parallel, so full runs need reruns and real regressions are easy to dismiss as noise:

- `release UX fixes › sidebar Browse rows, Pinned items and breadcrumb menu entries are links`
- `release UX fixes › navigation rows are real links that keep modified clicks for the browser`
- `reader compatibility rules › unknown fields in every published format are ignored`

There is no product impact; the failures are test-harness races.

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

### A3. Residual: the new tab is sometimes not delivered to the test at all (confirmed, not fixed)

After the A1 fix, "navigation rows are real links" still failed intermittently at 8 workers, at an earlier step: `context.waitForEvent('page')` for the first Ctrl-click tab timed out. The trace shows the click completed and a second page with its own network requests (including `GET /sre` and `/_indexes/sre/*`), so the tab opened and loaded, but the context `page` event never reached the test.

A bounded experiment replaced `Promise.all([context.waitForEvent('page'), click])` at all four sites with a helper that snapshots `context.pages()`, clicks, and polls `context.pages()` for a new page (15 s). It failed more often: 2 of 400 in each of two 400-run batches. The traces again show the new page loading `/sre`, yet `context.pages()` never contained it within 15 s. So the event and `pages()` are both sometimes missing for a Ctrl-click tab under 8-worker load, and the experiment was reverted. Cause is inside Playwright/Chromium target tracking and is not understood.

Measured residual rate with the shipped fix: "navigation rows are real links" 2 of about 800 runs at 8 workers (0.25%, about 20 times lower than the 5% baseline); "sidebar Browse rows, Pinned" 0 of about 700; "result links keep" 0 of about 700.

## Expected outcome

The three tests no longer fail from the two root causes above, and the remaining new-tab event loss is documented with its rate.

## Acceptance criteria

- [x] The root cause of each of the three tests is recorded (A1, A2; A3 for the residual).
- [x] All `waitForURL` calls on modifier-click or middle-click tabs use the in-page location helper `expectTabLocation`; no timeout raised and no retries added. The two latent popup cases use the same wait.
- [x] Route-mock handlers cannot outlive the test: a file-wide `test.afterEach` calls `page.unrouteAll({ behavior: 'wait' })`, and the two tests that create their own page and register `route.fetch` handlers call it before closing the page.
- [ ] Verification with `--workers=8`: `-g "sidebar Browse rows, Pinned|navigation rows are real links|result links keep|unknown fields in every published format" --repeat-each=100` reports 0 failures. Result: 1 failure in the first 400-run batch and 0 in the second (the A3 residual). Not reliably met.
- [x] `-g "reader compatibility" --repeat-each=40 --workers=12`: 400 passed, 0 failed.
- [ ] `CI=1 npm run test:e2e` passes 3 consecutive times with 0 failed and 0 flaky. Result: 0 failed in all three runs, but run 1 and run 3 each had one flaky test in code this issue does not touch (see Verification).
- [x] The `PLAYWRIGHT_BASE_URL` subset-run recipe is recorded.
- [ ] The residual new-tab-event failure is documented with its measured rate (at most 1 in 400 at 8 workers). Documented in A3, but the measured rate is about 1 in 400 for the shipped fix and 1 in 200 for the reverted experiment; the owner should decide whether that meets the criterion.

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

The two flaky tests in the full runs passed on retry and are unrelated to these patterns: `page text search › results group by folder, open from the keyboard, and persist through navigation and history` (expected `.../architecture/platform-topology/index.html?q=latency` but the URL was `.../guides/markdown-style-gallery.md?q=latency` after a palette search plus Enter) and `the collapsed rail searches artifacts and switches sites` (the command palette stayed visible after Enter on `>Use system theme`). Both look like palette-selection races and deserve their own issue.
