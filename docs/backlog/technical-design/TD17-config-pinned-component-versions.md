# TD17 — Config-pinned CLI and web versions, independently versioned components

- Status: Done
- Assignee: Claude
- Phase: Reusable distribution
- Decision: Proposed and decided by the owner on 2026-10-07. The specification, TD2 and TD14 are amended for the implemented slices (IMP-67, IMP-68 and IMP-69, on 2026-10-08); and for IMP-70 (sections 4, 5, 5a and 6: bootstrap re-exec, `cli-version` override, Action `release.json` schemaVersion 2) with the IMP-70 pull request. All amendments are applied. The specification is authoritative for what ships.
- Amends: [TD2](TD2-component-release-policy.md) (one product version; CLI-pinned web bundle and "pinning an Action or CLI ref pins a tested CLI/web pair", replaced by the checks of section 3; web-changed release notes move to web releases; immutable tags during 0.x), [TD14](TD14-one-repository-per-action.md) (decision 2 one tag for all Actions; decision 4 Action version decides the CLI version; the sync rule "an existing tag is never moved" during 0.x), specification §19 "Released CLI" and "Action repositories", and §22 (config keys, `app deploy` bundle selection)
- Related design: [TD15](TD15-terraform-module-source-of-truth.md) (per-module tags, the model reused here), [TD12](TD12-action-consumer-contract.md), [T10](T10-config-location.md) (config layers)

## Problem

TD2 ties three things to one version: the CLI, the web bundle and the four Actions. The Action version decides the CLI version, and the CLI version decides the web bundle `app deploy` installs. In practice this has costs:

- **Every site upgrades on its own.** Each satellite repository pins an Action tag, so moving the deployment to a new CLI means a pin bump in every site repository. The operator who owns the storage, the registry and the app cannot say "this deployment runs CLI X" in one place.
- **Releases carry unrelated components.** A web-only fix publishes a new CLI and four new Action tags with identical behavior; an Action-only fix publishes a new CLI and web bundle.
- **The compatibility matrix exists anyway.** TD2 already assumes one storage holds data written by several CLI versions and read by one web version. Compatibility is carried by `schemaVersion` and the reader rules, not by the shared version number.

The original reason for one series (TD2 "Why the policy changed") was that the root `vX.Y.Z` tag is also the Go module version, so a web-only tag series would publish phantom CLI versions. Prefixed tags, as TD15 introduced for the Terraform modules, remove that reason: if the root series carries only the CLI, the tag and the Go module version mean the same thing again.

## Design

### 1. Independent version series

| Component | Monorepo tag | Published as |
| --- | --- | --- |
| CLI | `vX.Y.Z` (root, the Go module version) | Release with per-platform binaries, checksums, notices (unchanged) |
| Web app | `web/vX.Y.Z` | Release with the archive, manifest and `.sha256` (no separate repository: consumers download assets, nothing references a repository) |
| Each Action | `publish-action/vX.Y.Z`, `preview-action/vX.Y.Z`, `registry-action/vX.Y.Z`, `app-deploy-action/vX.Y.Z` | Generated repository `artifact-pages/<name>-action`, tagged plain `vX.Y.Z` (TD14 sync, triggered per Action) |
| Terraform modules | `terraform-<provider>/vX.Y.Z` | Unchanged (TD15) |

- **Per-Action tags.** Once an Action no longer decides the CLI, its version describes only its own wrapper (inputs, outputs, summary, checkout). A change to one Action releases only that Action. A change under `actions/shared/` releases every Action whose generated content changed. The release workflow compares generated content: tagging an Action whose content did not change fails (it would publish an empty release), while a changed but untagged Action only warns (it may be released later on purpose).
- Only CLI releases are marked "latest" on the monorepo's releases page; web and Action releases set `make_latest: false`.
- The component is called `web` everywhere (tag prefix, config key, asset names `artifact-pages-web-…`). The command `app deploy` and the term "application plane" keep their names.

### 2. The deployment config names the CLI and the web app

```yaml
schemaVersion: 1
cli:
  version: 0.3.0   # every Action and the CLI itself run this version
web:
  version: 0.2.1   # the bundle `app deploy` installs
provider: cloudflare
...
```

