# IMP-45 — Unified product release, CLI-pinned web bundle and compatibility gates

- Status: Open
- Lanes: CLI (primary), Frontend, Docs / Adoption
- Execution: Agent-led within the settled [TD2](../technical-design/TD2-component-release-policy.md) policy. Pushing a release tag remains the owner's approval.
- Requires: TD2 revision of 2026-10-03 (Done).
- Release gate: the `v0.1.0` re-release is the first use of the tag workflow; [T16](../verification/T16-external-adoption.md) consumes it.

## Goal

Implement TD2's one-version product release: the CLI knows and deploys its own web bundle, readers follow the compatibility rules, and GitHub Actions classify every change as compatible or breaking against the previous release before a release is published.

## Slices

1. **CLI version and pinned deploy**
   - `cli/internal/version` constant (set to `0.1.0` for the re-release) and `artifact-pages version` (product version plus VCS revision from build info).
   - `app deploy` without `--version`: resolves `v<constant>` assets from the GitHub release, verifies archive/manifest/checksum; `--archive` unchanged. Remove the `--version` flag and the admin Action `version` input; update Action wrapper, examples, parity tests and guides (`docs/guides/app-bundle-deployment.md`, `github-actions.md`, `clean-room-adoption.md`, specification §22).
2. **Reader compatibility rules**
   - Web: no exact-key validation (`sites.json` root keys); explicit `schemaVersion` checks for `meta.json` and `index.json`; an unknown `schemaVersion` in any site format shows a "this site needs to be republished" state (registry: an equivalent product-level state); missing optional fields disable the feature.
   - CLI: an unknown `schemaVersion` in data it reads fails with a message naming the required upgrade action.
   - Specification: record the reader rules and the republish state.
3. **Compatibility gate**
   - Script that builds the CLI at the baseline (latest release tag) and the candidate, produces data from the same fixture sources with each, compares `schemaVersion` per format and reports `compatible` or `breaking`.
   - Compatible mode: mixed-version suite (candidate web × baseline data, baseline web × candidate data, mixed storage, cross-CLI republish/preview/lock/recovery) with a browser smoke per combination.
   - Breaking mode: candidate web shows the republish state for baseline data; the documented upgrade procedure converges.
   - Tag consistency: breaking requires a MAJOR increase (MINOR while `0.x`).
4. **Workflows**
   - PR / `main` workflow: Go, type, text-highlight and browser tests plus the gate (skipped while no release exists).
   - Tag `v*` workflow: tag equals the version constant and is on `main`; full tests and gate; package the web bundle; create the pre-release with the three assets and generated notes (web changed/unchanged, compatibility mode, upgrade procedure when breaking); verify by `app deploy` from the tagged CLI into a clean local target with byte comparison. Third-party Actions pinned by full SHA; minimal token permissions (`contents: write` only on the release job).
5. **Re-release `v0.1.0`** through the tag workflow after the owner pushes the tag, and record the evidence in TD2 and [release readiness](../release-readiness.md).

## Acceptance criteria

- [ ] `artifact-pages version` prints the constant and revision; `app deploy` takes no `--version` and deploys the pinned bundle; `--archive` still works; Action parity and clean-room tests pass.
- [ ] Web and CLI readers ignore unknown fields and handle unknown `schemaVersion` as specified, with tests.
- [ ] The gate classifies a fixture change correctly in both directions (an additive field stays compatible; a bumped `schemaVersion` is breaking) and the mixed-version suite runs against a real baseline tag.
- [ ] A tag whose version does not match the constant, or a breaking change without the required version increase, fails the tag workflow before any release is created.
- [ ] `v0.1.0` is published by the workflow, with release notes, assets and post-publication verification recorded.
