# TD2 — Licensing, product versioning and data compatibility

- Status: Done
- Phase: Reusable distribution
- Amended by [TD17](TD17-config-pinned-component-versions.md) (2026-10-08): the single product version is split into independent CLI, web and per-Action series, and the web choice moves into the deployment config (IMP-67, IMP-68 and IMP-69 are implemented). Pending amendment (IMP-70): TD17 sections 4, 5a and 6 (bootstrap re-exec, `cli-version` override, Action `release.json` schemaVersion 2) are not implemented yet; until then the published Actions install the CLI named in their generated `release.json` and `cli.version` has no runtime effect.
- Amended: 2026-10-07 — Terraform modules are versioned independently of the product version and released by per-module tags in the monorepo ([TD15](TD15-terraform-module-source-of-truth.md)); the product tag series is unchanged.
- Revised: 2026-10-05 — records that compatibility is not guaranteed while the product is 0.x and the cross-version gate skips those candidates; replaces the earlier web-only SemVer / CLI-by-SHA policy (2026-09-28) with one product version, a CLI-pinned web bundle, a compatibility contract and automated release gates.
- Related implementation: [IMP-45](../implementation/IMP-45-unified-release-and-compatibility.md), [IMP-31](../implementation/IMP-31-app-distribution.md), [IMP-34](../implementation/IMP-34-actions.md), [IMP-35](../implementation/IMP-35-external-adoption.md), [IMP-38](../implementation/IMP-38-terraform-registry-publication.md)
- Related verification: [T16](../verification/T16-external-adoption.md)

## Design questions

1. Which OSS license applies?
2. How are the CLI, composite Actions and web bundle versioned and released? (Amended by TD17: in independent series.)
3. What compatibility does each version step promise for the published data (registry, indexes, artifacts, previews, search data), and how is that promise enforced?

## License (unchanged)

The project owner selected MIT on 2026-09-28. The root `LICENSE` uses `Copyright (c) 2026 tasuku43` and covers first-party work; dependencies keep their upstream licenses. `npm run package:web` copies `LICENSE` and generates `THIRD_PARTY_NOTICES.txt` from the installed production dependency graph and fails when a required license text is missing. No standalone CLI binary was distributed at first. Amended 2026-10-05 ([TD4](TD4-action-marketplace-distribution.md)): each release attaches per-platform CLI binaries for the composite Actions, with a checksums file and `THIRD_PARTY_NOTICES` for the linked Go modules, so the dependency-notice rule is met by the same release.

## Why the policy changed

The first web pre-release was tagged `v0.1.0` at the repository root. The root is also the Go module `github.com/tasuku43/git-artifact-pages`, so any root `vX.Y.Z` tag is the CLI's Go module version as well: `go install …/cli/cmd/artifact-pages@latest` resolves to the newest such tag. A web-only tag series would therefore have (a) published phantom CLI versions on web-only changes and (b) left `@latest` on a stale CLI after CLI-only changes. Independently versioned web and CLI also required a compatibility matrix between every web version and every CLI revision that writes data.

The owner decided (2026-10-03) to ship one product version in which the CLI knows the web bundle it deploys. TD17 (2026-10-07) replaced that decision: prefixed tags remove the phantom-version problem described above, so the CLI, the web bundle and each Action now have their own series, and the deployment config, not the CLI, names the web bundle. The initial `v0.1.0` release and tag (source `6385d57`) were deleted the same day, before any known consumer, and `v0.1.0` will be re-released through the automated flow below. The owner accepted the residual risk that the Go checksum database recorded the deleted tag if anything fetched it in that window; re-pointing would then make `go install …@v0.1.0` fail verification. This was not checked, because querying the module proxy can itself trigger that fetch.

## Settled policy

### Independent version series

Amended 2026-10-08 ([TD17](TD17-config-pinned-component-versions.md)); this replaces the single product version.

