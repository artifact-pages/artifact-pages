# T10 — Configuration locator and precedence

- Status: Done
- Phase: Provider-backed deployment

## Settled contract

- One strict YAML document uses integer `schemaVersion: 1` and selects exactly one provider plus its matching settings block. Unknown fields, duplicate mapping keys, multiple YAML documents, and mistyped values are errors. It may also contain an optional top-level `sites` mapping keyed by site ID. Local settings use `root`; AWS uses `region`, optional `bucket`, optional quoted 12-digit string `accountId` (required only to derive an omitted bucket), and optional `distributionId`. When AWS bucket is omitted, derive `artifact-pages-<accountId>-<region>` without credential or STS discovery; explicit bucket always wins. Cloudflare requires `accountId`, `zoneId`, and `publicBaseURL`, defaults an omitted bucket to `artifact-pages`, and defaults its primary environment-variable names to `CF_R2_ACCESS_KEY_ID`, `CF_R2_SECRET_ACCESS_KEY`, and `CF_API_TOKEN`. Valid explicit bucket and environment-name overrides are supported; declared empty overrides are invalid. Preview retention belongs to provider infrastructure and is not in the CLI config. Config stores no credential values. The mapping, when present, follows the registry validation and projection rules in the specification.
- Target-only configs may omit `sites`. `registry register` and `registry unregister` require the selected config to contain `sites`; an absent field is an input error, not an empty desired registry. `sites: {}` is the explicit empty registry and registering it removes every current registration and cleans the omitted sites. Other operations do not reconcile the config's `sites` field. In particular, site and preview publishing continue to use the deployed `/_indexes/sites.json` for eligibility.
- A config locator is either a local filesystem path or a GitHub locator of the form `github://OWNER/REPO/FILE?ref=REF`. Explicit local and remote file paths may use arbitrary filenames. If the GitHub file is omitted, use only `artifact-pages.yaml`; do not fall back to `.artifact-pages.yaml`. If `ref` is omitted, resolve the repository default branch to a commit SHA once, then fetch the selected config at that SHA for the whole command. The provider settings and optional `sites` mapping must come from that same resolved commit. A caller can pin a commit SHA directly in `ref`.
- Locator precedence is `--config`, `ARTIFACT_PAGES_CONFIG`, a repository-local `artifact-pages.yaml`, then the saved locator from the user's config directory. `artifact-pages.yaml` remains the implicit local default. `--config`, environment, and saved locators may point to arbitrary filenames. `artifact-pages config set-default LOCATOR` changes only the saved locator; credentials are never written there.
- GitHub config reads use the GitHub API over HTTPS. Public repositories need no token; private reads use `GITHUB_TOKEN` or `GH_TOKEN`. Do not follow cross-host redirects, do not fall back on auth/transport/server errors, limit the response size, and never include a token in output. Remote config is deployment input, not a trust boundary; resolve and report its commit SHA and re-fetch on every invocation rather than using a stale local cache.
- The provider config stores identifiers and environment-variable names only. AWS credentials use the standard AWS credential chain. Cloudflare R2 secret values and API tokens are read from their named environment variables.

One repository can keep the provider target and admin-owned registry together:

~~~yaml
# artifact-pages.yaml
schemaVersion: 1
provider: local
local:
  root: .local/storage
sites:
  sre:
    name: SRE & Platform
    repository: acme/platform
    sourcePath: docs/artifacts
~~~

~~~text
artifact-pages registry register --config artifact-pages.yaml --dry-run
artifact-pages registry register --config artifact-pages.yaml
artifact-pages site publish --config artifact-pages.yaml --site sre --source docs/artifacts --dry-run
~~~

A satellite checkout can resolve the provider target from the same remote config without a local admin checkout. Its eligibility check still uses the deployed registry, not the remote config's `sites` mapping:

~~~text
artifact-pages site publish --config 'github://acme/platform-admin/artifact-pages.yaml?ref=main' --site sre --source docs/artifacts --dry-run
~~~

**Addendum (2026-10-10, [TD18](TD18-admin-provided-site-workflows.md)).** Once TD18 ships, the official satellite path does not use a remote `github://` config: the admin repository provides reusable workflows that pass its bundled `artifact-pages.yaml` to the official Actions. The `github://` locator and its rules above remain for local and admin use.

## Design question

How does one CLI resolve one provider target and optional admin site registry from an explicitly selected local or Git-hosted YAML file while keeping publisher eligibility tied to the deployed registry?

## Exit criteria

- [x] Specify the unified version-1 config, local-path and remote-reference forms, single remote default file, arbitrary explicit filenames, and `--config` / environment / saved-default precedence.
- [x] Specify provider defaults without credential discovery: deterministic AWS bucket derivation from explicit `accountId` and `region`, Cloudflare bucket and environment-name defaults, and provider-only preview retention.
- [x] Define optional `sites` semantics, including an input error for missing `sites` on registry operations and explicit empty-map behavior; keep satellite eligibility based on deployed registry JSON.
- [x] Define authentication, one-commit pinning/freshness, error handling, and redaction for remote config resolution; never imply a remote URL is a trust boundary.
- [x] Provide one-repository and separate admin/satellite examples, including an explicit site selection in both cases.
- [x] Update the specification before implementing the public syntax.

## Evidence

This contract supersedes the earlier two-file config/registry split. `internal/config` parses the selected provider target and optional `sites` mapping from one strict document, with tests for omitted versus empty maps, invalid site fields, and one-SHA remote resolution. Registry commands consume that mapping; site and preview eligibility continue to use deployed `/_indexes/sites.json`. `go test ./...` and `go test -race -count=1 ./...` passed in the 2026-09-29 local verification.
