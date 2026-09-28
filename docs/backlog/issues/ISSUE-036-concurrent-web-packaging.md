# Keep concurrent packaging of one web version from mixing release files

- Status: Open
- Priority: P2
- Area: Web release / package publication
- Review: 2026-09-28, finding 23, source revision `50c327d886c71fc5e0d086a5967b90cd9038e01e`
- Related backlog: [IMP-31](../implementation/IMP-31-app-distribution.md), [T16](../verification/T16-external-adoption.md)

## Problem

The packager checks for existing output, then replaces archive, manifest, and checksum separately. Two processes packaging the same label can both succeed and leave a mismatched release triplet, violating immutable version publication.

## Evidence and reproduction

1. Use isolated copies of the packaging setup with different dist payloads and the same version/output directory.
2. Synchronize both processes after the initial existence check, then allow their final file publications to interleave.
3. The review produced two zero exits and an archive digest that disagreed with the final manifest/checksum. Repository product scripts were not modified for this reproduction.

Reviewed source: [scripts/package-web-release.mjs:163](../../../scripts/package-web-release.mjs). The review's supplementary local evidence is `.local/reviews/2026-09-28/delivery-evidence.md / synchronized packaging reproduction`; it is ignored and is not required to understand or reproduce this issue. Preserve the reproduction as a committed regression when implementing the fix.

## Expected outcome

One version identifies one coherent archive/manifest/checksum set; competing packagers cannot overwrite or mix it.

## Acceptance criteria

- [ ] A deterministic concurrent-packaging test allows only one publication and verifies all final digests/manifest contents agree.
- [ ] A failed competitor cannot delete or replace the successful process's output.
- [ ] Existing version files and interrupted publication states are handled without silently republishing an immutable version.
- [ ] Single-process packaging, required notices, deployment verification, and reproducible version selection remain valid.