| Component | Monorepo tag | Release |
| --- | --- | --- |
| CLI | `vMAJOR.MINOR.PATCH` (root; also the Go module version) | Four platform binaries, `artifact-pages_vX.Y.Z_checksums.txt`, `THIRD_PARTY_NOTICES` and `artifact-pages_vX.Y.Z_compatibility.json` |
| Web app | `web/vX.Y.Z` | `artifact-pages-web-vX.Y.Z.tar.gz`, its `.json` manifest (with `reads`) and `.sha256` |
| Each Action | `publish-action/vX.Y.Z`, `preview-action/vX.Y.Z`, `registry-action/vX.Y.Z`, `app-deploy-action/vX.Y.Z` | No assets: generated repository `artifact-pages/<name>-action`, tagged plain `vX.Y.Z` ([TD14](TD14-one-repository-per-action.md)); the monorepo also gets a release with the tag name |
| Terraform modules | `terraform-cloudflare/vX.Y.Z`, `terraform-aws/vX.Y.Z` | Unchanged ([TD15](TD15-terraform-module-source-of-truth.md)) |

- Because the root series carries only the CLI, a root `vX.Y.Z` tag and the Go module version mean the same thing again; `go install …@latest` resolves to the newest CLI. A release of one component never publishes another. Tag versions are exact `MAJOR.MINOR.PATCH`; the gate checks that CLI and web tags increase over the previous release of their series.
- Only a stable (not `0.x`) CLI release is marked latest on the repository's releases page; all `0.x` releases are pre-releases, and web and Action releases never request latest. Releases stay pre-releases until [T16](../verification/T16-external-adoption.md) establishes adoption readiness.
- The web asset names keep `artifact-pages-web-…`; the component is called `web` in the tag prefix, the config key and the assets.
- **Terraform modules (2026-10-07).** Each module under `terraform/modules/<provider>/` has its own SemVer series, independent of the other series. A per-module monorepo tag syncs the generated package repository and tags plain `vX.Y.Z` there ([TD15](TD15-terraform-module-source-of-truth.md), [IMP-38](../implementation/IMP-38-terraform-registry-publication.md), [IMP-64](../implementation/IMP-64-generate-sync-terraform-packages.md)). A CLI, web or Action release does not sync them, and the compatibility gate below does not apply to them: CLI/module compatibility is pinned by contract tests. (TD15 briefly tagged modules with the product version on 2026-10-06; that is withdrawn.)
- **Immutability.** From the first non-pre-release, tags and release assets are never moved or replaced after a release is consumed; corrections ship as a new version. **Carve-out for `0.x` (TD17):** while a series is `0.x`, tags and releases may be deleted and re-created, and the Action sync may replace an existing Action tag whose content changed (an identical re-run is a no-op; a stable tag is never moved). The pre-consumption `v0.1.0` withdrawal described above is the older, narrower precedent. Each series starts at `0.1.0`.

### The config pins the CLI and the web bundle

- The CLI source holds its version as a constant (`cli/internal/version`). The release commit sets it; `-ldflags` are not used because `go install` and the Actions' `go build` cannot pass them. `artifact-pages version` prints the CLI version, the module version and sum, the Go version and the VCS revision recorded in the Go build info.
- The operator config names the web bundle with `web.version` (and the intended CLI with `cli.version`; see the pending note in the header for what `cli.version` does today). `artifact-pages app deploy` downloads release `web/vX.Y.Z` of `artifact-pages/artifact-pages` and verifies archive, manifest and checksum before writing; other repositories are rejected. Versions are exact; ranges, `latest` and pre-release suffixes are rejected. `--archive FILE` remains for local and pre-release bundles. The `--version` option and the admin Action's `version` input are removed.
- **Legacy fallback.** A config with neither `cli` nor `web` whose storage has no app version record keeps the older behavior: `app deploy` downloads the bundle of the CLI's own version from root release `vX.Y.Z` and performs no format check. Root releases made after the series split carry no web assets, so this path resolves only for earlier single-series releases; otherwise use `web.version` or `--archive`.
- Pinning no longer pins a "tested CLI/web pair". Compatibility is checked from data instead: the web manifest lists the formats the web reads, the CLI knows the formats it writes, and storage records what is actually deployed and written (specification §5.3 Version records, §22). Deployment stays explicit: a new tag, a CLI upgrade or a config change never deploys the app by itself.
- A web-only change is a new `web/v*` release and needs no CLI or Action release; a CLI-only change releases only the CLI. Web release notes state whether the bundle changed since the previous `web/v*` release, computed by comparing release manifests and file digests.
- Satellites no longer choose the CLI: the deployment config does, and the data-driven checks make a mismatch visible. Pending amendment (IMP-70): until the bootstrap lands, each published Action still installs the CLI named in its own `release.json`, so a satellite follows its Action pin.

