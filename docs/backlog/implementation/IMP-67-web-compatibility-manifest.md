# IMP-67 — Web release declares the formats it reads

- Status: Open
- Lanes: Web, CLI / release
- Owner: Claude (web constants), Codex (packaging script)
- Depends on: [TD17](../technical-design/TD17-config-pinned-component-versions.md)
- Blocks: IMP-69, IMP-70

## Goal

The web app declares, per published format, the `schemaVersion`s it reads, and `npm run package:web` writes that list into the web release manifest (`reads`). This is the web half of the compatibility data in TD17 section 3.

## Scope

- One source of truth in `web/` for the readable `schemaVersion` of each format the reader parses (registry, `meta.json`, `index.json`, preview catalogs and manifests, full-text data); the reader's existing "needs to be republished" logic uses the same constants.
- The package script copies the list into the manifest; a unit test fails when a reader accepts a version the manifest does not list, or the reverse.

## Acceptance criteria

- [ ] Manifest of a packaged bundle lists `reads` for every published format.
- [ ] Reader and manifest cannot disagree (test).
- [ ] Existing browser and compatibility-gate tests pass.
