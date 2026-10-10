# IMP-65 — Switch admin's module source to the synced module tag

- Status: Done
- Assignee: Codex
- Lanes: Operations
- Depends on: [IMP-63](IMP-63-consolidate-terraform-modules.md), [IMP-64](IMP-64-generate-sync-terraform-packages.md) (first synced module release, `terraform-cloudflare/vX.Y.Z`), and completed operations items OPS-003 and OPS-001 (workspace `ops/`, outside this repository), so the production state and pending ISSUE-069 apply are settled first
- Related: [TD15](../technical-design/TD15-terraform-module-source-of-truth.md), [IMP-38](IMP-38-terraform-registry-publication.md)

## Goal

`artifact-pages/admin` consumes `terraform-cloudflare-artifact-pages` at the plain `vX.Y.Z` tag that the first Cloudflare module release (`terraform-cloudflare/vX.Y.Z` in the monorepo) creates in the package repository (for example `v0.1.0`; module versions are independent of the product version), not at commit `208abf5` (or the `80b2198` line), so production runs the monorepo-sourced module.

## Acceptance criteria

- [x] The first synced module release exists and the package tag's content equals the generated tree of that release.
- [x] `admin`'s module `source` pins the module tag (not a product tag); `terraform init -upgrade` and the production plan show no source-switch changes, or show only changes reviewed by the owner.
- [x] Any production apply has explicit owner authorization; the approved D5 plan is applied and a fresh plan reports no changes.
- [x] The workspace `STATUS.md` and ops notes record the new pin and operation result.

## Results

`admin` now pins `terraform-cloudflare-artifact-pages` at the plain Git tag `v0.1.0`, generated from the monorepo release. `terraform init -upgrade` fetched that tag; the production plan used the existing Cloudflare provider lock at 5.26.0 to keep this source-switch change isolated.

The exact saved plan SHA-256 `de4c3bd58770782ec603747941702ed742f0ec83e3cb1162d1593aaf7b4f0377` was approved by the owner for D5 and applied on 2026-10-10. It created only `cloudflare_r2_managed_domain.development` with `enabled = false` (1 added, 0 changed, 0 destroyed); this manages the already-disabled r2.dev setting. The pre/post remote state retained its lineage and advanced from serial 1 to 2, with managed resources increasing from 7 to 8 and the data-resource count remaining 1; outputs were unchanged. A fresh production plan reported no changes. A post-apply read-only API GET returned HTTP 200 with `enabled = false`, and the remote state lock object was absent after the operation. Protected state, plan, and command evidence is retained outside the repository under `~/.config/artifact-pages/state-backup/ops-004-20261010/`. The workspace `STATUS.md` and OPS-004 notes record the operation.