### Data formats and compatibility

Each published format carries an integer `schemaVersion`. A format's version changes only for a breaking change to that format; additive changes keep it. The formats are the registry (`/_indexes/sites.json`), site metadata (`meta.json`), the artifact index (`index.json`), preview catalogs and revision manifests, full-text search data, and the CLI's control records (locks, cleanup and cache records, and the three version records `/_control/versions/app.json`, `/_control/versions/registry.json` and `/_control/sites/<site>/versions.json`). The full-text manifest's `version` field is renamed to `schemaVersion` for consistency in the next breaking change to that format, or earlier if it can be done compatibly.

Readers must:

- ignore unknown fields (no exact-key validation);
- treat a missing optional field as the feature being unavailable (for example no `fullTextUrl` → no page text search);
- treat an unknown `schemaVersion` as a confirmed but unreadable format: the web shows a "this site needs to be republished" state instead of an error or a misread page, and the CLI fails with a message naming the required action.

One storage can hold data written by several CLI versions and read by one web version, so the promises below are written for that mixed state.

| Step | Data formats | Promise | Required operator action |
| --- | --- | --- | --- |
| MAJOR | A `schemaVersion` may increase | None across the step. The new web reads only the new formats and shows "needs to be republished" for old ones. | Upgrade in order: `registry sync --accept-breaking`, `app deploy --accept-breaking`, then republish every site with the new CLI. Release notes give the procedure. |
| MINOR | Additive only; no `schemaVersion` change | Within the major version, any web reads data from any CLI, newer or older; any CLI reads and updates data written by any other. | None. Republish a site to use a new feature. |
| PATCH | No format change | Fully compatible fixes. | None. Run `app deploy` when `web.version` moved to a new web release. |

While a CLI or web series is `0.x`, no cross-version compatibility is promised: any `0.x` release may change published formats, including a patch release. The data-driven checks (specification §22) still run and are then the only guard; version numbers are never used to infer compatibility. Tag versions must still be valid SemVer, and CLI and web tags must increase over the previous release of their series. Starting with `1.0.0`, the table above applies and the compatibility gate checks a candidate against the previous release of its series.

### Automated release and compatibility gates

For candidates at or above `1.0.0`, breaking versus compatible is decided by the data, not by a person waiving a red check. Each series has its own baseline:

- **CLI candidates (root `vX.Y.Z`)** are compared with the previous root release. The gate builds the CLI at that tag (the baseline) and at the candidate, runs both on the same fixture sources, and compares the `schemaVersion` of every format each produces. The legacy root `v0.1.0` of the earlier single series is an ordinary earlier CLI release for this purpose.
- **Web candidates (`web/vX.Y.Z`)** are compared with the previous `web/v*` release by their reader declarations (`reads`): removing a `schemaVersion` the previous web read is breaking and, from `1.0.0`, requires a MAJOR increase; adding versions is compatible. The legacy root `v0.1.0` is not the first web baseline, so the first `web/v*` release has none.
- **Action tags** have no tag/version check and no data-format gate of their own (the `Verify` run for an Action tag has no tag input, so it runs the same pull-request style gate against the latest release); they are checked by the generated-content comparison described in TD14.

A candidate below `1.0.0` skips the cross-version comparison before building either CLI; its report records `verdict: skipped`, `result: skipped`, and that no 0.x compatibility guarantee applies. This does not skip the ordinary Go, type, browser, Action, or release-preflight checks.

For a CLI candidate:

