# TD2 — Component licensing and release version boundaries

- Status: Done
- Phase: Reusable distribution
- Related implementation: [IMP-31](../implementation/IMP-31-app-distribution.md), [IMP-34](../implementation/IMP-34-actions.md), [IMP-35](../implementation/IMP-35-external-adoption.md)
- Related verification: [T16](../verification/T16-external-adoption.md)

## Design question

Which OSS license applies, and what is the smallest clear version boundary for each independently consumed Artifact Pages deliverable?

## Current state

- The project owner selected MIT on 2026-09-28. The root `LICENSE` uses `Copyright (c) 2026 tasuku43`.
- The root MIT license covers Artifact Pages first-party work; dependencies retain their upstream licenses and notices.
- `npm run package:web` copies the project `LICENSE` and generates `THIRD_PARTY_NOTICES.txt` from the installed production dependency graph before packaging the SPA. The current lockfile resolves 235 installed production packages; notices use each package's top-level license/notice files or its README license section. Generation fails when a required dependency has no license text.
- No standalone CLI binary archive is currently packaged. Composite Actions build the CLI from source; if prebuilt CLI binaries are added later, their Go dependency notices must accompany them.
- Composite Actions are consumed by immutable Git commit SHA in the examples. The Action source builds the CLI from that same revision.
- The web archive is separately selected by an exact release version. The CLI resolves archive, JSON manifest, and SHA-256 asset from the matching `v<version>` GitHub release and validates their contents before deployment.
- Deployment config and web release manifest currently use schema version 1. Local adoption evidence covers a matched source revision and those schemas; it does not establish cross-revision compatibility or a public support window.

## Settled release policy

Do not assign one product version to the whole repository. Give a user-facing version only to a deliverable that needs its own versioned release, and use immutable source commits for source consumed directly. This keeps a CLI or infrastructure change from manufacturing a new web-app version.

| Deliverable / contract | Consumer selection | Version rule |
| --- | --- | --- |
| CLI source and composite Actions | Pin the Action to a full Git commit SHA. The Action builds the CLI from that same source revision. | No standalone CLI binary or separate CLI SemVer release is part of the initial distribution. Updating the Action/CLI ref does not version or deploy the web application. |
| Web application bundle | `artifact-pages app deploy --version MAJOR.MINOR.PATCH` selects the archive attached to the matching immutable `vMAJOR.MINOR.PATCH` GitHub release. | These tags version the web bundle only and are created when its packaged contents change. Patch/minor/major follow SemVer for the web bundle's public behavior. Deploy remains an explicit operation; a new tag never deploys automatically. Never move a tag or replace its assets; corrections use a new web version. |
| AWS and Cloudflare Terraform modules | Pin the Git module source to an exact commit SHA. | Do not create module SemVer tags for the initial distribution. Add provider-specific versions only if modules later become separately released products. Terraform state changes still require reviewing a fresh `terraform plan`; reverting a source ref is not an automatic state rollback. |
| Config, registry, index, preview, and web-release schemas | Each serialized format carries its own `schemaVersion`, independent of app versions and source commits. | Schema v1 is the first public contract. A breaking change increments the affected `schemaVersion`; update only the producer/consumer deliverables whose contents or behavior changed. Local test labels make no compatibility promise. |

There is no umbrella release tag or requirement that independently consumed components share a version number. Private admin config refs are pinned independently to the adopter's chosen Git commit. Compatibility is expressed at the actual boundaries—especially schema versions—and verified with producer/consumer contract tests, not by requiring unrelated components to use one tag. If a breaking schema change ever requires a coordinated producer/consumer rollout, record and verify only that affected component pair; do not bump unrelated deliverables. If standalone CLI binaries or separately versioned Terraform modules are introduced later, give each its own version and include Go dependency notices with CLI binaries.

Use the existing web-release manifest and `.sha256` file to verify that the downloaded archive matches its published digest. This detects mismatches but is not a cryptographic signature or build-provenance attestation; the first release adds no separate signing/attestation system. Trust rests on the reviewed source commit and controlled GitHub release publishing. Keep superseded web-app tags and assets available for reproducibility and rollback; only the latest web-app release is promised routine fixes, with no LTS commitment. Mark a superseded release clearly and direct adopters to a new immutable version rather than silently changing old assets.

## Exit criteria

- [x] Select the MIT License for the project.
- [x] Add the root MIT license file with the agreed copyright-holder notice (`tasuku43`).
- [x] Audit the current web distribution's production dependencies, clarify first-party MIT scope, and include project and third-party notices in the web archive.
- [x] Define the web bundle as the only initial SemVer release; pin Actions/CLI source and Terraform modules by immutable commit SHA.
- [x] Record schema compatibility separately from deliverable versions and keep application deployment explicit.
- [x] Update release and adoption guides to use the selected policy; public release pins remain pending T16.
- [x] Keep actual released-component adoption and provider behavior as separate evidence in T16 and T15; this design item does not claim those proofs complete.

## Evidence and limitations

`npm run test:third-party-notices` verifies production dependency traversal, nested dependencies, optional packages, README license-section fallback, missing-license failure, installed-version matching, and project-license copying. `npm run package:web -- --version notices-validation-20260928-02` built the application and generated notices for 235 installed production dependencies; the resulting archive contained `LICENSE` and `THIRD_PARTY_NOTICES.txt`. This is local packaging evidence, not a public release.

The local packaging, `--version` resolution, SHA-256 validation, upgrade, and rollback paths do not establish public release availability or released-source adoption. T15 and T16 remain the evidence gates for real-provider behavior and clean-room adoption of immutable refs. Do not infer release behavior from local labels or workflow placeholders.
