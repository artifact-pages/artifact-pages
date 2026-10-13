# Malformed artifact index rows pass loading and crash rendering

- Status: Open
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

An index with invalid rows is reported as a load error that names the site, and any other render exception shows a recovery screen instead of a blank page. Decision (main session): reject the whole index with a load error naming the site; do not drop individual rows. Unknown extra fields stay ignored.

## Acceptance criteria

- [ ] `parseSiteIndex` validates the fields the web reader requires on every artifact row (including `id`, `path`, and the URL fields), rejects duplicate ids and duplicate paths, and rejects the whole index with an `IndexLoadError` that names the site. Unknown extra fields are still ignored.
- [ ] An app-level React error boundary shows a recovery screen with a reload hint and a republish hint instead of a blank page.
- [ ] A regression test feeds `{"artifacts":[{"id":"broken"}]}` and a duplicate-id index and expects the load error; a second test makes a child component throw and expects the recovery screen.
