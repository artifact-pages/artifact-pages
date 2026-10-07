# Application bundle deployment

The SPA is distributed as a versioned web archive. The deployment config names the web bundle: `web.version` in `artifact-pages.yaml` selects the release, and `artifact-pages app deploy` installs it. An admin repository selects the deployment target and the web version through that file; it does not copy or build the application source.

## Package the web release

In the application repository, build and package the application plane:

```sh
npm run build
npm run package:web -- --version 1.2.3
```

The package command writes an archive, JSON release manifest, and SHA-256 checksum under `.local/releases/`. The archive contains `index.html`, `preview-bridge.js`, files under `assets/`, the project `LICENSE`, and a generated `THIRD_PARTY_NOTICES.txt` for installed production web dependencies. Its complete file list is checked against the deployed application path contract before packaging; adding a root file requires updating the route and deployment policy first. It does not contain site indexes, artifacts, or previews. The command refuses to replace an existing release label.

The release workflow publishes those three files as assets on the GitHub release for the tag `web/vX.Y.Z`. The web bundle has its own `MAJOR.MINOR.PATCH` series, independent of the CLI and the Actions ([TD2](../backlog/technical-design/TD2-component-release-policy.md)). The manifest lists the `schemaVersion`s the web app reads for each published format (`reads`). Without `--archive`, `app deploy` downloads the assets of `web/v<web.version>` from `artifact-pages/artifact-pages` and verifies the archive against both the manifest and checksum before writing objects; it fails without writing when the release cannot be fetched or the manifest version differs. There is no `--version` option: to deploy a different web bundle, change `web.version`. If two web releases have identical file contents, `app deploy` reports `no-op`. Once a series is past `0.x`, do not replace assets or move an existing release tag; publish a new version to correct a release.

For local and pre-release bundles, `app deploy --archive FILE` accepts an already packaged archive with its adjacent manifest and checksum. It is the same deployment operation and supports the same `--dry-run` behavior.

## Select a deployment target

In the admin checkout, provide the target config. For a local target:

```yaml
schemaVersion: 1
provider: local
local:
  root: .local/storage
```

The web version is part of the same config:

```yaml
web:
  version: 0.1.0
```

The value is an exact `MAJOR.MINOR.PATCH`. A config with neither `web` nor `cli` and storage without a deployed-web record keeps the older unpinned flow, which deploys the bundle of the CLI's own version from a root `vX.Y.Z` release; new deployments set `web.version`.

AWS and Cloudflare targets use the same config locator and `artifact-pages app deploy` command. AWS derives an omitted bucket from its explicit account ID and region; Cloudflare defaults to the `artifact-pages` bucket and standard credential environment-variable names. Explicit target and environment-name overrides remain available, while credential values stay outside YAML. See [configuration and command syntax](../specification.md#22-deployment-configuration-and-command-interface) for the provider fields and locator rules.

## Deploy, upgrade, and roll back

Plan and deploy the web bundle named by `web.version`:

```sh
artifact-pages config check --config artifact-pages.yaml
artifact-pages app deploy --config artifact-pages.yaml --dry-run
artifact-pages app deploy --config artifact-pages.yaml --format json
```

`config check` confirms that the named web release reads every format this CLI writes and every format recorded in storage. Upgrade by changing `web.version`, running `config check`, then `app deploy`; a new release or config change never deploys the app by itself. Before it writes, `app deploy` checks the formats recorded in storage and fails, listing the sites that the new bundle cannot read, unless `--accept-breaking` is given for a planned breaking upgrade (see the [specification](../specification.md#upgrading-versions)). Roll back intentionally by setting `web.version` back and deploying. In an admin workflow, the app-deploy Action runs `app deploy` with the config's `web.version`; the Action has no `version` input. The deployment validates the complete bundle before it writes, acquires the application lock before checking every bundle object's metadata, uploads changed app files with `index.html` last, and revalidates `/index.html` after a change. Repeating an unchanged deployment with no pending cache work reports `no-op` and performs no object writes or cache revalidation.

Before changing app objects, the command writes the private `/_control/app-cache/retry.json` record with `/index.html` as the pending invalidation path. It is a bounded `schemaVersion: 1` JSON record, stored with `Cache-Control: no-store`; conditional writes use the observed ETag, and malformed or unsupported records fail closed. If an object write, purge, or journal clear fails, the next deployment checks the complete bundle again and retries the purge; an unchanged bundle with pending invalidation reports `deployed` with zero uploaded files. Dry-run shows the pending path without acquiring the lock or changing state. A clean no-op performs no application-object PUTs or cache invalidation, while still acquiring and releasing the application lock. A process crash can leave the application lock held; inspect it with `artifact-pages lock inspect --scope application`, then recover only after confirming the deployment is no longer active, using the inspected ETag with `lock recover --scope application --observed-etag ETAG`.

The command writes the application plane and its private lock/retry controls only. It neither lists nor deletes site indexes, artifacts, or previews. The shell uses browser revalidation; hashed assets use the immutable one-year cache policy. Site registration and published site content continue to use their separate admin and satellite operations.

## Remove the application bundle

`artifact-pages app remove --config artifact-pages.yaml --dry-run` plans removal without locking or changing storage. Apply with the same command without `--dry-run`. It deletes only `index.html`, `preview-bridge.js`, `LICENSE`, `THIRD_PARTY_NOTICES.txt`, and objects under `assets/`; missing files are a successful no-op. The application lock and cache retry journal make partial deletion and cache-purge retries converge. A later `app deploy` replays pending application cache work before deciding that the bundle is unchanged. Site indexes, artifacts, previews, and registry data are outside this operation.

## Run the local checkout, upgrade, and rollback smoke

From this repository, run:

```sh
node scripts/test-app-deploy-rollback.mjs
```

The runner builds the CLI, creates and commits a clean temporary admin checkout with a local target config, and deploys two exact local bundle fixtures. It checks the sequence v1 → v2 → v1, verifies that app-plane bytes follow each pinned version, confirms the temporary checkout stays clean, and compares `/_indexes/`, `/_artifacts/`, and `/_previews/` byte-for-byte after each deployment. Its temporary files live below ignored `.local/` storage and are removed on completion.

This proves local config discovery and the CLI's archive, upgrade, rollback, and content-plane contract. The runner uses locally generated bundle assets; it does not verify GitHub Release downloads, an external published release, AWS/Cloudflare credentials, or provider OIDC.
