# T10 — Configuration locator and precedence

- Status: Done
- Phase: Provider-backed deployment

## Settled contract

- Deployment target configuration is a strict YAML document with `schemaVersion: 1`, a `provider` (`local`, `aws`, or `cloudflare`), and exactly the matching provider block. The local block has `root`; AWS has `region`, `bucket`, and optional `distributionId`; Cloudflare has `accountId`, `bucket`, `zoneId`, `publicBaseURL`, `accessKeyIdEnv`, `secretAccessKeyEnv`, and `apiTokenEnv`. AWS and Cloudflare targets also require one positive top-level `previewRetentionDays` value for provider-managed `_previews/` lifecycle rules; local development may omit it. Config stores no credential values. It is separate from `sites.yaml`; the latter remains the admin-owned source of registered site identity and is projected to `/_indexes/sites.json`.
- A config locator is either a local filesystem path or a GitHub locator of the form `github://OWNER/REPO/FILE?ref=REF`. The file is optional. If omitted, try `.artifact-pages.yaml`, then `artifact-pages.yaml`, and fall back only on confirmed 404. If `ref` is omitted, resolve the repository default branch; resolve the selected ref to a commit SHA once, then fetch the config at that SHA for the entire command. A caller can pin a commit SHA directly in `ref`.
- Locator precedence is `--config`, `ARTIFACT_PAGES_CONFIG`, a repository-local `.artifact-pages.yaml`, then the saved locator from the user's config directory. `artifact-pages config set-default LOCATOR` changes only the saved locator; credentials are never written there.
- GitHub config reads use the GitHub API over HTTPS. Public repositories need no token; private reads use `GITHUB_TOKEN` or `GH_TOKEN`. Do not follow cross-host redirects, do not fall back on auth/transport/server errors, limit the response size, and never include a token in output. Remote config is deployment input, not a trust boundary; resolve and report its commit SHA and re-fetch on every invocation rather than using a stale local cache.
- The provider config stores identifiers and environment-variable names only. AWS credentials use the standard AWS credential chain. Cloudflare R2 secret values and API tokens are read from their named environment variables.

One repository can keep both configuration and the admin-owned registry together:

~~~yaml
# .artifact-pages.yaml
schemaVersion: 1
provider: local
local:
  root: .local/storage
~~~

~~~yaml
# sites.yaml
schemaVersion: 1
sites:
  sre:
    name: SRE & Platform
    repository: acme/platform
    sourcePath: docs/artifacts
~~~

~~~text
artifact-pages registry publish --manifest sites.yaml --config .artifact-pages.yaml --dry-run
artifact-pages registry publish --manifest sites.yaml --config .artifact-pages.yaml
artifact-pages site publish --config .artifact-pages.yaml --site sre --source docs/artifacts --dry-run
~~~

A satellite checkout can resolve the same target and current registry without a local copy of the admin repository:

~~~text
artifact-pages site publish --config 'github://acme/platform-admin/.artifact-pages.yaml?ref=main' --site sre --source docs/artifacts --dry-run
~~~

The deployed `/_indexes/sites.json` remains authoritative for publisher eligibility; the remote config's repository path is not a substitute registry.

## Design question

How does one CLI resolve the deployment target from an explicitly selected local or Git-hosted configuration file, without coupling a satellite checkout to the admin repository?

## Exit criteria

- [x] Specify the config document, local-path and remote-reference forms, default remote ref/file fallback, and `--config` / environment / saved-default precedence.
- [x] Separate target configuration from the admin-owned `sites.yaml` manifest; the satellite reads the deployed registry, not the manifest.
- [x] Define authentication, pinning/freshness, error handling, and redaction for remote config resolution; never imply a remote URL is a trust boundary.
- [x] Provide one-repository and separate admin/satellite examples, including an explicit site selection in both cases.
- [x] Update the specification before implementing the public syntax.

## Evidence

The configuration schema and precedence above are the source contract for `internal/config`. Examples and parser/fetch test evidence are recorded when IMP-19 is verified.
