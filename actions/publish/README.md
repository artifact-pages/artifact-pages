# Artifact Pages publish

Publishes one registered site to [Artifact Pages](https://artifact-pages.dev), a searchable static reader for Git-managed documents. It runs `artifact-pages site publish --site ID` and relays the typed result.

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

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `site` | required | Registered site ID. |
| `source` | registered source path | Publishable source directory inside the checkout. |
| `config` | empty | Deployment config path or `github://` locator; empty uses `artifact-pages.yaml` in the workspace. |
| `github-token` | `github.token` | Read-only token for a separate private config repository. |
| `dry-run` | `false` | Plan without writes. |
| `publish-on` | empty | Newline-separated `event` or `event:ref` entries; a run matching none becomes a dry-run. |
| `summary` | `true` | Append the operation summary to the Job Summary. |
| `checkout` | `auto` | Run `actions/checkout` when the workspace is not a Git checkout (`true` always, `false` never). |
| `fetch-depth` | `1` | Depth of that checkout; the CLI deepens a shallow checkout on demand. |

## Outputs

`operation`, `outcome` (`planned`, `published`, `no-op` or `failed`), `site`, `changes` (JSON array), `preview-changes` (JSON array), `result` (the complete CLI JSON), `exit-code` and `error`. Outputs are written before a non-zero CLI exit code fails the step.

## Version and runners

The version of this Action is the version of the `artifact-pages` CLI it runs. The Action downloads `artifact-pages_v<version>_<os>_<arch>` from the matching [release of artifact-pages/artifact-pages](https://github.com/artifact-pages/artifact-pages/releases), verifies it against the release checksums and fails if it cannot. This also holds when you pin the Action to a full commit SHA. Pin an exact release tag (`@v0.1.0`) or a full commit SHA with the tag in a comment; no moving major tag is published while the product is `0.x`.

Supported runners: Linux and macOS, x64 and arm64. Windows runners are not supported.

Full documentation: <https://artifact-pages.dev/guide/en/>. Inputs, outputs and the Job Summary format are specified in the [specification](https://github.com/artifact-pages/artifact-pages/blob/main/docs/specification.md).