- **Compatible** (no `schemaVersion` changed): the mixed-version suite must pass —
  - candidate web reading baseline-written data (app deployed before satellites upgrade);
  - baseline web reading candidate-written data (satellites upgrade before the app);
  - one storage holding sites written by both CLIs, with registry, previews and search data;
  - each CLI republishing, previewing, locking and recovering over the other's output.
  Each combination runs a browser smoke: site picker, HTML and Markdown artifacts, page text search on a search-enabled site, preview list and document.
- **Breaking** (some `schemaVersion` changed): the suite switches to upgrade checks — the candidate web shows "needs to be republished" for baseline data without crashing, and the documented upgrade procedure converges to a fully working storage.
- A required control-only format added by the candidate is also a breaking format change, even when no public web schema changes. The gate recognizes `/_control/publish-state/<site>.json.gz` as a private publisher format; a required format present only in the candidate cannot be treated as optional.
- **Version consistency** on a tag: a root tag must match the CLI version constant, and every CLI or web tag must increase over the previous release of its series. For `0.x`, the compatibility skip waives format-position rules only; it does not waive those version checks. From `1.0.0`, a breaking result requires a MAJOR increase; a MAJOR increase without a format change is allowed.

Two GitHub Actions workflows implement this:

1. **Pull requests and pushes to `main`:** unit, type and browser tests plus the gate against the latest release. The gate reports skipped when there is no baseline release or the candidate is `0.x`; ordinary candidate tests still run.
2. **Tag push `v*`, `web/v*` or `<name>-action/v*`:** a preflight accepts only these exact forms, checks that a root tag equals the CLI version constant and that the commit is on `main`, resolves the previous release of the same series, and compares generated Action content with each Action's previous tag (an unchanged tagged Action fails; a changed untagged one warns). The full test suite and the gate then run for CLI and web tags with the tag, including the explicit 0.x skip report; for Action tags the same suite and the pull-request style gate against the latest release run without a tag, so no version or data-format check applies. Then, per component:
   - **CLI:** build the four binaries, checksums, notices and the compatibility file, create the GitHub release with generated notes (compatibility result, and an upgrade procedure when required by a breaking result), then verify the published assets: checksums, the binary's reported version, and that its `compatibility --format json` output equals the published file.
   - **Web:** package the archive from the tagged commit, check that the manifest records a clean source tree and exactly that commit, create the release with the three assets and notes (bundle changed or unchanged since the previous `web/v*`, compatibility result), then verify by running `app deploy` with the tagged source's CLI into a clean local target and comparing bytes.
   - **Action:** after the gate, check that the CLI release named by the generated `release.json` exists with matching checksums, sync the selected generated repository and tag, and record a release in the monorepo.
   Releases are marked pre-release while `0.x` and latest only for a stable CLI. Pushing the tag is the owner's release approval.

The CLI release commit (version constant bump) is prepared locally and reviewed like any change. Web and Action versions are given by their tags alone. The workflow never edits the repository.

## Exit criteria

- [x] Select the MIT License and add the root `LICENSE`.
- [x] Include project and third-party notices in the web archive.
- [x] Decide one product version series with a CLI-pinned web bundle (2026-10-03).
- [x] Define per-step compatibility promises, reader rules and the `0.x` interpretation.
- [x] Define the automated gate that classifies changes and the release workflow it guards.
- [x] Hand implementation and the `v0.1.0` re-release to [IMP-45](../implementation/IMP-45-unified-release-and-compatibility.md).
- [x] Split the single product version into independent CLI, web and Action series and move the web bundle choice into the deployment config ([TD17](TD17-config-pinned-component-versions.md); IMP-67 to IMP-69 behavior described above, 2026-10-08).
- [ ] Describe the bootstrap CLI re-exec and the `cli-version` override once they ship ([IMP-70](../implementation/IMP-70-bootstrap-cli-and-override.md), [IMP-71](../implementation/IMP-71-td17-spec-and-guides.md)).

## Known gate limits and release runbook

