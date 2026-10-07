# IMP-67 — Web release declares the formats it reads

- Status: Done
- Assignee: Codex
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

- [x] Manifest of a packaged bundle lists `reads` for every published format.
- [x] Reader and manifest cannot disagree (test).
- [x] Existing browser and compatibility-gate tests pass.

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

## Packaging implementation and verification (2026-10-08)

`package-web-release.mjs` reads the web-owned table and writes its `reads` object
unchanged into the release manifest. The packaging regression checks an actual
manifest against the reader table, verifies its format names are classified as
public formats by the compatibility gate, and exercises a future table with
multiple readable versions in non-sorted order. The existing reader/table test
and packaging test both run in `verify.yml` via the npm scripts already wired
by the web PR (#53).

Verified with Node.js 24.19.0:

- `npm run test:web-packaging`: 2 passed.
- `npm run test:schema-versions`: 13 passed.
- `npm run test:compatibility-policy`: 18 passed.
- `npm run package:web -- --version codex-imp-67-check`: built and packaged
  101 files; the generated manifest's six `reads` entries equal the reader table.
- Browser suite: 161 passed through nginx/Compose (`codex-imp-67-e2e`, port 4187),
  including the existing reader compatibility scenarios.
- `node scripts/compat-gate.mjs --out .local/compat-imp-67.json`: exited 0 with
  `pre-1.0-compatibility-not-guaranteed`, the existing 0.x skip policy.
