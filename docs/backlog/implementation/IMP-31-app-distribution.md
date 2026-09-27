# IMP-31 — Versioned application bundle and deployment path

- Status: Open
- Phase: Reusable distribution
- Depends on: [IMP-19](IMP-19-config-resolution.md), [T11](../technical-design/T11-command-surface.md)
- Proves: clean admin-repository install and upgrade test

## Outcome

Let an operator deploy the completed SPA from a versioned OSS release without copying application source into its repository.

## Acceptance criteria

- Build, archive, checksum and version the SPA output; document the exact CLI or installer boundary selected by T11 and how it targets a provider.
- A clean external admin checkout can resolve and deploy a pinned bundle, then upgrade/roll back intentionally; app-plane deployment never rewrites site content.
- Tests verify integrity failure, missing bundle, unchanged deploy and correct cache headers for shell versus hashed assets.
- Audit and extend the existing local archive/installer rather than duplicating it; mark Done only after the external-repository workflow is verified.