- The operator's config (the `admin` repository for `artifact-pages.dev`) is the single place that decides which CLI and web app a deployment runs. Sites follow it on their next sync or preview without touching their own repositories.
- Versions are exact release versions `MAJOR.MINOR.PATCH`; pre-release and build suffixes are rejected. Ranges and `latest` are rejected: the deployment must be reproducible from the config history, and a rollback is a revert. Keeping both versions current is the operator repository's own concern (for example a Dependabot-style update); the product does not open those pull requests.
- Download sources are not configurable. The CLI is always fetched from release `vX.Y.Z` of `artifact-pages/artifact-pages`, the web app from `web/vX.Y.Z`, both checksum-verified. Whoever can edit the config can therefore choose among official releases only, never an arbitrary binary that would run in every site's CI with that site's credentials.
- `app deploy` installs `web.version` instead of the bundle of the CLI's own version. `--archive FILE` remains for local and unreleased bundles.

### 3. Storage records versions; the CLI knows compatibility and validates it

Compatibility data travels with each release; the comparison lives in the CLI.

- **CLI:** the binary embeds the config `schemaVersion`s it reads and, per published format, the `schemaVersion` it writes. The release also publishes this as a small JSON asset.
- **Web:** the web release manifest lists, per published format, the `schemaVersion`s the web app reads.

Storage records what is actually deployed, so checks can compare with reality and not only with the config:

- `app deploy` records the deployed web version and its readable formats in `/_control/versions/app.json`.
- `site sync` and `preview publish` record, per site, the CLI version that last wrote it and the format `schemaVersion`s it wrote, in `/_control/sites/<site>/versions.json` (the per-site control prefix of IMP-66). `registry sync` records the same in `/_control/versions/registry.json`.
- All three are new control records with `schemaVersion: 1`, written in the same locked operation as the data they describe. Data written before this design has no record and counts as **unknown**: checks list unknown sites instead of treating them as compatible, and a republish creates the record.

The checks, all failing before any write:

| Command | Checks |
| --- | --- |
| `config check` (new; for operator pull requests that change `cli.version` or `web.version`) | The CLI reads the config's `schemaVersion`; `web.version` reads every format this CLI writes; `web.version` reads every format the per-site records say is in storage (sites it cannot read are listed as needing a republish). |
| `app deploy` | The bundle to deploy reads every format recorded in storage for the stored registry and every site it lists. Otherwise it fails and names the sites (unreadable and unknown), so a web upgrade never silently turns live sites into "needs to be republished"; `--accept-breaking` accepts that outcome for a planned breaking upgrade (step 2). |
| `site sync`, `preview publish`, `registry sync` | The deployed web (from storage) reads every format this CLI writes. This catches the window where the config already names a new CLI but `app deploy` has not run or failed, and a web deployed outside the config. If no web version is recorded yet (first deploy, or storage from before this design), the check falls back to `web.version`. Of these three only `registry sync` takes `--accept-breaking`: it lets `registry sync` write a format the deployed web cannot read, for step 1 of a planned breaking upgrade. |

Existing data written by a newer CLI is still guarded by the reader rule (an unknown control-record `schemaVersion` makes the CLI fail). The per-site records also let the operator see which CLI wrote each site.

While the product is `0.x` no compatibility is promised, so these data-driven checks are the only guard; version numbers are never used to infer compatibility.

`--accept-breaking` exists only on `registry sync` (accepts a deployed web that cannot read the formats the CLI writes) and `app deploy` (accepts stored sites and a registry that the new web cannot read, unknown ones included). It never overrides an unsupported version-record `schemaVersion` or an incomplete record.

**Implementation notes (IMP-69, 2026-10-08).** The implementation adds the following to the design above; the specification (§5.3 Version records, §11, §22) is authoritative.

- Records can be incomplete: `pending: true`, and for writers `pendingWrites`, are staged before the origin changes and replaced by the final record afterwards. Incomplete records count as unknown, and a retry of the same operation repairs them.
- `preview publish` validates every retained revision manifest of the site, including revisions absent from the catalog, before it certifies the site's preview formats; a preview-only write never certifies production data that has no record.
- Locks: `app deploy` takes the application lock, then the registry lock, then every registered site's lock in sorted order; `registry sync` takes the locks of the sites it changes or omits in sorted order before it mutates the catalog and validates their records under the locks.
- `app remove` also deletes `/_control/versions/app.json`.
- Legacy path: a config with neither `cli` nor `web` and storage without an app record keeps the unpinned flow (own-version bundle, no checks); an existing app record always turns the checks on.
- `config check` requires `web.version` and checks the web manifest's `reads`, this CLI's writes and the stored records; it runs under the CLI that `cli.version` selects (IMP-70), so the check does not compare `cli.version` with the running CLI itself.
- The CLI publishes `artifact-pages compatibility --format json`, and the CLI release carries the same output as `artifact-pages_vX.Y.Z_compatibility.json`.
- The Cloudflare read-only registry credential reads `app.json`, and the AWS satellite policy gets exactly that key (read-only).

