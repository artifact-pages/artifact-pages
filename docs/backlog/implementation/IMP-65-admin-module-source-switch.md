# IMP-65 — Switch admin's module source to the synced module tag

- Status: In progress
- Assignee: Codex
- Lanes: Operations
- Depends on: [IMP-63](IMP-63-consolidate-terraform-modules.md), [IMP-64](IMP-64-generate-sync-terraform-packages.md) (first synced module release, `terraform-cloudflare/vX.Y.Z`), and completed operations items OPS-003 and OPS-001 (workspace `ops/`, outside this repository), so the production state and pending ISSUE-069 apply are settled first
- Related: [TD15](../technical-design/TD15-terraform-module-source-of-truth.md), [IMP-38](IMP-38-terraform-registry-publication.md)

## Goal

`artifact-pages/admin` consumes `terraform-cloudflare-artifact-pages` at the plain `vX.Y.Z` tag that the first Cloudflare module release (`terraform-cloudflare/vX.Y.Z` in the monorepo) creates in the package repository (for example `v0.1.0`; module versions are independent of the product version), not at commit `208abf5` (or the `80b2198` line), so production runs the monorepo-sourced module.

## Acceptance criteria

- [x] The first synced module release exists and the package tag's content equals the generated tree of that release.
- [ ] `admin`'s module `source` pins the module tag (not a product tag); `terraform init -upgrade` and `plan` against production state show no change relative to the pre-switch plan (the switch is a no-op in infrastructure), or show only changes already reviewed by the owner.
- [x] Any production apply that follows is an owner step; this item contains no apply.
- [ ] The workspace `STATUS.md` and ops notes record the new pin.

## Results

`admin` now pins `terraform-cloudflare-artifact-pages` at the plain Git tag `v0.1.0`, generated from the monorepo release. `terraform init -upgrade` fetched that tag; the final plan uses the existing Cloudflare provider lock at 5.26.0 to keep this source-switch change isolated.

The remote production plan contains one change for D5 owner review: create Terraform management for `cloudflare_r2_managed_domain.development` with `enabled = false`. The resource was absent from the pre-switch state. A read-only Cloudflare API check confirmed the bucket's existing managed r2.dev domain is already disabled. All other resources are no-op and the three outputs are unchanged. The saved plan is ready for owner review; do not apply it until the owner approves D5. The workspace `STATUS.md` update is owned by the parent session.
