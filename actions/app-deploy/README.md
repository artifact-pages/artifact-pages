# Artifact Pages app deploy

Deploys the Artifact Pages reader application (`artifact-pages app deploy`). It deploys the web bundle named by `web.version` in the deployment config; an Action pin selects the wrapper, not the app version. Run it from a protected admin workflow with the application-plane role.

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
| `archive` | empty | Local packaged app archive (for pre-release bundles). Without it the config `web.version` release is downloaded. |
| `repository` | `artifact-pages/artifact-pages` | Repository that publishes the web release (used only when `archive` is empty). |
| `config` | empty | Deployment config path or `github://` locator; empty uses `artifact-pages.yaml` in the workspace. |
| `cli-version` | empty | Exact supported CLI override; environment overrides take precedence. |
| `github-token` | `github.token` | Read-only token for a separate private config repository. |
| `dry-run` | `false` | Plan without writes. |
| `publish-on` | empty | Newline-separated `event` or `event:ref` entries; a run matching none becomes a dry-run. |
| `summary` | `true` | Append the operation summary to the Job Summary. |
| `checkout` | `auto` | Run `actions/checkout` when the workspace is not a Git checkout (`true` always, `false` never). |
| `fetch-depth` | `1` | Depth of that checkout; the CLI deepens a shallow checkout on demand. |

## Outputs

`operation`, `outcome` (`planned`, `deployed`, `no-op` or `failed`), `changes` (JSON array), `result`, `exit-code` and `error`.

## Version and runners

The Action version describes its wrapper. Its generated `release.json` declares a checksum-verified bootstrap CLI and the supported range `>=0.1.0 <0.2.0`. The bootstrap resolves `cli.version` from the deployment config; `cli-version` can override it within that range without bypassing compatibility checks. The Job Summary records the actual CLI and any override, including failed operations. CLI downloads use only official Artifact Pages releases and the workflow token; the private-config token is never used for downloads.

Supported runners: Linux and macOS, x64 and arm64. Windows runners are not supported.

Full documentation: <https://artifact-pages.dev/guide/en/>. Inputs, outputs and the Job Summary format are specified in the [specification](https://github.com/artifact-pages/artifact-pages/blob/main/docs/specification.md).