### 4. Overriding the CLI version

An Action input `cli-version` (and the equivalent CLI flag or environment variable) runs a different CLI than the config names, for trying a release in one site or for an emergency. An override never bypasses validation:

- the Action checks the version against the CLI range it supports (below);
- the overriding CLI runs exactly the checks of section 3 against the same config and the same recorded storage state, and fails the run if any check fails;
- the job summary always records that an override was used and which version ran.

### 5. Actions declare the CLI range they support

Each Action's generated `release.json` gains a supported CLI range (for example `>=0.3.0 <0.5.0`). The Action fails before running the CLI when the resolved version is outside it, naming both versions. The range is the Action ↔ CLI interface contract (arguments, `--format json` result shape); keeping the Actions thin keeps the range wide.

### 5a. Bootstrap and override contract

- **`release.json` (schemaVersion 2):** `actionVersion` (this Action's own version), `bootstrapCli` (the CLI release the Action installs first), `cliRange` (the supported range), `repository` (the CLI release repository, fixed to `artifact-pages/artifact-pages`). `bootstrapCli` must lie inside `cliRange`.
- **Override names:** Action input `cli-version`, CLI flag `--cli-version`, environment variable `ARTIFACT_PAGES_CLI_VERSION`. Precedence: flag, then environment, then input (the Action passes the input as the environment variable), then config `cli.version`. An override replaces the re-exec target; it does not skip validation.
- **Resolution:** the bootstrap merges all config layers (T10) and reads `cli.version` from the merged result; the "at most one layer" rule is checked during the merge. The parse of `cli.version` tolerates unknown fields and any config `schemaVersion`, so an older bootstrap can still find the target.
- **Range:** if the target is outside `cliRange`, the bootstrap fails before downloading, naming both versions.
- **Download and cache:** the target is fetched exactly as the published Actions fetch the CLI today (unauthenticated, checksum-verified, rate-limit retry through the GitHub API with the workflow token only, passed as `ARTIFACT_PAGES_DOWNLOAD_TOKEN`). The private-config `github-token` is used only to read the config and never for downloads. Binaries are cached per version under the runner tool cache (locally under the user cache directory).
- **No loop:** the re-exec sets `ARTIFACT_PAGES_CLI_RESOLVED=<version>`. A CLI started with it never resolves or re-executes again; it fails if its own version differs.
- **Tests:** `ARTIFACT_PAGES_TEST_CLI` (unreleased Action source only) skips the bootstrap and the re-exec; the test binary runs directly and still runs the checks of section 3.

**Implementation notes (IMP-70).** The implementation adds the following; the specification (§19 "Released CLI", §22) is authoritative.

- The range check runs in the CLI (the Action passes `cliRange` as `ARTIFACT_PAGES_CLI_RANGE`), for the config target and for an override alike, before any download; the Action itself only validates (`requireCliRange`) that `bootstrapCli` lies inside `cliRange`, and a failure there fails the install step with exit 1 and the "installation failed" summary. The CLI-side range failure exits 2.
- Only deployment commands (`app`, `site`, `registry`, `preview`, `lock`, `config check`) resolve the config; other commands run as installed unless an override is given. A config without `cli.version` selects the running CLI.
- The checksums file is fetched on every use, including cache hits, and a cached binary must match it.
- The generator writes `bootstrapCli` and `cliRange` as fixed values (`0.1.0`, `>=0.1.0 <0.2.0`), not from the CLI version constant; the generated-content comparison ignores `actionVersion`.
- A new Action tag must exceed the highest tag already published in that Action's repository (checked by the release preflight).
- Job Summary lines record the executing CLI and any override; an Action input override is reported as `environment`.
- **Preview trust:** the preview Action resolves and downloads the target only after its trust preflight, from the same config the preflight uses (the base ref or the operator's config, never the pull-request head). Because sources are fixed to official releases, the choice of version cannot introduce foreign code, but a pull request still cannot change it.
- **Config keys and old CLIs:** the strict config parser rejects unknown fields, so `cli` and `web` become valid in the CLI release that implements this design. That release is the lower bound of every Action's `cliRange`, and operator configs add the keys only after their Actions move to it.

### 6. Resolving the version before a CLI is installed

The Action needs `cli.version` before it has a CLI, and the config may be layered and remote (T10 locators, private config via `github-token`). Two ways:

- **(a) Bootstrap CLI, recommended.** The Action installs `bootstrapCli` from its `release.json` (section 5a) as a bootstrap. The CLI resolves the config; if `cli.version` differs from its own version, it downloads that release, verifies it and re-executes it with the same arguments (the model of Go's `toolchain` line). Config resolution stays in one implementation, and local runs follow the config the same way CI does. Constraint: reading `cli.version` must stay stable across config `schemaVersion`s, so an old bootstrap can still find the version that understands a newer config.
- **(b) Action-side parse.** The Action reads `cli.version` itself (for example with `yq`). Rejected unless (a) proves impractical: it duplicates locator and layer resolution in JavaScript.

### 7. Upgrade flow for an operator

1. The operator repository gets a pull request that bumps `cli.version` or `web.version` (its own automation, for example Dependabot-style; outside the product).
2. That pull request's CI runs `config check`.
3. On merge, `registry sync` runs, and `app deploy` runs when `web.version` changed.
4. Sites use the new CLI on their next `site sync` or preview.
5. For a breaking format change, the operator repository runs TD2's order from one place: `registry sync --accept-breaking`, `app deploy --accept-breaking`, then a republish of every site. Readers see "needs to be republished" until each site is republished, as TD2 already accepts for a MAJOR step.

## Decisions (owner, 2026-10-07)

- The component name is `web` (tag `web/vX.Y.Z`, config key `web`).
- Storage records the deployed web version and, per site, the writing CLI version and formats; checks compare with storage (section 3).
- Bump pull requests in operator repositories are the operator's concern, not the product's.
- Config layers: `cli` and `web` may be set by at most one config layer; a second layer that sets either (even to the same value) is a config error (exit 2). `web` is deployment-wide, and a per-site `cli` layer would only add a persistent way to drift from the operator's choice. Deviating is possible only through the explicit override of section 4 (CLI flag, environment variable or Action input), which is validated and reported.
- New series start at `0.1.0`.
- While the product is pre-release (`0.x`), tags and releases may be deleted and re-created freely; TD2's "never moved" rule and TD14's sync rule ("an existing tag is never moved") apply from the first non-pre-release; until then the Action sync may replace a tag. The Action repositories' existing `v0.1.0` tags (product release) are therefore deleted and re-created as the first per-Action `v0.1.0`; `admin` and `docs` repin in the same rollout.

## Implementation slices (filed as [IMP-67](../implementation/IMP-67-web-compatibility-manifest.md) to [IMP-72](../implementation/IMP-72-td17-first-releases-and-rollout.md))

- CLI: `cli`/`web` config keys, storage version records, compatibility data and `config check`, validation at command start, `app deploy` by `web.version` (Codex): Done, [IMP-69](../implementation/IMP-69-config-pins-and-compatibility-checks.md); the web manifest's `reads` is [IMP-67](../implementation/IMP-67-web-compatibility-manifest.md), Done. Bootstrap re-exec: [IMP-70](../implementation/IMP-70-bootstrap-cli-and-override.md) (PR #58).
- Release workflows: root tag CLI-only, `web/v*` and per-Action tags, generated-content check (Codex): Done, [IMP-68](../implementation/IMP-68-release-series-split.md).
- Actions: `cli-version` input, supported range in `release.json`, summary line for overrides (Codex): [IMP-70](../implementation/IMP-70-bootstrap-cli-and-override.md) (PR #58).
- Specification §19 and §22, TD2 and TD14 amendments, operator upgrade guide (Claude): [IMP-71](../implementation/IMP-71-td17-spec-and-guides.md), In progress. The specification, TD2 and TD14 describe IMP-67 to IMP-70; the operator guide follows.
- Operator repositories: add `cli`/`web` to `admin/artifact-pages.yaml` (Codex, owner approval for production): [IMP-72](../implementation/IMP-72-td17-first-releases-and-rollout.md).
