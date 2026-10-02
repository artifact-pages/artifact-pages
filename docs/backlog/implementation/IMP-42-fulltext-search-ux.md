# IMP-42 — Committed-query full-text search UX integration

- Status: In progress
- Priority: P2
- Phase: Phase 1 local product
- Execution: Agent-led exploration and implementation after owner requests continuation.
- Depends on: [IMP-41](IMP-41-fulltext-search-core.md) (Done).
- Contract/API: [Static full-text search core](../../architecture/fulltext-search.md).
- Deferred by owner: 2026-10-01; detailed palette UX was explicitly postponed while the core was built.
- Resumed by owner: 2026-10-02. The interaction below was agreed through HTML storyboards and is implemented in production code for Storybook review.

## Goal

Let a reader search the active site's static title/body after committing a query. The owner intends to fetch search data only after query confirmation, rather than treating full-text search as ordinary character-by-character palette filtering. The core engine/build/publish/API is complete; the interaction surface has not been selected.

## Start here

Read IMP-41's implementation map, tested constraints and shared-workspace caution, then inspect `CommandPalette.tsx`, current site metadata/state and the actual diff. The existing localhost:4188 research form is a proof of search performance, not an approved production UX.

Explore how the committed-query flow coexists with the current palette's metadata search, site switching and keyboard shortcuts. Show concrete interface choices for review before settling detailed behavior. Do not assume a new ordinary palette or a particular result-list layout has already been approved.

Once the interaction is agreed, create a site client using `createSiteFullTextSearch(siteMetadata)`, invoke `search(query, { signal, offset, limit })` on commit, and render the returned IDs/paths/routes. Search construction is network-free; empty inputs do not fetch. The current site index can supply titles and reader metadata. Clear/drop the client when leaving a site. Guard against an older response replacing a newer submission (submission ID or cancellation).

## Agreed interaction (2026-10-02)

Finding pages and searching their text are separate surfaces, each with one behavior:

- **Find by name — ⌘ K palette.** Typing searches titles and paths immediately, as before. The All / Recent / Pinned / Previews tabs are removed. A blank palette lists Pinned, then the reader's Recently read pages, then commands; it falls back to the ranked page list when both are empty. Pins and reads still boost ranking. When the site supports page text search and the query is not blank, a "Search page text for …" row follows the page matches (it is the default selection when no page name matches) and ⌘ ↵ hands the query over at any time. Previews moved to the site-home link and an "Open previews" command.
- **Search text — sidebar bar (⌘ ⇧ F).** The sidebar's live "Filter navigation" field is replaced by a committed-query field: typing does nothing, Enter (not an IME confirmation) searches, Esc or × clears. The committed query lives in the URL as `?q=` and persists while moving within the site. Results replace Pinned and Browse, grouped by folder in path order, 20 per page, with "n / total" for the open page. Editing the query after a search dims the previous results until Enter. ↓ from the field enters the results; ↑/↓/Home/End move, Enter opens and keeps focus in the list, ←/→ collapse folders. Errors distinguish network from invalid data and offer a retry; zero results explain the AND rule for multi-word queries. With the sidebar collapsed, a context-bar chip shows the query and position and reopens the sidebar.
- **Highlight.** The committed terms are highlighted in the open HTML (same-origin iframe) or Markdown page with the CSS Custom Highlight API, without mutating the artifact DOM, and the first match is scrolled into view unless the URL has a fragment. Matching mirrors the core (NFKC, lowercase, substring per term) within single text nodes.
- **Sites without page text search.** The sidebar shows a "Jump to a page… ⌘ K" button in place of the field, the palette shows no hand-off row, and ⌘ ⇧ F shows a short notice.
- **Removed elsewhere.** The sidebar's Recently updated section (it stays on the site home) and the site home's inline filter and "Full search" button; the site home has a "Jump to a page… ⌘ K" button. The site picker shows a "Page text search" badge per enabled site and hides its search trigger below nine sites.

Implementation: `components/PageTextSearch.tsx`, `components/usePageTextSearch.ts`, `domain/text-highlight.ts`, and changes to `Sidebar`, `CommandPalette`, `ArtifactWorkspace`, `MarkdownArtifact`, `SiteHome`, `SitePicker` and `App` (client creation from `meta.json.fullTextUrl`, cleared on leaving the site). Storybook: `Product/Page text search` uses `stories/fake-fulltext.ts`, which searches fixture pages in the browser instead of a generated projection.

