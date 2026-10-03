# IMP-45 — Unified product release, CLI-pinned web bundle and compatibility gates

- Status: Done
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

- [x] `artifact-pages version` prints the constant and revision; `app deploy` takes no `--version` and deploys the pinned bundle; `--archive` still works; Action parity and clean-room tests pass.
- [x] Web and CLI readers ignore unknown fields and handle unknown `schemaVersion` as specified, with tests.
- [x] The gate classifies a fixture change correctly in both directions (an additive field stays compatible; a bumped `schemaVersion` is breaking) and the mixed-version suite runs against a real baseline tag.
- [x] A tag whose version does not match the constant, or a breaking change without the required version increase, fails the tag workflow before any release is created.
- [x] `v0.1.0` is published by the workflow, with release notes, assets and post-publication verification recorded.

## Implementation status (2026-10-03)

Slices 1-4 are implemented locally and uncommitted for review; slice 5 needs the owner's tag.

- Slice 1: `cli/internal/version` (`Product = "0.1.0"`), `artifact-pages version`, `app deploy` without `--version` (downloads `v<Product>`; `--archive` kept), admin Action `version` input removed.
- Slice 2: web `data/schema.ts` (supported-version checks, `UnsupportedSchemaError`), republish states for site, registry, previews and search; CLI `cli/internal/compat` and removal of `DisallowUnknownFields` from published-data and control-record readers. Specification section 5.3.
- Slice 3: `scripts/compat-gate.mjs`, `web/e2e/compat-smoke.spec.ts`, `web/playwright.compat.config.ts`. Proven locally with `--baseline HEAD` (compatible) and a scratch candidate with bumped `meta`/`index` versions (breaking, upgrade converges, version check fails for `v0.1.1`). Not yet run against a real release tag, so the criterion about a real baseline tag stays open.
- Slice 4: `.github/workflows/{ci,verify,release}.yml`, `scripts/release-preflight.mjs`, `scripts/release-notes.mjs`, `scripts/verify-release.mjs`; linted with actionlint. No workflow has run on GitHub yet, so the tag-mismatch acceptance criterion is verified only by `release-preflight.mjs` locally.

## Release evidence (2026-10-03)

- **Gate classification.** Locally the gate reported `compatible` against a commit baseline and `breaking` for a candidate with bumped `meta.json`/`index.json` `schemaVersion`, where `--tag v0.1.1` failed the version check and `--tag v0.2.0` passed. On GitHub it ran against real release tags: v0.1.0 as baseline for v0.1.1 and v0.1.1 for v0.1.2, both `compatible` with all four mixed-version browser smokes passing.
- **Failure before release.** The first `v0.1.0` tag run (run 37078515622) failed in Verify and created no release. `release-preflight.mjs` rejects tags that differ from the CLI constant or are not on `main`.
- **Published by the workflow.** `v0.1.0` (`8bfd247`, run 37082155824), `v0.1.1` (`370e4f6`) and `v0.1.2` (`5eab98a`) were each created by the tag workflow with generated notes, three assets and post-publication `app deploy` verification. `go install …/cli/cmd/artifact-pages@v0.1.2` was verified locally (module sum `h1:7i+d3OWFG/ct0CGc+F5xHYSMNfKvoMBg4rN0+G+kTmc=`).
- **Superseded.** `v0.1.0` cannot be installed with `go install` (fixture file names invalid in a module zip; fixed by `fixtures/go.mod` and a CI module-zip check). `v0.1.1` depends on goldmark v1.7.13 (GO-2026-5320) and was built with Go 1.26.0. Both release notes point to the successor; tags are kept.
- **Defects found on the way.** CI-only issues (Chromium install order, an uncommitted docs-script dependency, a Ctrl+K race) and product defects: frame fragment scroll on history traversal, a stale frame keydown handler, and a fresh local storage root created `0700`, which nginx could not read on Linux.
