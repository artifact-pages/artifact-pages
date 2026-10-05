# IMP-62 — Organization move and version restart

- Status: Done
- Lanes: CLI / release, Docs
- Depends on: [TD14](../technical-design/TD14-one-repository-per-action.md)

## Goal

Move references from `tasuku43/git-artifact-pages` to `artifact-pages/artifact-pages` and restart the product version at `0.1.0`.

## Acceptance criteria

- [x] Go module path `github.com/artifact-pages/artifact-pages`; imports, scripts and fixtures updated; `go vet` and `go test` pass.
- [x] `Product` is `0.1.0`; the `app deploy` default repository, specification, guides, README and examples name the organization.
- [x] Release preflight, release notes and the compatibility gate work with no earlier release (tests added: baseline selection for a first release, first 0.x release notes).
- [x] Historical backlog evidence links are left to GitHub's redirects.

## Results

- 2026-10-06: done with IMP-61. Deleting the old releases and tags, tagging `v0.1.0` and re-pinning consumers are owner steps in [release readiness](../release-readiness.md).
