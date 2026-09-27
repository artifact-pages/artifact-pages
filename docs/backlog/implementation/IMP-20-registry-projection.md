# IMP-20 — Validate and project the site registry

- Status: Open
- Phase: Provider-backed deployment
- Depends on: —
- Proves: registry schema and deterministic projection tests

## Outcome

Turn the admin-owned root `sites.yaml` into the sole deterministic `/_indexes/sites.json` representation for browser discovery and satellite eligibility.

## Acceptance criteria

- Strictly validate schema version, mapping shape, exact entry fields, duplicate keys, site IDs/reserved IDs, names, `owner/repo`, safe canonical source paths, and duplicate `(repository, sourcePath)` pairs per specification §11.
- Equivalent YAML produces byte-stable, ID-sorted JSON with `sites: []` for an empty registry; generated JSON is not editable source state.
- Tests cover valid multiple sites and every rejection category; this slice performs no provider write.
