# Application bundle deployment

The SPA is distributed as a versioned web archive. An admin repository selects the deployment target through `.artifact-pages.yaml`; it does not copy or build the application source.

## Package the web release

In the application repository, build and package the application plane:

```sh
npm run build
npm run package:web -- --version 1.2.3
```

The package command writes an archive, JSON release manifest, and SHA-256 checksum under `.local/releases/`. The archive contains the web build, including `index.html`, hashed files under `assets/`, app-owned root runtime files, the project `LICENSE`, and a generated `THIRD_PARTY_NOTICES.txt` for installed production web dependencies. It does not contain site indexes, artifacts, or previews. The command refuses to replace an existing release label.

Publish those three files as assets on the matching immutable GitHub release tag (for example, `v1.2.3`). The version label is used in the asset name and release URL; `app deploy --version 1.2.3` downloads and verifies the archive against both the manifest and checksum before writing objects. Do not replace assets or move an existing release tag; publish a new version to correct a release.

For a local or caller-managed release flow, `app deploy --archive FILE` accepts an already packaged archive with its adjacent manifest and checksum. It is the same deployment operation and supports the same `--dry-run` behavior.

## Select a deployment target

In the admin checkout, provide the target config. For a local target:

```yaml
schemaVersion: 1
provider: local
local:
  root: .local/storage
```

AWS and Cloudflare targets use the same config locator and `artifact-pages app deploy` command. Their provider blocks name the bucket/account/zone and the environment variables that hold credentials; credential values stay outside the YAML file. See [configuration and command syntax](../specification.md#22-deployment-configuration-and-command-interface) for the provider fields and locator rules.

## Deploy, upgrade, and roll back

Plan and deploy a published release by its exact version:

```sh
artifact-pages app deploy --version 1.2.3 --config .artifact-pages.yaml --dry-run
artifact-pages app deploy --version 1.2.3 --config .artifact-pages.yaml --format json
```

Upgrade by deploying the next release version. Roll back intentionally by deploying the previous version again. The deployment validates the complete bundle before it writes, uploads changed app files with `index.html` last, and revalidates `/index.html` after a change. Repeating an unchanged deployment reports `no-op` and performs no object writes or cache revalidation.

The command writes the application plane only. It neither lists nor deletes site indexes, artifacts, or previews. The shell uses browser revalidation; hashed assets use the immutable one-year cache policy. Site registration and published site content continue to use their separate admin and satellite operations.

## Run the local checkout, upgrade, and rollback smoke

From this repository, run:

```sh
node scripts/test-app-deploy-rollback.mjs
```

The runner builds the CLI, creates and commits a clean temporary admin checkout with a local target config, and deploys two exact local bundle fixtures. It checks the sequence v1 → v2 → v1, verifies that app-plane bytes follow each pinned version, confirms the temporary checkout stays clean, and compares `/_indexes/`, `/_artifacts/`, and `/_previews/` byte-for-byte after each deployment. Its temporary files live below ignored `.local/` storage and are removed on completion.

This proves local config discovery and the CLI's archive, upgrade, rollback, and content-plane contract. The runner uses locally generated bundle assets; it does not verify GitHub Release downloads, an external published release, AWS/Cloudflare credentials, or provider OIDC.
