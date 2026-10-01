# IMP-41 — Static full-text search core, independent of palette UX

- Status: Done
- Priority: P1
- Phase: Phase 1 local product
- Execution: Agent-led local implementation and verification.
- Requested by owner: 2026-10-01. Implement through a callable browser API, defer detailed palette UX, and preserve a resumable handoff if an agent hits a limit.
- Contract: [Static full-text search core](../../architecture/fulltext-search.md).
- Evidence: [feasibility](../../research/fulltext-search-feasibility.md), [capacity experiment](../../research/fulltext-search-cost.md), [earlier 61,000-page research deployment](../../research/fulltext-local-load-benchmark.md).
- Follow-up: [IMP-42](IMP-42-fulltext-search-ux.md), deliberately deferred UX integration.

## Outcome

The existing Go builder optionally generates a versioned site-scoped full-text projection. The existing provider-neutral publisher reconciles it in a safe order. `createSiteFullTextSearch(metadata)` exposes an explicitly invoked browser API returning exact document IDs, logical routes, total count and a result page. The production palette is unchanged; later UX work can call this core without implementing a new search engine.

Enable with `index build --fulltext` or `site publish --fulltext`. This flag defaults to false and must be passed on each publication that should retain full-text search. No new backend, vector service, provider infrastructure, Action workflow or persistent config setting was introduced.

Search uses NFKC/lowercase, whitespace-separated AND substring terms, static display title/body, and UTF-8 path order. There is no BM25, snippet, phrase-position or runtime DOM/script indexing.

## Implementation map

- `cli/internal/fulltext/build.go`: normalization/body extraction, token postings, singleton inline references, 128 stable FNV buckets, per-leaf posting interning, delta/bitmap/run/complement/all modes, deterministic gzip and front-coded vocabulary/paths. Manifest generation covers all object references; a posting-only update changes generation even if its root is unchanged. Production builds do not require Node.
- `cli/internal/indexer/build.go`: `BuildOptions.FullText`, shared HTML/Markdown parse, optional `meta.json.fullTextUrl`, search files/byte metrics and pruning of owned stale local files after metadata replacement.
- `cli/cmd/artifact-pages/{main,operation_report}.go`: optional flags, help and output metrics.
- `cli/internal/publisher/{publish,site_publish,site_cache}.go`: source bytes → immutable search blobs → index → manifest → discovery metadata → stale deletion; idempotent/no-op planning and existing lock/cache-retry mechanism. `.gz` objects are octet-stream with no HTTP Content-Encoding because the client explicitly inflates them.
- `web/src/domain/{index,fulltext-codec}.ts`, `web/src/data/{indexes,fulltext}.ts`: optional discovery pointer and lazy `createSiteFullTextSearch(metadata)`. Public API: `available`, `search(query, {signal,offset,limit})`, `clear()`. One site's promise cache, 60-second manifest revalidation, six-request fan-out, integrity/format checks, one manifest refresh on stale-object 404, and caller cancellation that does not poison shared requests.
- `cli/internal/fulltext/build_test.go`, `cli/internal/indexer/fulltext_test.go`, `cli/internal/publisher/site_fulltext_test.go`: build/extraction/determinism/generation/publication regressions.
- `scripts/test-fulltext-core.mjs` / `npm run test:fulltext`: actual Go build → HTTP → TypeScript API in Chromium, independent of any production UX.

## Verified acceptance criteria

- [x] Deterministic versioned search files and optional discovery pointer; metadata-only builds remain valid.
- [x] HTML/Markdown title/body extraction, exclusions, inline continuity and Go/browser Unicode behavior verified, including Greek final sigma, dotted I, width folding, Japanese and supplementary characters.
- [x] Exact site-scoped IDs/routes, path order, counts, paging and reserved filename encoding; zero search-data/decoder requests on construction or blank input.
- [x] Warm cache, caller cancellation with a concurrent shared request, failed-request retry, malformed version/scope/payload rejection, checksum checking, 404 refresh and freshness expiry verified in Chromium.
- [x] Existing publisher orders blobs before manifest/metadata, remains no-op when unchanged, recovers after partial manifest failure, removes stale/disabled search data and preserves another site.
- [x] New format verified on the previous 50,000-page corpus; four query counts and first-page paths matched its original oracle.
- [x] API/format/build/publish/update semantics documented, relevant regressions passed, production palette UX intentionally deferred.

## Evidence — 2026-10-01

- `go test ./...`: passed all Go packages, including new full-text/indexer/publisher tests and existing preview/CLI regressions.
- `npm run build`: passed TypeScript and production build; existing large-bundle advisory remains. Since no production UI consumes the new API yet, unused search modules are tree-shaken from that bundle.
- `npm run test:fulltext`: passed after final discovery-pointer, title-field and literal-backslash filename checks. Generated run: `.local/fulltext-core/519cc00a-d52c-4e5e-a545-5739781436f8/`.
- `node scripts/test-fulltext-core.mjs --scale-source .local/fulltext-load/run-20261001101659717-648ba6c0/storage/_artifacts/load-50000`: passed core checks plus scale/oracle checks. Run: `.local/fulltext-core/53349485-01f1-436f-858c-c8a6f257face/`; inspect `scale.json`.
- Scale: 50,000 documents, complete metadata + full-text build **6.24 s** (6.26 s including process overhead), root **221,107 bytes**, search blobs **5,371,540 bytes**, manifest **28,280 bytes**, total **5,399,820 bytes / 130 files**. API-only local cold samples: cache 102 ms / 5,130 hits; 再試行 85.5 ms / 500; body-only marker 91.3 ms / 1; absent term 77.9 ms / 0. These are one sample per query, no UI paint measurement or constrained/mobile profile.
- `git diff --check` and script syntax checks passed.

The browser verification server applies nginx-equivalent content-plane 404 behavior; ordinary Vite missing-file SPA fallback is not treated as a valid search-object response. The evidence proves the callable core locally, not live-provider cache headers or a new production palette experience. The earlier research form on port 4188 still uses the research codec.

## Handoff / resume

The implementation, tests and handoff documentation are recorded in the commit containing this ticket. The owner requested this local commit after verification; no external publication was requested. Read `AGENTS.md`, thesis/specification/roadmap, this record, the core contract and any current diff before changing architecture. Use `git status --short` and inspect untracked files as well: ordinary `git diff` does not show their contents.

There are unrelated public guide/assets, backlog/documentation and Terraform changes. Preserve them; do not assume all dirty files belong to IMP-41. The earlier research scripts/docs are included with this core implementation. `.local/` evidence is ignored and machine-local; the repository documentation records the important outcomes so loss of generated data does not lose the handoff.

For UX continuation, use **IMP-42**, not a silent reopening of completed core criteria. Its deferred work includes choosing the committed-query surface, presenting load/error/unavailable states, paging, and suppressing an older submission's result. Create/drop a site client with the active site's metadata, then call `search.search(query)` only on commit. A submission ID or AbortController still belongs in the UI.

For a core defect or optimization, inspect the files above, run the focused browser/Go checks, and record new evidence. Root/path partitioning, rank metadata and naturally varied long Japanese corpora remain separate measured follow-ups. Do not broaden this task into infrastructure or redesign the palette without the owner's follow-up request.

Suggested continuation prompt: “Continue IMP-42 using the completed IMP-41 core and its contract. Read both tickets and the working-tree diff first; explore the submit-to-search UX, then implement the agreed integration while preserving unrelated work.”