## Integration verification (2026-10-02)

Specification: `docs/specification.md` §8 (site home, site picker, Search, Left sidebar), §14 testing flows and §19 preview entry now describe the agreed behavior; the optional/site-scoped/commit-only statements and the core contract link are kept.

E2E search data: `scripts/prepare-e2e-storage.mjs` (called by `scripts/run-e2e.mjs` unless `STORAGE_ROOT` is set) copies `fixtures/storage` to `.local/e2e/storage` and builds one extra site, `textsearch`, with `go run ./cli/cmd/artifact-pages index build --fulltext`. Its sources (`.local/e2e/sources/textsearch`) are the SRE fixture pages (HTML + Markdown) plus 24 generated `bulk/note-NN.md` pages that contain "lighthouse" (for paging); the same bytes are copied to `_artifacts/textsearch`. Committed fixtures are unchanged and the copied `sites.json` does not list `textsearch`, so every committed site keeps metadata-only behavior (SRE covers the unavailable path). Search tests register the site by routing `sites.json` (an existing suite pattern); metadata, index, search objects and artifacts are real nginx responses. Requires Go and Docker.

Existing e2e updates: removed-UI selectors were rewritten to the new surfaces (palette triggers renamed "Jump to a page in …"; site-picker trigger tests register 9+ sites or use Ctrl K; blank-palette Recently read/Pinned sections replace the scope-tab tests; previews via the site-home link and "Open previews" command; site home "Jump to a page…" button replaces the inline filter/Full search tests; sidebar Recently updated is asserted absent). Deleted because their intent no longer exists: sidebar name-filter empty-state recovery, sidebar name-filter path highlight, the three site-home inline filter tests (replaced by one palette jump test that keeps the IME-Enter check), and the palette Previews-tab loading/empty/error test (preview list loading/error is covered by existing list tests).

New `page text search` e2e (10 tests): site-picker badge; no search requests while focusing/typing or on IME Enter (`isComposing` and `keyCode` 229), manifest first after Enter, dimmed stale results without requests; folder grouping in path order, ↓/↑/Home/End/Enter keeps focus in the list, "n / total", `?q=` kept through palette navigation, Esc/× clear restores Browse, back/forward restore; superseded query (older leaf responses held via `page.route`, released after the newer results render; a mutation that removed the abort guard made this test fail); paging 20 + "Show 4 more"; zero results with the AND explanation; HTTP 503 vs invalid manifest with Try again; `CSS.highlights.get('gap-page-text-search')` in the HTML iframe window and the Markdown page with no `<mark>` in the DOM, cleared on Esc and replaced on a new query; palette hand-off row (not default with a page match, default without) and Ctrl ↵; Ctrl/⌘ ⇧ F from the Markdown reader, from inside the HTML frame and with the sidebar collapsed, plus the collapsed-sidebar chip; SRE shows the Jump button, ignores `?q=`, offers no hand-off and shows the ⌘ ⇧ F notice.

UI fix found by the tests: the results status said "1 page contain"; it now says "1 page contains".

