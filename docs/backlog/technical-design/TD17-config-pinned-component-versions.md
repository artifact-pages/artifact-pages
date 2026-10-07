# TD17 — Config-pinned CLI and app versions, independently versioned components

- Status: In progress
- Assignee: Claude
- Phase: Reusable distribution
- Proposed: 2026-10-07 by the owner (draft for decision; nothing below is accepted behavior yet)
- Would amend: [TD2](TD2-component-release-policy.md) (one product version, CLI-pinned web bundle), [TD14](TD14-one-repository-per-action.md) (Action version decides the CLI version), specification §19 "Released CLI" and §22 (`app deploy` bundle selection)
- Related design: [TD15](TD15-terraform-module-source-of-truth.md) (per-module tags, the model reused here), [TD12](TD12-action-consumer-contract.md), [T10](T10-config-location.md) (config layers)

## Problem

TD2 ties three things to one version: the CLI, the web bundle and the four Actions. The Action version decides the CLI version, and the CLI version decides the web bundle `app deploy` installs. In practice this has costs:

- **Every site upgrades on its own.** Each satellite repository pins an Action tag, so moving the deployment to a new CLI means a pin bump in every site repository. The operator who owns the storage, the registry and the app cannot say "this deployment runs CLI X" in one place.
- **Releases carry unrelated components.** A web-only fix publishes a new CLI and four new Action tags with identical behavior; an Action-only fix publishes a new CLI and web bundle.
- **The compatibility matrix exists anyway.** TD2 already assumes one storage holds data written by several CLI versions and read by one web version. Compatibility is carried by `schemaVersion` and the reader rules, not by the shared version number.

The original reason for one series (TD2 "Why the policy changed") was that the root `vX.Y.Z` tag is also the Go module version, so a web-only tag series would publish phantom CLI versions. Prefixed tags, as TD15 introduced for the Terraform modules, remove that reason: if the root series carries only the CLI, the tag and the Go module version mean the same thing again.

## Proposal

### 1. Independent version series

| Component | Monorepo tag | Published as |
| --- | --- | --- |
| CLI | `vX.Y.Z` (root, the Go module version) | Release with per-platform binaries, checksums, notices (unchanged) |
| Web app | `app/vX.Y.Z` | Release with the archive, manifest and `.sha256` (no separate repository: consumers download assets, nothing references a repository) |
| Each Action | `publish-action/vX.Y.Z`, `preview-action/vX.Y.Z`, `registry-action/vX.Y.Z`, `app-deploy-action/vX.Y.Z` | Generated repository `artifact-pages/<name>-action`, tagged plain `vX.Y.Z` (TD14 sync, triggered per Action) |
| Terraform modules | `terraform-<provider>/vX.Y.Z` | Unchanged (TD15) |

- **Per-Action tags.** Once an Action no longer decides the CLI, its version describes only its own wrapper (inputs, outputs, summary, checkout). A change to one Action releases only that Action. A change under `actions/shared/` releases every Action whose generated content changed; the release workflow compares generated content and fails when a tagged Action is unchanged or warns when a changed Action is left untagged.
- Only CLI releases are marked "latest" on the monorepo's releases page; app and Action releases set `make_latest: false`.

### 2. The deployment config names the CLI and the app

```yaml
schemaVersion: 1
cli:
  version: 0.3.0   # every Action and the CLI itself run this version
app:
  version: 0.2.1   # the bundle `app deploy` installs
provider: cloudflare
...
```

- The operator's config (the `admin` repository for `artifact-pages.dev`) is the single place that decides which CLI and app a deployment runs. Sites follow it on their next sync or preview without touching their own repositories.
- Versions are exact SemVer. Ranges and `latest` are rejected: the deployment must be reproducible from the config history, and a rollback is a revert.
- Download sources are not configurable. The CLI is always fetched from release `vX.Y.Z` of `artifact-pages/artifact-pages`, the app from `app/vX.Y.Z`, both checksum-verified. Whoever can edit the config can therefore choose among official releases only, never an arbitrary binary that would run in every site's CI with that site's credentials.
- `app deploy` installs `app.version` instead of the bundle of the CLI's own version. `--archive FILE` remains for local and unreleased bundles.

### 3. The CLI knows compatibility and validates it

