# IMP-65 — Switch admin's module source to the synced package tag

- Status: Open
- Lanes: Operations
- Depends on: [IMP-63](IMP-63-consolidate-terraform-modules.md), [IMP-64](IMP-64-generate-sync-terraform-packages.md) (first synced release), and operations items [OPS-003](../../../../ops/OPS-003) and OPS-001 (workspace `ops/`, outside this repository) finishing, so that the production state and the pending ISSUE-069 apply are settled first
- Related: [TD15](../technical-design/TD15-terraform-module-source-of-truth.md), [IMP-38](IMP-38-terraform-registry-publication.md)

## Goal

`artifact-pages/admin` consumes `terraform-cloudflare-artifact-pages` at the tag produced by the first synced release (for example `v0.1.1`), not at commit `208abf5` (or the `80b2198` line), so production runs the monorepo-sourced module.

## Acceptance criteria

- [ ] The first synced release exists and the package tag's content equals the generated tree of that release.
- [ ] `admin`'s module `source` pins the tag; `terraform init -upgrade` and `plan` against production state show no change relative to the pre-switch plan (the switch is a no-op in infrastructure), or show only changes already reviewed by the owner.
- [ ] Any production apply that follows is an owner step.
- [ ] The workspace `STATUS.md` and ops notes record the new pin.

## Results

Not started.
