# TD2 — Component licensing and release compatibility policy

- Status: In progress
- Phase: Reusable distribution
- Related implementation: [IMP-31](../implementation/IMP-31-app-distribution.md), [IMP-34](../implementation/IMP-34-actions.md), [IMP-35](../implementation/IMP-35-external-adoption.md)
- Related verification: [T16](../verification/T16-external-adoption.md)

## Design question

Which OSS license and component release/version compatibility policy govern a public Artifact Pages release?

## Current state

- The project owner selected MIT on 2026-09-28. The root `LICENSE` uses `Copyright (c) 2026 tasuku43`.
- The root MIT license covers Artifact Pages first-party work; dependencies retain their upstream licenses and notices.
- `npm run package:web` copies the project `LICENSE` and generates `THIRD_PARTY_NOTICES.txt` from the installed production dependency graph before packaging the SPA. The current lockfile resolves 235 installed production packages; notices use each package's top-level license/notice files or its README license section. Generation fails when a required dependency has no license text.
- No standalone CLI binary archive is currently packaged. Composite Actions build the CLI from source; if prebuilt CLI binaries are added later, their Go dependency notices must accompany them.
- Composite Actions are consumed by immutable Git commit SHA in the examples. The Action source builds the CLI from that same revision.
- The web archive is separately selected by an exact release version. The CLI resolves archive, JSON manifest, and SHA-256 asset from the matching `v<version>` GitHub release and validates their contents before deployment.
- Deployment config and web release manifest currently use schema version 1. Local adoption evidence covers a matched source revision and those schemas; it does not establish cross-revision compatibility or a public support window.

## Decisions required

- Keep the first-party MIT scope and per-component dependency-notice policy explicit as additional distribution formats are introduced.
- Define which components receive releases, their immutable identifiers and version/tag format, and how a released component is superseded or withdrawn.
- Define compatibility expectations across CLI, composite Actions, deployment-config schema, web release manifest and bundle, and the supported Terraform modules. State how adopters select a compatible set and what rollback support means for each component.
- Identify any additional integrity or provenance requirements beyond the current archive manifest and SHA-256 checksums.

## Exit criteria

- [x] Select the MIT License for the project.
- [x] Add the root MIT license file with the agreed copyright-holder notice (`tasuku43`).
- [x] Audit the current web distribution's production dependencies, clarify first-party MIT scope, and include project and third-party notices in the web archive.
- [ ] Record the component versioning, tag, immutability, and retirement rules without conflating Action commit pins with web bundle release versions.
- [ ] Publish a compatibility matrix or explicit compatibility rules for the CLI, Action, config schema, web manifest/bundle, and supported Terraform modules.
- [ ] Update release and adoption guides with the selected policy and review the examples against it.
- [ ] Keep actual released-component adoption and provider behavior as evidence in T16 and T15; this design item does not replace those checks.

## Evidence and limitations

`npm run test:third-party-notices` verifies production dependency traversal, nested dependencies, optional packages, README license-section fallback, missing-license failure, and project-license copying. `npm run package:web -- --version notices-validation-20260928-02` built the application and generated notices for 235 installed production dependencies; the resulting archive contained both `LICENSE` and `THIRD_PARTY_NOTICES.txt`. This is local packaging evidence, not a public release.

The local packaging, `--version` resolution, SHA-256 validation, upgrade, and rollback paths are implementation evidence only. Do not make a public release claim while the remaining versioning and compatibility decisions above remain open. Do not infer release/version choices from local implementation details or placeholders in the workflow examples.