Evidence: `npx tsc -b web/tsconfig.json` passed; `npm run build` passed; `npm run test:e2e` 97 passed, 0 failed (two consecutive runs); `npm run test:registered-flow` passed (2 passed, 1 skipped by design, plus the runner's publish checks). No flaky preview-navigation failure occurred in these runs.

## Review fixes (2026-10-02)

A review of the integration found thirteen issues; all are fixed in the working tree:

1. **Highlight normalization matches the core.** `normalizeWithOffsets` (`domain/text-highlight.ts`) now normalizes per cluster (a character plus following combining marks, U+FF9E/U+FF9F and conjoining Hangul vowel/trailing jamo) and lowercases the whole NFKC text, so composed forms and the Greek final sigma match what the core indexes. `npm run test:text-highlight` (`scripts/text-highlight.test.mjs`, 17 cases: half-width katakana with separate dakuten, NFD/NFC both ways, Hangul jamo and LV+T, final sigma with upper/lowercase queries, surrogate pairs, emoji, full-width ASCII, `İ`, ligatures, compatibility forms) checks each case against the core's `normalize`. Residual: a highlight boundary inside a cluster (half of `ﬃ`) covers the whole cluster; matches stay within single text nodes.
2. **Benchmarks use the new UI.** `benchmark-palette.mjs` checks the blank palette's Recently read section instead of scope buttons, the scoring/index/baseline matrices measure the single ranked list (the `--palette-scope-matrix` mode, the per-scope parity experiment and `paletteScopeExperimentConfig` are removed), and its fixture server now serves `sites.json` (site discovery had moved to the registry, so the benchmark already failed at HEAD before reaching the palette). `benchmark-preview-discovery.mjs` replaces the Previews-tab surface with `palette-open-previews-command` (palette open fetches no preview data; "Open previews" → list paint), drops `--input-samples`, counts requests from the measured action, and waits for a quiet period instead of `networkidle` (which never settled, also at HEAD). Research notes record the change.
3. **Custom `STORAGE_ROOT`.** The `page text search` e2e block skips with an explanation when `/_indexes/textsearch/meta.json` is not served; `run-e2e.mjs` and `prepare-e2e-storage.mjs` document that a custom root must be produced by the prepare script.
4. **Generated file modes.** The indexer's `writeAtomically` now sets 0644 (it used `os.CreateTemp`'s 0600); the publisher and preview writers already set explicit modes. `TestBuildWritesWorldReadableProjectionFiles` covers index, metadata and search files.
5. **Scroll to the first match.** HTML and Markdown scroll on every newly committed query and on load with a query, never over a fragment; re-applying the same query (DOM mutations, fragment changes) does not scroll again.
6. **Enter on the committed query** adds no history entry; after an error it retries. The palette hand-off shares this path. A new query keeps the URL fragment (the fragment is a position in the open page, so no match is scrolled over it).
7. **"Show more" keeps focus**: `aria-disabled` while loading, and focus moves to the first new result when the page arrives if it was on the button.
8. **Live region**: the role=status label only announces loading/result/error; the "Press Enter to search …" hint is a separate, non-live element (the status stays in the accessibility tree, visually hidden, while the hint is shown).
9. **Paging across generations**: a later page from a different search generation re-lists the same number of results from offset 0 instead of appending (code review only; no e2e drives a generation change between pages).
10. **Query errors**: a RangeError for a query over 4,096 characters shows "This query is too long" without "Try again"; other non-data errors show "This query could not be searched".
11. **Stronger e2e**: the unavailable-site test records `/search/` requests of any site; the superseded-query test records every status/alert change from the newer commit (removing the two `controller.signal.aborted` guards makes it fail with an alert "This query could not be searched"); a new loadMore-vs-new-query race test holds the older page's leaves until the newer results render (removing the loadMore abort and query check makes it fail with 9 hits instead of 5).
12. **Dead CSS** removed: `.mobile-search-hint`, `.search-help-keyboard`, `.search-help-touch`, `.site-search-palette kbd`, `.palette-note`.
13. **Frame highlight cleanup** runs when the HTML artifact changes or the frame unmounts.

New e2e (page text search block, now 14 tests): Enter on the committed query/retry/fragment kept; loadMore race; too-long query; scroll to first match for HTML and Markdown including a new query on the open page, no re-scroll after a DOM mutation, and the fragment exception (`prepare-e2e-storage.mjs` adds `long/scroll-target.html` and `.md`, so the site has 32 pages). Reverting the HTML effect to never scroll, or the Markdown scroll to once per document, makes the scroll test fail.

Evidence (2026-10-02): `npx tsc -b web/tsconfig.json` passed; `npm run build` passed; `go test ./...` passed; `npm run test:text-highlight` 17/17. `npm run test:e2e` could **not** run: Docker's storage returned I/O errors (`error creating temporary lease … input/output error`, no images available). The Playwright suite was instead run against a temporary Node server that approximates `docker/nginx/default.conf` (not committed): page text search block 14/14 (and 42/42 with `--repeat-each 3`); full suite 98 passed, 3 failed — the three failures are preview tests asserting nginx-only headers (preview CSP, PDF media type) that the stand-in does not implement. Re-run `npm run test:e2e` with working Docker before Done. `npm run benchmark:palette` completed all four default datasets (1,000–20,000 pages; input-to-paint p50 about 24–28 ms on this machine); `--palette-score-matrix` on 1,000 pages ran 25 strategies with 0 ranking mismatches and 0 page errors (blank sections: Pinned, Recently read, Commands). `npm run benchmark:preview-discovery` completed three scenarios; opening the palette fetched no preview data, and the "Open previews" command painted the list in 287 / 328 / 452 ms for the fixture / 100 / 500 groups (one run each, not a capacity claim).