Compatibility data travels with each release; the comparison lives in the CLI.

- **CLI:** the binary embeds the config `schemaVersion`s it reads and, per published format, the `schemaVersion` it writes. The release also publishes this as a small JSON asset.
- **App:** the web release manifest lists, per published format, the `schemaVersion`s the app reads.
- **Check:** the CLI loads the app manifest for `app.version` and fails when some format it writes is not readable by that app. It also fails when it cannot read the config's `schemaVersion`.

The check runs in `config check` (new; for the operator's pull requests that change `cli.version` or `app.version`), at the start of `registry sync` and `app deploy`, and at the start of `site sync` and `preview publish`. Existing data written by a newer CLI is already guarded by the reader rule (an unknown control-record `schemaVersion` makes the CLI fail).

While the product is `0.x` no compatibility is promised, so this data-driven check is the only guard; version numbers are never used to infer compatibility.

### 4. Overriding the CLI version

An Action input `cli-version` (and the equivalent CLI flag or environment variable) runs a different CLI than the config names, for trying a release in one site or for an emergency. An override never bypasses validation:

- the Action checks the version against the CLI range it supports (below);
- the overriding CLI runs exactly the checks of section 3 against the same config and `app.version`, and fails the run if any check fails;
- the job summary always records that an override was used and which version ran.

### 5. Actions declare the CLI range they support

Each Action's generated `release.json` gains a supported CLI range (for example `>=0.3.0 <0.5.0`). The Action fails before running the CLI when the resolved version is outside it, naming both versions. The range is the Action ↔ CLI interface contract (arguments, `--format json` result shape); keeping the Actions thin keeps the range wide.

### 6. Resolving the version before a CLI is installed

The Action needs `cli.version` before it has a CLI, and the config may be layered and remote (T10 locators, private config via `github-token`). Two ways:

- **(a) Bootstrap CLI, recommended.** The Action installs the CLI named in its `release.json` as a bootstrap. The CLI resolves the config; if `cli.version` differs from its own version, it downloads that release, verifies it and re-executes it with the same arguments (the model of Go's `toolchain` line). Config resolution stays in one implementation, and local runs follow the config the same way CI does. Constraint: reading `cli.version` must stay stable across config `schemaVersion`s, so an old bootstrap can still find the version that understands a newer config.
- **(b) Action-side parse.** The Action reads `cli.version` itself (for example with `yq`). Rejected unless (a) proves impractical: it duplicates locator and layer resolution in JavaScript.

### 7. Upgrade flow for an operator

1. A CLI or app release opens a pull request in the operator repository that bumps `cli.version` or `app.version` (from the release workflow or a scheduled check in the operator repository; open point).
2. That pull request's CI runs `config check`.
3. On merge, `registry sync` runs, and `app deploy` runs when `app.version` changed.
4. Sites use the new CLI on their next `site sync` or preview.
5. For a breaking format change, the operator repository runs TD2's order (registry, app, then a republish of every site) from one place.

## Open points

- Config layers: may a later layer (for example a site's local layer) set `cli`/`app`? Proposal: `cli` and `app` are replaced as a unit like provider settings, and a site layer that changes `cli.version` is treated as an override (section 4).
- Should validation also compare with the app actually deployed in storage, not only `app.version`? That needs the deployed app to record its version (TD9 already records an archive digest).
- Who opens the bump pull request in step 7.1, and with which credentials.
- Naming: tag prefix `app/` versus the current asset name `artifact-pages-web-…`; rename the assets or keep `web`.
- Migration from `v0.1.x`: the first release under this design (CLI, app and each Action start their own series; Actions likely restart at `v1.0.0` or continue from the product number).

## Implementation slices (to file after the decision; owners per the agent split)

- CLI: `cli`/`app` config keys, compatibility data and `config check`, validation at command start, bootstrap re-exec, `app deploy` by `app.version` (Codex).
- Release workflows: root tag CLI-only, `app/v*` and per-Action tags, generated-content check (Codex).
- Actions: `cli-version` input, supported range in `release.json`, summary line for overrides (Codex).
- Specification §19 and §22, TD2 and TD14 amendments, operator upgrade guide (Claude).
- Operator repositories: add `cli`/`app` to `admin/artifact-pages.yaml`, bump-PR automation (Codex, owner approval for production).
