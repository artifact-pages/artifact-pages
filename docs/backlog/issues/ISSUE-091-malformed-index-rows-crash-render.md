# Malformed artifact index rows pass loading and crash rendering

- Status: Done
- Assignee: Claude
- Priority: P2
- Area: Web data loading
- Implementer: Claude
- Source: public-launch review 2026-10-13, finding R7

## Problem

`parseSiteIndex` accepts any `artifacts` array without checking its rows. A row missing required fields is accepted as a valid index and then throws while the tree is built, so a damaged index becomes a render-time exception instead of a "cannot load this site" screen. The app has no error boundary, so the user sees a blank page with no recovery hint.

The Go writer does not produce such rows. The realistic causes are a hand edit, a damaged projection, or another writer.

## Evidence and reproduction

1. `parseSiteIndex` (`web/src/data/indexes.ts:146`) checks the schema version, site id/title/description, `generatedAt`, and only that `artifacts` is an array.
2. `loadSiteIndex` accepts `{"artifacts":[{"id":"broken"}]}` (reproduced with a synthetic payload; public-launch review 2026-10-13, workspace-local report).
3. `buildArtifactTree` (`web/src/domain/tree.ts:24`, `artifact.path.split('/')`) then throws `Cannot read properties of undefined (reading 'split')`.
4. A search of `web/src` finds no React error boundary (`ErrorBoundary`, `componentDidCatch`).

## Expected outcome

An index with invalid rows is reported as a load error that names the site, and any other render exception shows a recovery screen instead of a blank page. The review calls the desired result a proper load error instead of a render-time crash. The whole index is rejected rather than individual rows dropped, because a partially dropped index would show a tree and search that silently miss pages. The reader shows a load error naming the site and a republish hint. Unknown extra fields stay ignored.

## Acceptance criteria

- [x] `parseSiteIndex` validates the fields the web reader requires on every artifact row (including `id`, `path`, and the URL fields), rejects duplicate ids and duplicate paths, and rejects the whole index with an `IndexLoadError` that names the site. Unknown extra fields are still ignored.
- [x] An app-level React error boundary shows a recovery screen with a reload hint and a republish hint instead of a blank page.
- [x] A regression test feeds `{"artifacts":[{"id":"broken"}]}` and a duplicate-id index and expects the load error; a second test makes a child component throw and expects the recovery screen.

## Verification

- `npx tsc -b web/tsconfig.json`: clean. `npm run build`: passes.
- `npm run test:web-unit`: passes, including the new `web/src/data/indexes.test.mjs` (8 tests: malformed row, duplicate id, duplicate path, protocol-relative `artifactUrl`, `..` path, unknown extra field, the sre fixture, HTTP failure not marked as invalid data).
- e2e against a local compose stack (project `claude-091`, port 4395): two new tests in `web/e2e/local-serving.spec.ts` (a malformed row shows "Unable to load this site" with the republish message; a forced render-time exception shows "Something went wrong" and the Reload button). `CI=1` full suite: 223 passed, 0 failed, 0 flaky.
