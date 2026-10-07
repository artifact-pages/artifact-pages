# Artifact Pages registry sync

Reconciles the Artifact Pages site registry with the complete `sites` mapping of the admin deployment config (`artifact-pages registry sync`). It adds and updates configured sites and removes omitted sites from discovery, including cleaning their published content. A retry resumes any cleanup left by a partial failure. Run it from a protected admin workflow.

## Usage

```yaml
steps:
  # ... configure provider credentials ...
  - uses: artifact-pages/registry-action@v0.1.0
    with:
      config: artifact-pages.yaml
```

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `config` | empty | Deployment config path or `github://` locator; empty uses `artifact-pages.yaml` in the workspace. |
| `github-token` | `github.token` | Read-only token for a separate private config repository. |
| `dry-run` | `false` | Plan without writes. |
| `publish-on` | empty | Newline-separated `event` or `event:ref` entries; a run matching none becomes a dry-run. |
| `summary` | `true` | Append the operation summary to the Job Summary. |
| `checkout` | `auto` | Run `actions/checkout` when the workspace is not a Git checkout (`true` always, `false` never). |
| `fetch-depth` | `1` | Depth of that checkout; the CLI deepens a shallow checkout on demand. |

## Outputs

`operation`, `outcome` (`planned`, `synced`, `no-op` or `failed`), `registry-updated` (`true` or `false`), `changes` (JSON array), `result`, `exit-code` and `error`.

## Version and runners

The version of this Action is the version of the `artifact-pages` CLI it runs. The Action downloads `artifact-pages_v<version>_<os>_<arch>` from the matching [release of artifact-pages/artifact-pages](https://github.com/artifact-pages/artifact-pages/releases), verifies it against the release checksums and fails if it cannot. This also holds when you pin the Action to a full commit SHA. Pin an exact release tag (`@v0.1.0`) or a full commit SHA with the tag in a comment; no moving major tag is published while the product is `0.x`.

Supported runners: Linux and macOS, x64 and arm64. Windows runners are not supported.

Full documentation: <https://artifact-pages.dev/guide/en/>. Inputs, outputs and the Job Summary format are specified in the [specification](https://github.com/artifact-pages/artifact-pages/blob/main/docs/specification.md).
