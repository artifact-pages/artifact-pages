# IMP-31 — Versioned application bundle and deployment path

- Status: Done
- Phase: Reusable distribution
- Depends on: [IMP-19](IMP-19-config-resolution.md), [T11](../technical-design/T11-command-surface.md)
- Proves: clean admin-repository install and upgrade test

## Outcome

Let an operator deploy the completed SPA from a versioned OSS release without copying application source into the admin repository. Keep local-archive deployment and published-version resolution in the same CLI boundary.

## Acceptance criteria

- Build, archive, checksum and version the SPA output; document the exact CLI or installer boundary selected by T11 and how it targets a provider. The CLI accepts either a local `--archive` or a published `--version`.
- Tests verify exact HTTPS release-asset resolution, bundle validation and deployment. A separate clean admin checkout can deploy local pinned bundles and upgrade/roll back intentionally; app-plane deployment never rewrites site content.
- Tests verify integrity failure, missing bundle, unchanged deploy and correct cache headers for shell versus hashed assets.
- Audit and extend the existing local archive/installer rather than duplicating it. Public release availability and clean-room use of released components belong to [T16](../verification/T16-external-adoption.md); provider deployment proof belongs to [T15](../verification/T15-provider-delivery.md).

## Local evidence

`TestDeployAppDownloadsPublishedVersionOverHTTPS` routes normal `DeployApp` release requests through a local HTTPS server. It checks the exact versioned archive, manifest, and checksum URLs, validates the bundle through the production resolver, and verifies the resulting version metadata and app-file bytes. The focused test passed normally and with `-race`; this validates the local download/deploy path, not GitHub's release service or redirect behavior.

`node scripts/test-app-deploy-rollback.mjs` builds the CLI and creates a separate committed temporary admin checkout. It resolves that checkout's `.artifact-pages.yaml`, deploys two pinned local bundle fixtures in the sequence v1 → v2 → v1, checks app-plane bytes after every operation, confirms the checkout remains clean, and verifies `_indexes/`, `_artifacts/`, and `_previews/` stay byte-for-byte unchanged. The runner removes its temporary `.local/` tree after success. This establishes the separate-checkout CLI/config/bundle contract; published release availability, AWS/Cloudflare provider proof, OIDC, and clean-room adoption of released components remain separate T15/T16 evidence.

`go test -race -count=1 ./...` passed and covers archive integrity rejection, missing bundles, unchanged deploys, site-content preservation, and shell-versus-hashed-asset cache headers. The package smoke built a real Vite bundle and confirmed its tar entries match the release manifest before local deployment. The published-version resolver and separate-repository upgrade/rollback flow are locally exercised; a published external release was not exercised.
