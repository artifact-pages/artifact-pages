# TD2 — Licensing, product versioning and data compatibility

- Status: Done
- Phase: Reusable distribution
- Revised: 2026-10-03 — replaces the earlier web-only SemVer / CLI-by-SHA policy (2026-09-28) with one product version, a CLI-pinned web bundle, a compatibility contract and automated release gates.
- Related implementation: [IMP-45](../implementation/IMP-45-unified-release-and-compatibility.md), [IMP-31](../implementation/IMP-31-app-distribution.md), [IMP-34](../implementation/IMP-34-actions.md), [IMP-35](../implementation/IMP-35-external-adoption.md), [IMP-38](../implementation/IMP-38-terraform-registry-publication.md)
- Related verification: [T16](../verification/T16-external-adoption.md)

## Design questions

1. Which OSS license applies?
2. How are the CLI, composite Actions and web bundle versioned and released together?
3. What compatibility does each version step promise for the published data (registry, indexes, artifacts, previews, search data), and how is that promise enforced?

## License (unchanged)

The project owner selected MIT on 2026-09-28. The root `LICENSE` uses `Copyright (c) 2026 tasuku43` and covers first-party work; dependencies keep their upstream licenses. `npm run package:web` copies `LICENSE` and generates `THIRD_PARTY_NOTICES.txt` from the installed production dependency graph and fails when a required license text is missing. No standalone CLI binary is distributed; if one is added, its Go dependency notices must accompany it.

## Why the policy changed

The first web pre-release was tagged `v0.1.0` at the repository root. The root is also the Go module `github.com/tasuku43/git-artifact-pages`, so any root `vX.Y.Z` tag is the CLI's Go module version as well: `go install …/cli/cmd/artifact-pages@latest` resolves to the newest such tag. A web-only tag series would therefore have (a) published phantom CLI versions on web-only changes and (b) left `@latest` on a stale CLI after CLI-only changes. Independently versioned web and CLI also required a compatibility matrix between every web version and every CLI revision that writes data.

The owner decided (2026-10-03) to ship one product version in which the CLI knows the web bundle it deploys. The initial `v0.1.0` release and tag (source `6385d57`) were deleted the same day, before any known consumer, and `v0.1.0` will be re-released through the automated flow below. The owner accepted the residual risk that the Go checksum database recorded the deleted tag if anything fetched it in that window; re-pointing would then make `go install …@v0.1.0` fail verification. This was not checked, because querying the module proxy can itself trigger that fetch.

## Settled policy

### One product version

- A single tag series `vMAJOR.MINOR.PATCH` versions the whole product: the CLI (as the root Go module), the composite Actions in `actions/`, and the web bundle. There are no component-prefixed tags.
- The GitHub release for `vX.Y.Z` carries the web archive built from the tagged commit, with its JSON manifest and `.sha256` file (`artifact-pages-web-vX.Y.Z.tar.gz[.json|.sha256]`).
- Terraform modules live in their own repositories and keep independent provider-module versions ([IMP-38](../implementation/IMP-38-terraform-registry-publication.md)); they are not part of this tag series.
- Tags and release assets are never moved or replaced after a release is consumed; corrections ship as a new version. The pre-consumption `v0.1.0` withdrawal above is the only exception.

### The CLI pins its web bundle

- The CLI source holds its product version as a constant (`cli/internal/version`). The release commit sets it; `-ldflags` are not used because `go install` and the Actions' `go build` cannot pass them.
- `artifact-pages app deploy` deploys the web bundle of the CLI's own version: it downloads `vX.Y.Z`'s release assets and verifies archive, manifest and checksum before writing. The `--version` option and the admin Action's `version` input are removed. `--archive FILE` remains for local and pre-release bundles.
- Between releases the constant still names the last release, so a development build deploys that release's web bundle unless given `--archive`.
- `artifact-pages version` prints the product version and the VCS revision recorded in the Go build info.
- Pinning an Action or CLI ref therefore pins a tested CLI/web pair. Deployment stays explicit: a new tag or a CLI upgrade never deploys the app by itself.

Every kind of change goes through the same release:

| Change | Release | Effect for an admin repository |
| --- | --- | --- |
| CLI only | New `vX.Y.Z`; the web bundle has identical file contents | `app deploy` reports no-op |
| Web only | New `vX.Y.Z` | `app deploy` updates the application plane |
| Both | New `vX.Y.Z` | Same as web only |

Release notes state whether the web bundle changed since the previous release, computed by comparing release manifests and file digests.

### Data formats and compatibility

