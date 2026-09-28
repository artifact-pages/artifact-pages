# TD2 — Component licensing and release compatibility policy

- Status: Done
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

## Settled release policy

Use one coordinated Semantic Versioning tag, `vMAJOR.MINOR.PATCH`, for the repository's first-party release set. A release is built from the commit named by that tag; the tag and its GitHub release assets are never moved, replaced, or withdrawn in place. Corrections use a new version. Patch releases contain fixes, minor releases add compatible functionality, and major releases may break public contracts.

| Component | Consumer selection | Initial compatibility rule |
| --- | --- | --- |
| CLI source | Exact repository tag; Actions build it from their pinned source commit. No standalone prebuilt CLI binary archive is in the first release set. | Use the CLI and other components from one release tag unless a later compatibility matrix explicitly permits a mix. |
| Composite Actions | Full commit SHA for the commit named by `vMAJOR.MINOR.PATCH`; release notes map the SHA to its tag. | Action inputs/outputs and the CLI it builds come from the same commit. |
| Web application | `artifact-pages app deploy --version MAJOR.MINOR.PATCH` selects the web archive attached to `vMAJOR.MINOR.PATCH`. | Deploy the web archive from the same release tag as the CLI/Action set. |
| AWS and Cloudflare Terraform modules | Git module source at the release tag; production callers may pin the exact commit SHA instead. | Module source belongs to the same coordinated release. Terraform state changes still require reviewing a fresh `terraform plan`; reverting source is not an automatic state rollback. |
| Config, registry, index, preview, and web-release schemas | Their own `schemaVersion`, independent of the repository version. | Schema v1 is the first public contract. A breaking serialized-format change increments the affected schema version and the product major version. Pre-release local labels make no compatibility promise. |

The exact same-tag set is the only supported combination for the first release. Mixing components from different tags is not promised compatible until an explicit matrix and verification evidence are added. Private admin config refs remain independently pinned to the adopter's chosen Git commit; they are not Artifact Pages component versions. A future standalone CLI binary distribution must include its Go dependency notices.

Use the existing web-release manifest and `.sha256` file to verify that the downloaded archive matches its published digest. This detects mismatches but is not a cryptographic signature or build-provenance attestation; the first release adds no separate signing/attestation system. Trust rests on the reviewed source commit and controlled GitHub release publishing. Keep superseded tags and assets available for reproducibility and rollback; the latest release is the only line promised routine fixes, with no LTS commitment. Mark a superseded release clearly and direct adopters to a new immutable version rather than silently changing old assets.

## Exit criteria

- [x] Select the MIT License for the project.
- [x] Add the root MIT license file with the agreed copyright-holder notice (`tasuku43`).
- [x] Audit the current web distribution's production dependencies, clarify first-party MIT scope, and include project and third-party notices in the web archive.
- [x] Record the coordinated version/tag, immutability, correction, and rollback rules without conflating Action commit pins with web bundle release versions.
- [x] Publish explicit compatibility rules for the CLI, Action, schemas, web bundle, and supported Terraform modules.
- [x] Update release and adoption guides to use the selected policy; public release pins remain pending T16.
- [x] Keep actual released-component adoption and provider behavior as separate evidence in T16 and T15; this design item does not claim those proofs complete.

## Evidence and limitations

`npm run test:third-party-notices` verifies production dependency traversal, nested dependencies, optional packages, README license-section fallback, missing-license failure, installed-version matching, and project-license copying. `npm run package:web -- --version notices-validation-20260928-02` built the application and generated notices for 235 installed production dependencies; the resulting archive contained `LICENSE` and `THIRD_PARTY_NOTICES.txt`. This is local packaging evidence, not a public release.

The local packaging, `--version` resolution, SHA-256 validation, upgrade, and rollback paths do not establish public release availability or cross-tag compatibility. T15 and T16 remain the evidence gates for real-provider behavior and clean-room adoption of released pins. Do not infer release behavior from local labels or workflow placeholders.