- The gate classifies formats from what a completed run leaves in storage. Control records that a successful run removes or never writes (locks after release and registry-cleanup records) are not compared. It recognizes required per-site publish-state roots as a private control format; adding or removing that required format is breaking even when public formats are unchanged. Other transient control-record changes still require explicit review. Compatible-mode cross-CLI checks cover republish, preview and `lock inspect`, not `lock recover`.
- **Historical pre-release decision (2026-10-04):** the owner authorized `v0.2.0` to replace private publish-state controls without legacy compatibility proof. On 2026-10-05, the policy was broadened: compatibility is not promised for any `0.x` release, and the cross-version gate skips those candidates. The earlier decision is retained as historical evidence, not a one-off current exception.
- Each web build is smoke-tested with the compatibility spec from its own tree, so the spec's environment contract (`PLAYWRIGHT_BASE_URL`, `COMPAT_MODE`, `COMPAT_SITES`, `COMPAT_EXPECT`) must stay stable across releases.
- If the tag workflow fails after the release was created (post-publication verification), the release stays published. While no consumer can have used it (minutes after creation, still a pre-release), delete the release and tag, fix, and push the tag again; otherwise leave it, mark it superseded in its notes, and ship a new patch version.

The 0.x skip applies only to cross-version compatibility checking. It does not disable the candidate's normal test suite, version/tag preflight, release packaging checks, or post-package verification. From 1.0.0, the cross-version gate is active.

## Supply chain

Decided 2026-10-03 for `v0.1.2`, after two independent dependency and toolchain audits.

- **Toolchain.** Both Go modules keep `go 1.26.0` as the language floor and add `toolchain go1.26.7`. `actions/setup-go` (pinned v7.0.0) reads the `toolchain` line of `go.mod` when `GOTOOLCHAIN` is not already `local`, then sets `GOTOOLCHAIN=local` for the job. Without the line it installed exactly `go1.26.0`, which has reachable standard-library vulnerabilities. Raising `go` itself was rejected because it would force every `go install` consumer onto the newer language version. Because `setup-go` exports `GOTOOLCHAIN=local` to later steps, each composite Action's `setup-go` step sets `GOTOOLCHAIN: auto` in its own `env` so a second Action in the same job still honors the `toolchain` line.
- **Vulnerability scanning.** `govulncheck` (pinned version, run through `go run`) runs in the `Verify` test job, so every pull request and push to `main` is checked, and in a weekly scheduled workflow on `main` so new advisories surface without a code change.
- **Dependabot.** Version updates are off (`open-pull-requests-limit: 0`) for Go modules and npm; only security updates open pull requests, with the AWS SDK modules grouped. GitHub Actions references get monthly updates. The owner must enable "Dependabot security updates" in the repository settings; the configuration file alone does not.
- **Dependencies removed.** The JavaScript module parser (`tdewolff/parse`) is gone; preview resource collection uses the in-repo scanner only. YAML moved from a release-candidate library to `go.yaml.in/yaml/v3` (stable); duplicate keys are rejected by an explicit node walk in `cli/internal/config`.
- **Build identity.** `artifact-pages version` shows the module version and sum and the Go version, so a user can match a binary to a released module.
- **Not adopted now.** `-trimpath`, `CGO_ENABLED=0` and `-mod=readonly` on the verification build (no distributed binary, so no reproducibility claim to protect); raising the `go` directive; CODEOWNERS and branch protection (single-maintainer repository).
- **Owner action.** Create a tag ruleset protecting `v*` from deletion and force-update, so a published version cannot be re-pointed (the Go checksum database would then reject it).

## Evidence and limitations

`npm run test:third-party-notices` covers notice generation. The deleted `v0.1.0` pre-release proved the current manual path end to end: clean-clone packaging, `app deploy --version 0.1.0` downloading from GitHub into a clean local target with byte-identical output and a no-op repeat. The new flow's evidence will be recorded here once the workflows exist. Local packaging and synthetic upgrade tests do not prove provider behavior; [T15](../verification/T15-provider-delivery.md) and [T16](../verification/T16-external-adoption.md) remain the gates for live delivery and clean-consumer adoption.