Each published format carries an integer `schemaVersion`. A format's version changes only for a breaking change to that format; additive changes keep it. The formats are the registry (`/_indexes/sites.json`), site metadata (`meta.json`), the artifact index (`index.json`), preview catalogs and revision manifests, full-text search data, and the CLI's control records (locks, cleanup and cache records). The full-text manifest's `version` field is renamed to `schemaVersion` for consistency in the next breaking change to that format, or earlier if it can be done compatibly.

Readers must:

- ignore unknown fields (no exact-key validation);
- treat a missing optional field as the feature being unavailable (for example no `fullTextUrl` → no page text search);
- treat an unknown `schemaVersion` as a confirmed but unreadable format: the web shows a "this site needs to be republished" state instead of an error or a misread page, and the CLI fails with a message naming the required action.

Satellite repositories pin their own CLI refs, so one storage normally contains data written by several CLI versions and read by one web version. The promises below are written for that mixed state.

| Step | Data formats | Promise | Required operator action |
| --- | --- | --- | --- |
| MAJOR | A `schemaVersion` may increase | None across the step. The new web reads only the new formats and shows "needs to be republished" for old ones. | Upgrade in order: `registry register`, `app deploy`, then republish every site with the new CLI. Release notes give the procedure. |
| MINOR | Additive only; no `schemaVersion` change | Within the major version, any web reads data from any CLI, newer or older; any CLI reads and updates data written by any other. | None. Republish a site to use a new feature. |
| PATCH | No format change | Fully compatible fixes. | None. Run `app deploy` when the notes say the web bundle changed. |

While the product is `0.x`, the MINOR position acts as MAJOR and PATCH as MINOR/PATCH: `0.1.x → 0.2.0` may break formats; releases within `0.1.x` must stay compatible. From `1.0.0` the table applies as written.

### Automated release and compatibility gates

Breaking versus compatible is decided by the data, not by a person waiving a red check. The gate builds the CLI at the previous release tag (the baseline) and at the candidate, runs both on the same fixture sources, and compares the `schemaVersion` of every format each produces.

- **Compatible** (no `schemaVersion` changed): the mixed-version suite must pass —
  - candidate web reading baseline-written data (app deployed before satellites upgrade);
  - baseline web reading candidate-written data (satellites upgrade before the app);
  - one storage holding sites written by both CLIs, with registry, previews and search data;
  - each CLI republishing, previewing, locking and recovering over the other's output.
  Each combination runs a browser smoke: site picker, HTML and Markdown artifacts, page text search on a search-enabled site, preview list and document.
- **Breaking** (some `schemaVersion` changed): the suite switches to upgrade checks — the candidate web shows "needs to be republished" for baseline data without crashing, and the documented upgrade procedure converges to a fully working storage.
- **Version consistency** on a tag: a breaking result requires a MAJOR increase (MINOR while `0.x`); a MAJOR increase without a format change is allowed; any other mismatch fails the release.

Two GitHub Actions workflows implement this:

1. **Pull requests and pushes to `main`:** unit, type and browser tests plus the gate against the latest release, so a compatibility break is found when it is introduced. Skipped while no release exists.
2. **Tag push `v*`:** checks that the tag equals the CLI version constant and points at a commit on `main`; runs the full test suite and the gate; packages the web bundle from the tagged commit; creates the GitHub release with the three assets and generated notes (web changed or unchanged, compatibility mode, upgrade procedure for breaking releases); then verifies the published assets by running `app deploy` with the tagged CLI into a clean local target and comparing bytes. Releases are marked pre-release until [T16](../verification/T16-external-adoption.md) establishes adoption readiness. Pushing the tag is the owner's release approval.

The release commit (version constant bump) is prepared locally and reviewed like any change; the workflow never edits the repository.

## Exit criteria

- [x] Select the MIT License and add the root `LICENSE`.
- [x] Include project and third-party notices in the web archive.
- [x] Decide one product version series with a CLI-pinned web bundle (2026-10-03).
- [x] Define per-step compatibility promises, reader rules and the `0.x` interpretation.
- [x] Define the automated gate that classifies changes and the release workflow it guards.
- [x] Hand implementation and the `v0.1.0` re-release to [IMP-45](../implementation/IMP-45-unified-release-and-compatibility.md).

## Evidence and limitations

`npm run test:third-party-notices` covers notice generation. The deleted `v0.1.0` pre-release proved the current manual path end to end: clean-clone packaging, `app deploy --version 0.1.0` downloading from GitHub into a clean local target with byte-identical output and a no-op repeat. The new flow's evidence will be recorded here once the workflows exist. Local packaging and synthetic upgrade tests do not prove provider behavior; [T15](../verification/T15-provider-delivery.md) and [T16](../verification/T16-external-adoption.md) remain the gates for live delivery and clean-consumer adoption.
