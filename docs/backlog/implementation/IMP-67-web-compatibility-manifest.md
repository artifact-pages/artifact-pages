# IMP-67 — Web release declares the formats it reads

- Status: In progress
- Assignee: Claude
- Lanes: Web, CLI / release
- Owner: Claude (web constants), Codex (packaging script); two PRs, one per agent's directories, web constants first
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

## Handoff to the packaging half

The web half is in place. The single source of truth is `web/src/data/supported-schema-versions.json`:

```json
{
  "schemaVersion": 1,
  "reads": {
    "registry": [1],
    "site-metadata": [1],
    "artifact-index": [1],
    "full-text-manifest": [1],
    "preview-catalog": [1],
    "preview-manifest": [1]
  }
}
```

- `npm run package:web` can copy the `reads` object verbatim into the web release manifest as `reads`. The format names match the compatibility gate (`PUBLIC_FORMATS` in `scripts/compat-gate.mjs`).
- Readers decide acceptance only from this file (`isSupportedSchema` in `web/src/data/schema.ts`); no reader hard-codes a version.
- The reader-versus-table test is `web/src/data/supported-schema-versions.test.mjs`. Run it with `node --experimental-transform-types --no-warnings --test web/src/data/supported-schema-versions.test.mjs`; adding an npm script and a `verify.yml` step for it is left to the script owner (`package.json` and `.github/` are outside the web lane).
