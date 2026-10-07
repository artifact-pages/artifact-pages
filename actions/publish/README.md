# Artifact Pages site sync

Reconciles one registered site's projection with its publishable source directory in [Artifact Pages](https://artifact-pages.dev), a searchable static reader for Git-managed documents. It runs `artifact-pages site sync --site ID` and relays the typed result.

## Usage

```yaml
permissions:
  contents: read
  id-token: write # only when the provider uses OIDC

steps:
  # ... configure provider credentials ...
  - uses: artifact-pages/publish-action@v0.1.0
    with:
      site: docs
```

The site ID is always explicit; it is never inferred from the repository.

## Pull request dry-runs

The `ref` input controls only the `source.ref` metadata written to the site index. It does not change the checkout or the files that `site sync` evaluates. Leave it empty to use the checkout's current branch or commit. To avoid ref-only index changes in a pull request dry-run, pass the same metadata ref used by production, for example `github.event.repository.default_branch` when production publishes that branch. In a workflow using the release after `v0.1.0`, add:

```yaml
with:
  site: docs
  ref: ${{ github.event.repository.default_branch }}
  dry-run: true
```

This input first becomes available in the Action release after `v0.1.0`; the `v0.1.0` tag does not accept it.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `site` | required | Registered site ID. |
| `source` | registered source path | Publishable source directory inside the checkout. |
| `ref` | empty | Override the `source.ref` value recorded in the index; does not select the checkout. |
| `config` | empty | Deployment config path or `github://` locator; empty uses `artifact-pages.yaml` in the workspace. |
| `cli-version` | empty | Exact supported CLI override; environment overrides take precedence. |
| `github-token` | `github.token` | Read-only token for a separate private config repository. |
| `dry-run` | `false` | Plan without writes. |
| `publish-on` | empty | Newline-separated `event` or `event:ref` entries; a run matching none becomes a dry-run. |
| `summary` | `true` | Append the operation summary to the Job Summary. |
| `checkout` | `auto` | Run `actions/checkout` when the workspace is not a Git checkout (`true` always, `false` never). |
| `fetch-depth` | `1` | Depth of that checkout; the CLI deepens a shallow checkout on demand. |

## Outputs

`operation`, `outcome` (`planned`, `synced`, `no-op` or `failed`), `site`, `changes` (JSON array), `preview-changes` (JSON array), `result` (the complete CLI JSON), `exit-code` and `error`. Outputs are written before a non-zero CLI exit code fails the step.

## Version and runners

The Action version describes its wrapper. Its generated `release.json` declares a checksum-verified bootstrap CLI and the supported range `>=0.1.0 <0.2.0`. The bootstrap resolves `cli.version` from the deployment config; `cli-version` can override it within that range without bypassing compatibility checks. The Job Summary records the actual CLI and any override, including failed operations. CLI downloads use only official Artifact Pages releases and the workflow token; the private-config token is never used for downloads.

Supported runners: Linux and macOS, x64 and arm64. Windows runners are not supported.

Full documentation: <https://artifact-pages.dev/guide/en/>. Inputs, outputs and the Job Summary format are specified in the [specification](https://github.com/artifact-pages/artifact-pages/blob/main/docs/specification.md).
