# TD17 — Config-pinned CLI and web versions, independently versioned components

- Status: Done
- Assignee: Claude
- Phase: Reusable distribution
- Decision: Proposed and decided by the owner on 2026-10-07. Accepted behavior moves to the specification, TD2 and TD14 with the implementation slices below.
- Amends (when implemented): [TD2](TD2-component-release-policy.md) (one product version, CLI-pinned web bundle, immutable tags during 0.x), [TD14](TD14-one-repository-per-action.md) (Action version decides the CLI version), specification §19 "Released CLI" and §22 (`app deploy` bundle selection)
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

- **Per-Action tags.** Once an Action no longer decides the CLI, its version describes only its own wrapper (inputs, outputs, summary, checkout). A change to one Action releases only that Action. A change under `actions/shared/` releases every Action whose generated content changed; the release workflow compares generated content and fails when a tagged Action is unchanged or warns when a changed Action is left untagged.
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
- Versions are exact SemVer. Ranges and `latest` are rejected: the deployment must be reproducible from the config history, and a rollback is a revert. Keeping both versions current is the operator repository's own concern (for example a Dependabot-style update); the product does not open those pull requests.
- Download sources are not configurable. The CLI is always fetched from release `vX.Y.Z` of `artifact-pages/artifact-pages`, the web app from `web/vX.Y.Z`, both checksum-verified. Whoever can edit the config can therefore choose among official releases only, never an arbitrary binary that would run in every site's CI with that site's credentials.
- `app deploy` installs `web.version` instead of the bundle of the CLI's own version. `--archive FILE` remains for local and unreleased bundles.

### 3. Storage records versions; the CLI knows compatibility and validates it

Compatibility data travels with each release; the comparison lives in the CLI.

- **CLI:** the binary embeds the config `schemaVersion`s it reads and, per published format, the `schemaVersion` it writes. The release also publishes this as a small JSON asset.
- **Web:** the web release manifest lists, per published format, the `schemaVersion`s the web app reads.

Storage records what is actually deployed, so checks can compare with reality and not only with the config:

- `app deploy` records the deployed web version and its readable formats in a control record of the application plane.
- `site sync` and `preview publish` record, per site, the CLI version that last wrote it and the format `schemaVersion`s it wrote. `registry sync` records the same for the registry.

The checks, all failing before any write:

| Command | Checks |
| --- | --- |
| `config check` (new; for operator pull requests that change `cli.version` or `web.version`) | The CLI reads the config's `schemaVersion`; `web.version` reads every format this CLI writes; `web.version` reads every format the per-site records say is in storage (sites it cannot read are listed as needing a republish). |
| `app deploy` | The bundle to deploy reads every format recorded in storage for every registered site and the registry. Otherwise it fails and names the sites, so a web upgrade never silently turns live sites into "needs to be republished"; an explicit flag accepts that outcome for a planned breaking upgrade. |
| `site sync`, `preview publish`, `registry sync` | The deployed web (from storage) reads every format this CLI writes. This catches the window where the config already names a new CLI but `app deploy` has not run or failed, and a web deployed outside the config. If no web version is recorded yet, the check falls back to `web.version`. |

Existing data written by a newer CLI is still guarded by the reader rule (an unknown control-record `schemaVersion` makes the CLI fail). The per-site records also let the operator see which CLI wrote each site.

While the product is `0.x` no compatibility is promised, so these data-driven checks are the only guard; version numbers are never used to infer compatibility.

### 4. Overriding the CLI version

An Action input `cli-version` (and the equivalent CLI flag or environment variable) runs a different CLI than the config names, for trying a release in one site or for an emergency. An override never bypasses validation:

- the Action checks the version against the CLI range it supports (below);
- the overriding CLI runs exactly the checks of section 3 against the same config and the same recorded storage state, and fails the run if any check fails;
- the job summary always records that an override was used and which version ran.

### 5. Actions declare the CLI range they support

Each Action's generated `release.json` gains a supported CLI range (for example `>=0.3.0 <0.5.0`). The Action fails before running the CLI when the resolved version is outside it, naming both versions. The range is the Action ↔ CLI interface contract (arguments, `--format json` result shape); keeping the Actions thin keeps the range wide.

### 6. Resolving the version before a CLI is installed

The Action needs `cli.version` before it has a CLI, and the config may be layered and remote (T10 locators, private config via `github-token`). Two ways:

- **(a) Bootstrap CLI, recommended.** The Action installs the CLI named in its `release.json` as a bootstrap. The CLI resolves the config; if `cli.version` differs from its own version, it downloads that release, verifies it and re-executes it with the same arguments (the model of Go's `toolchain` line). Config resolution stays in one implementation, and local runs follow the config the same way CI does. Constraint: reading `cli.version` must stay stable across config `schemaVersion`s, so an old bootstrap can still find the version that understands a newer config.
- **(b) Action-side parse.** The Action reads `cli.version` itself (for example with `yq`). Rejected unless (a) proves impractical: it duplicates locator and layer resolution in JavaScript.

### 7. Upgrade flow for an operator

1. The operator repository gets a pull request that bumps `cli.version` or `web.version` (its own automation, for example Dependabot-style; outside the product).
2. That pull request's CI runs `config check`.
3. On merge, `registry sync` runs, and `app deploy` runs when `web.version` changed.
4. Sites use the new CLI on their next `site sync` or preview.
5. For a breaking format change, the operator repository runs TD2's order (registry, app, then a republish of every site) from one place.

## Decisions (owner, 2026-10-07)

- The component name is `web` (tag `web/vX.Y.Z`, config key `web`).
- Storage records the deployed web version and, per site, the writing CLI version and formats; checks compare with storage (section 3).
- Bump pull requests in operator repositories are the operator's concern, not the product's.
- Config layers: `cli` and `web` may be set by at most one config layer; a second layer that sets either (even to the same value) is a config error (exit 2). `web` is deployment-wide, and a per-site `cli` layer would only add a persistent way to drift from the operator's choice. Deviating is possible only through the explicit override of section 4 (CLI flag, environment variable or Action input), which is validated and reported.
- New series start at `0.1.0`.
- While the product is pre-release (`0.x`), tags and releases may be deleted and re-created freely; TD2's "never moved" rule applies from the first non-pre-release. The Action repositories' existing `v0.1.0` tags (product release) are therefore deleted and re-created as the first per-Action `v0.1.0`; `admin` and `docs` repin in the same rollout.

## Implementation slices (to file as IMP items; owners per the agent split)

- CLI: `cli`/`web` config keys, storage version records, compatibility data and `config check`, validation at command start, bootstrap re-exec, `app deploy` by `web.version` (Codex).
- Release workflows: root tag CLI-only, `web/v*` and per-Action tags, generated-content check (Codex).
- Actions: `cli-version` input, supported range in `release.json`, summary line for overrides (Codex).
- Specification §19 and §22, TD2 and TD14 amendments, operator upgrade guide (Claude).
- Operator repositories: add `cli`/`web` to `admin/artifact-pages.yaml` (Codex, owner approval for production).