## Review fixes, second round (2026-10-02)

1. **Clearing a draft that was never searched** (Esc, ×, Enter on a blank field) clears only the field; `clearTextSearch` navigates only when a query is committed, so no duplicate history entry is pushed.
2. **Palette hand-off focuses the sidebar field** (caret at the end, via the same `requestAnimationFrame` path as ⌘ ⇧ F), so ↓ enters the results.
3. **Decoder chunk failures are network failures.** `createSiteFullTextSearch().search` wraps a failed `import('../domain/fulltext-codec')` as `FullTextSearchError('network')` (abort still rejects with the signal's reason); the contract in `docs/architecture/fulltext-search.md` now says so and names the `RangeError` for out-of-bounds queries/pages. In the UI only `RangeError` is non-retryable; any other unexpected error shows "Search could not run" with Try again. Chromium keeps a failed module import failed for the page's lifetime, so the network message now adds "If trying again does not help, reload the page."
4. **"Show more" focus** moves to the first new result only while focus is still on the button (or on `<body>` because the button was removed); after a generation re-list it focuses the result at the old length, or the first result when the list became shorter; an error leaves focus alone.
5. **Highlight style** is adopted as a constructed style sheet made with the artifact window's `CSSStyleSheet`, so the artifact DOM is untouched; a `<style data-gap-search-highlight>` is only the fallback. Re-committing reuses the adopted sheet (no duplicates).
6. **Results container** has `role="region"`, so its `aria-labelledby` name applies; the live status stays a separate `role="status"`.
7. **Late first match** (`watchReaderScroll` in `domain/text-highlight.ts`): after the reader starts scrolling (wheel, touch, pointer, or a scrolling key on `.markdown-scroll` or the HTML frame window) since the query was committed or the page loaded, a match found later is highlighted but not scrolled to.
8. **"Back to site"** on the not-found page keeps `?q=` (`navigateWithinWorkspace`).
9. Docs: this section, the README row, and the "Jump to a page… ⌘ K" wording in Agreed interaction; `docs/specification.md` §8 Search states the draft-clear, hand-off focus, decoder failure, Show more focus, adopted style sheet and late-match rules.
10. **Generation change between pages is now tested.** `prepare-e2e-storage.mjs` also builds a next generation of `textsearch` (two more "lighthouse" notes that sort first) and stores its content-addressed objects next to the current ones with its manifest as `search/manifest-next-generation.json`; the served `manifest.json` is unchanged.

New e2e (page text search block, now 20 tests): draft clearing keeps URL/history and fetches nothing; Back to site keeps `?q=`; the results region's accessible name; Show more keeps focus moved by the reader; Show more after a republish (26 unique results, new notes first, focus on the result at the old length); decoder chunk 404 → "Search data could not be loaded" with Try again, recovery after reload; late match scrolls without reader scrolling (control) and does not after a wheel scroll, for Markdown and HTML; adopted style sheet with no style element and no duplicate after re-commit; palette hand-off focuses the field and ↓ enters the results. Mutation checks (each reverted, rebuilt, test failed, restored): generation re-list → append; focus guard → previous condition; Markdown and HTML late-scroll guard removed; clear guard removed; hand-off focus removed; decoder wrap removed.

Evidence (2026-10-02, second round): `npx tsc -b web/tsconfig.json` passed; `npm run build` passed; `npm run test:text-highlight` 17/17; `go test ./...` passed. `npm run test:e2e` against nginx was **not** run in this round (the Docker run was not permitted in the fixing session). Against the Node stand-in server (not committed; no nginx-only headers or 404 rules): page text search block 20/20, 60/60 with `--repeat-each 3`; full suite 104 passed, 3 failed (the same three preview/namespace tests that depend on nginx 404s and headers). A real nginx `npm run test:e2e` run is required before Done.

Remaining before Done: the public guide pages (owner reviews them one page at a time); confirm ⌘ ⇧ F against real browser shortcuts on macOS/Windows/Linux (Playwright's synthesized `ControlOrMeta+Shift+F` reaches the handler in headless Chromium, which does not prove the browser/OS leaves the real key combination to the page).

## Review fixes, third round (2026-10-02)

1. **"Show more" no longer steals focus from the reader.** The button element is kept from the moment it was pressed. When the page arrives, focus moves only if it is still on that button, or the button itself was removed (focus on `<body>`) and the reader did not blur it while it was still in the document. A blur is checked after the current task, so a blur caused by removing the button does not count. Clicking plain article text while the page loads leaves focus on `<body>`.
2. **A fragment in the frame's own location wins.** `highlightFrame` also requires an empty `iframe.contentWindow.location.hash` before scrolling to the first match, so an in-artifact link such as `scroll-target.html#middle-section` (which loads in the frame without changing the app URL) keeps its section in view.
3. **Focus stays in the field** after × clears the query and after a failure's "Try again" (both buttons remove themselves).
4. **The Markdown reader-scroll watcher no longer resets on a fragment change.** It is a separate effect keyed on the document source and committed query; the highlight effect, which still depends on `hash`, reads its `scrolled` flag. The HTML frame path already had this shape: its watcher is created per frame load and per committed query, and an app fragment change is a same-document frame navigation (no load), so it was left unchanged.
5. **A "Show more" failure is announced.** A visually hidden polite `role="status"` region in the result list says "Could not load more results." only while loading more has failed; it is empty otherwise, so nothing else is announced from it.

Docs: `docs/specification.md` §8 Search states the × / Try again focus, the article-click Show more case, the announced load-more failure, the frame fragment rule and that a fragment change does not reset reader scrolling.

New e2e (page text search block, now 24 tests): "Show more" leaves focus on `<body>` after clicking article text while the page loads; a "Show more" failure is announced and can be retried; a fragment change (set, then back) does not forget that the reader scrolled before a late Markdown match; a fragment in an in-artifact link wins over the first match; focus assertions after × (two tests) and after Try again. Mutation checks (each reverted, rebuilt, its test failed, then restored and the three component files compared byte-identical to the fixed copies): Show more guard back to "any `<body>` focus" → article-click test failed (`not.toBeFocused`); frame hash check removed → in-artifact link test failed (`toBeInViewport`); × focus removed → the draft-clearing and folder/history tests failed; Try again focus removed → the network/invalid-data test failed; watcher effect keyed on `hash` again → fragment-change test failed (scrollTop changed); live region text removed → load-more failure test failed.

Evidence (2026-10-02, third round): `npx tsc -b web/tsconfig.json` passed; `npm run build` passed; `npm run test:text-highlight` 17/17; `go test ./cli/internal/indexer/...` passed. `npm run test:e2e` against nginx was **not** run (Docker/colima is blocked on this machine). Against the Node stand-in server (not committed; storage from `prepareE2eStorage`, no nginx-only headers or 404 rules): page text search block 24/24, 120/120 with `--repeat-each 5`; full suite 108 passed, 3 failed — the same three tests that depend on nginx (multi-file namespace 404, preview HTML navigation header, raw preview 404s/headers). A real nginx `npm run test:e2e` run is still required before Done.

## Review fixes, fourth round (2026-10-02)

1. **Removing a fragment from an HTML page no longer jumps to the first match.** `syncHtmlFrameLocation` replaced the frame location with `page` when the app fragment was removed (for example Back after a heading jump); going from `page#a` to `page` is a full navigation, so the frame reloaded and its load handler scrolled to the first match with a new reader-scroll watcher, even after the reader had scrolled. It now navigates to `page#`: an empty fragment is a same-document navigation (to the top of the page, `location.hash` stays `''`), so the frame keeps its document, highlight and reader-scroll watcher. This also keeps "a fragment change does not reset this" true for HTML. The preview frame sync (`PreviewDocumentPage`) has no highlight and is unchanged.
2. **"Show more" into a collapsed folder keeps focus.** When the first new result belongs to a folder the reader collapsed, its row is not rendered, so focus fell to `<body>`. The folder is now expanded and the result focused once it renders (the same applies to the first result after a generation re-list).

Docs: `docs/specification.md` §8 Search says Show more expands a collapsed folder and that removing the fragment from an HTML page neither reloads the frame nor scrolls to the first match.

New e2e (page text search block, now 26 tests): "Show more" expands a collapsed folder to focus the first new result (collapse `bulk/`, End, Enter on "Show 4 more" → `bulk/` expanded, `bulk/note-21.md` focused); removing a fragment from an HTML page keeps the reading position (open `scroll-target.html?q=zephyrmarker`, wheel to the top, set `#middle-section`, Back → the match is not in view, the heading is, the frame document was not replaced, the highlight remains). Mutation checks (each reverted, rebuilt, its test failed, then restored and compared byte-identical): `page#` back to `page` → fragment test failed (`not.toBeInViewport`: the match was in view); folder expansion removed → Show more test failed (`aria-expanded` stayed `false`).

Evidence (2026-10-02, fourth round): `npx tsc -b web/tsconfig.json` passed; `npm run build` passed; `npm run test:text-highlight` 17/17. `npm run test:e2e` against nginx was **not** run (Docker/colima not used in this session). Against the Node stand-in server (not committed; storage from `prepareE2eStorage`, no nginx-only headers or 404 rules): page text search block 26/26, 130/130 with `--repeat-each 5`; full suite 110 passed, 3 failed — the same three nginx-dependent tests (multi-file namespace 404, preview HTML navigation header, raw preview 404s/headers). In an earlier full run and in isolated runs, `folder breadcrumb menus list their contents …` also failed intermittently (timeout pressing a breadcrumb menu item); it failed the same way with both fourth-round fixes reverted (2 of 3 runs), and it does not render page text search, so it is a pre-existing flake unrelated to this round. A real nginx `npm run test:e2e` run is still required before Done.

## Fifth review (2026-10-02)

The fifth independent review found no remaining defect in IMP-42. It required no product change; two test-only changes followed:

- The fragment-removal test is now named "removing a fragment from an HTML page returns to the top without reloading or jumping to the first match", which is what it proves.
- "folder breadcrumb menus list their contents …" was flaky before IMP-42 as well (HEAD build on the same stand-in: 6 of 40 failed). Cause: `ArtifactBreadcrumbs` restores focus to the trigger in a later animation frame after Escape, and the test focused another trigger before that frame ran. The test now waits for `folderTrigger` to be focused after the second Escape. Evidence (Node stand-in): 30/30 with `--repeat-each 30 --workers 5`, previously 4 of 20 failing.

Evidence on the Node stand-in after these changes: full suite 110 passed, 3 failed (the nginx-only namespace 404, preview navigation header, and raw preview header tests). The real nginx `npm run test:e2e` is still blocked by a broken local Docker VM (containerd `meta.db: input/output error`) and remains required before Done.

## nginx verification (2026-10-02)

After the local Docker VM was repaired, `npm run test:e2e` ran against the real nginx container (Docker Compose, `prepare-e2e-storage` output). Note: an earlier attempt reached a leftover Node stand-in that was still listening on port 4174, which produced the same three nginx-header failures as the stand-in; that server was stopped before the runs below.

- Full suite on nginx: 113 passed in 10 of 11 runs. One run had a single failure that was not captured; nine further full runs did not reproduce it.
- `npm run test:registered-flow`: passed.
- No `git-artifact-pages-e2e` container remained after the runs.

Remaining before Done: the public guide pages (owner reviews them one at a time), a real-browser check that ⌘ ⇧ F reaches the page on macOS, Windows and Linux, and a real Japanese IME check (automation simulates `isComposing`).

## Acceptance criteria to verify after integration

- [ ] Agreed committed-query interaction is implemented, including Enter/button and Japanese IME behavior.
- [x] Search assets are not fetched while opening the surface or typing; only committed nonblank queries invoke the API.
- [x] Active-site scope and unavailable search metadata remain clear; ordinary site/command/heading search behavior is preserved or deliberately revised.
- [x] Loading, zero hits, network/invalid-data failure, retry and result paging work; a superseded query cannot overwrite current results.
- [x] Result selection uses normal logical routes and renders HTML/Markdown through the existing reader.
- [ ] Browser checks cover the selected UX and network timing; documentation records the final interaction.

This item is not an instruction to deploy externally, add a backend, change infrastructure, or add ranking/snippets to the search format. If a UX requirement needs additional core fields, record that specific change and its capacity impact before expanding IMP-41's settled format.

Suggested prompt: “Proceed with IMP-42. Read IMP-41 and the core contract, explore the committed-query UX with me, then connect the agreed UI to the existing full-text API.”
