# Artifact Pages app deploy

Deploys the Artifact Pages reader application (`artifact-pages app deploy`). It deploys the web bundle of the same version as this Action: there is no version input, so updating the Action pin is the application upgrade. Run it from a protected admin workflow with the application-plane role.

## Usage

```yaml
steps:
  # ... configure provider credentials ...
  - uses: artifact-pages/app-deploy-action@v0.1.0
    with:
      config: artifact-pages.yaml
```

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `archive` | empty | Local packaged app archive (for pre-release bundles). Without it the matching release is downloaded. |
| `repository` | `artifact-pages/artifact-pages` | Repository that publishes the web release (used only when `archive` is empty). |
| `config` | empty | Deployment config path or `github://` locator; empty uses `artifact-pages.yaml` in the workspace. |
| `github-token` | `github.token` | Read-only token for a separate private config repository. |
| `dry-run` | `false` | Plan without writes. |
| `publish-on` | empty | Newline-separated `event` or `event:ref` entries; a run matching none becomes a dry-run. |
| `summary` | `true` | Append the operation summary to the Job Summary. |
| `checkout` | `auto` | Run `actions/checkout` when the workspace is not a Git checkout (`true` always, `false` never). |
| `fetch-depth` | `1` | Depth of that checkout; the CLI deepens a shallow checkout on demand. |

## Outputs

`operation`, `outcome` (`planned`, `deployed`, `no-op` or `failed`), `changes` (JSON array), `result`, `exit-code` and `error`.

## Version and runners

The version of this Action is the version of the `artifact-pages` CLI it runs. The Action downloads `artifact-pages_v<version>_<os>_<arch>` from the matching [release of artifact-pages/artifact-pages](https://github.com/artifact-pages/artifact-pages/releases), verifies it against the release checksums and fails if it cannot. This also holds when you pin the Action to a full commit SHA. Pin an exact release tag (`@v0.1.0`) or a full commit SHA with the tag in a comment; no moving major tag is published while the product is `0.x`.

Supported runners: Linux and macOS, x64 and arm64. Windows runners are not supported.

Full documentation: <https://artifact-pages.dev/guide/en/>. Inputs, outputs and the Job Summary format are specified in the [specification](https://github.com/artifact-pages/artifact-pages/blob/main/docs/specification.md).
