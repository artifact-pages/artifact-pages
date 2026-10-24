# T8 — Stale-reference cleanup

- Status: In progress
- Assignee: Codex
- Phase: Phase 1 local proof; provider-origin proof remains open

## Contract to prove

Pre-publish and production publish prune catalog references only when their revision manifests are confirmed absent at the selected backend; remote-provider checks must read provider origin. Merge, close, and manual publication do not by themselves remove a live preview.

## Exit criteria

- [x] Show that live open, merged, and closed-unmerged PR fixture groups and a manual preview remain discoverable while their manifests exist. PR lifecycle is not stored or queried by the reconciliation path.
- [x] Show that a missing manifest is hidden by the reader before cleanup and removed on the next catalog write.
- [x] Show that a provider read error is not interpreted as a missing manifest.
- [x] Verify the local CLI calls the shared reconciliation operation and a failed production switch leaves catalog entries unchanged.
- [x] Verify a successful production switch followed by catalog-write failure reports incomplete cleanup and converges on retry; no separate cleanup workflow or PR-state query is required.
- [x] After [IMP-34](../implementation/IMP-34-actions.md) adds a CI wrapper, verify it calls the same operation and produces the same result as the local CLI.
- [ ] Verify cleanup against the configured AWS/Cloudflare provider origin and its deployed failure behavior.

## Evidence

The [October 2 Cloudflare record](../cloudflare-preview-lifecycle-proof.md) establishes a sampled successful provider-origin cleanup: a separately deleted revision was pruned by main-source publication while the live revision was retained, followed by browser list/direct-link revalidation. The former natural-expiry observation is dropped by the October 20 owner decision; AWS plus deployed failure behavior remain open. [T17](T17-local-preview-retirement-e2e.md) records the completed repeatable local CLI → object deletion → production publish → warm-browser/nginx regression; it does not reopen completed unit checks or replace provider proof.

The local reader hides a catalog candidate when its manifest is confirmed missing and keeps a candidate visible with an unknown-availability message after a 503. `internal/preview/store_test.go` covers unavailable-manifest retention, idempotence, and site isolation. `internal/publisher/site_publish_preview_test.go` verifies production-before-catalog ordering, lifecycle-agnostic retention of live PR/manual groups, catalog stability after production-write failure, and retry convergence after catalog-write failure. `cmd/artifact-pages/main_test.go` exercises the local CLI process and JSON for a provider registry-read failure. The Actions parity smoke starts direct CLI and shared Action site-publish calls from equivalent local projections containing a catalog entry with a confirmed-missing manifest; both return the same JSON and exit status with `remove`/`manifest-missing`, and both prune the reference. `node scripts/test-actions-parity.mjs` passes. Cloudflare successful origin cleanup is established by the October 2 record; AWS origin cleanup and deployed provider-failure behavior remain open. The local preview development command writes to `.local/previews`; normal registered-site publishing uses the configured target (for example `.local/storage`) and reconciles that target's `_previews` prefix. See the [catalog cleanup contract](../../architecture/preview-publishing-contract.html#publish).

## Implementation links

[IMP-05 publication](../implementation/IMP-05-publication.md), [IMP-06 production reconciliation](../implementation/IMP-06-production-reconciliation.md), [IMP-09 discovery](../implementation/IMP-09-discovery.md), [IMP-12 storage adapter](../implementation/IMP-12-provider-boundary.md), [IMP-15 retention](../implementation/IMP-15-provider-retention.md), [IMP-13 preview Action](../implementation/IMP-13-action.md), and [IMP-34 site Action](../implementation/IMP-34-actions.md) provide the producer, cleanup, reader and CI/local paths to verify.

## Remaining — reconciled 2026-10-18

Credit [Cloudflare lifecycle/reconciliation proof](../cloudflare-preview-lifecycle-proof.md): confirmed origin manifest deletion, main publication pruning only the missing revision, retained revision unchanged, warm list withdrawal and eventual direct-link unavailability. Natural lifecycle deletion timing remains unproven and is not pursued under the October 20 owner decision; simulated deletion is not expiry evidence. The parent provider checkbox stays open for AWS origin cleanup and deployed read-error/catalog-write-failure retry on each provider. Reuse one approved disposable scope with T5/T14/T15; preserve unknown/unavailable candidates and neighboring objects. No cloud execution is authorized by this record.

## Coordinated execution plan

The [October 18 provider-proof plan](provider-proof-plan-2026-10-18.md) owns the remaining shared execution matrix (P6, P9), pinned inputs, commands, preservation/cleanup guards and itemized owner approvals. The [October 20 superseding decision](provider-proof-plan-2026-10-18.md#superseding-execution-decision--october-20-2026) makes Claude main the direct executor with reviewed commands and chat OK under the existing A4–A9 scopes; the harness/signature/registry gates are retired. Hosted OIDC evidence remains required for reference-role claims. Unsupported P4–P7 fault cells stay open/not-run; no criteria close without actual evidence. Recurring confirmed-missing P6; P9 configuration checks coverage is planned in [T28](T28-provider-release-regression.md), separately from the one-off fresh-bucket/bootstrap and migration proofs; P9 natural-expiry observation is not pursued. This edit records no new provider result.

## Binding owner amendment — October 20, 2026

The [current provider-proof contract](provider-proof-plan-2026-10-18.md#binding-owner-amendment--october-20-2026-current-execution-contract) supersedes the historical observation instructions above. **A8 is dropped; P9 is not pursued, not passed.** No life site, temporary Cloudflare lifecycle rule, observer sessions or three-hourly polling. Lifecycle-rule correctness is evidenced only by the configuration readback already taken in A4 (`~/.config/artifact-pages-verify/a4-20261020/SUMMARY.md` and raw configuration records); natural expiry is not established or claimed. P6 provider-origin reconciliation and deployed failure/retry proof remain required.

Execution has independent tracks: AWS A5 → A7-AWS → A9 → owner-run teardown; Cloudflare A6 → A7-Cloudflare → restore. A5/A6/A7 retain CLI 0.4.4 / Actions v0.2.0; A9 uses released CLI 0.5.1 / Actions v0.3.0, amending the former 0.5.0 tuple. macOS host AWS CLI 2.36.19 and Terraform 1.16.4 through mise replace Docker (paths in the linked pin amendment). The owner applies Claude-prepared chat-reviewed saved create/destroy plans under `artifact-pages-verify` SSO admin. Use unmodified AWS reference module 0.1.1 with no publisher boundary overlays, provisioner role, CloudFront exception or IAM imports; retain a proof-only test-operator role/policy in the same root for local A7/A9 work. No provider execution or new pass is recorded here; status/assignee remain unchanged.

## Cloudflare A6/A7 recorded evidence — October 24–25, 2026

**Cloudflare local scoped-credential evidence (CLI 0.4.4 darwin_arm64); not hosted Actions/OIDC.** Source: `~/.config/artifact-pages-verify/a6-20261024/evidence/` (`A6-NOTES.md`, `NOTES-A6-part1.md`, `A7-NOTES.md`, `RESTORE-NOTES.md`, `pre/NOTES.md`, `restore/expected-deltas.md`); runbook D1–D11. See the [shared per-cell execution record](provider-proof-plan-2026-10-18.md#cloudflare-a6a7-execution-result--october-2425-2026) and [restoration record](provider-proof-plan-2026-10-18.md#cloudflare-restoration--october-2425-2026). This scoped local run did not exercise Actions v0.2.0 on Cloudflare.

P6 owner-approved single manifest deletion plus a scoped 403 and intact control produced remove/manifest-missing, keep/manifest-unavailable and keep/manifest-present. Write exited **0 synced**, the same v0.4.4 behavior as AWS: unknown candidates are retained, but this does not establish the required failure exit. Normal site retry was no-op. The reader list hid the missing group after sync; the direct route retained the edge-cached manifest until its 300 s shared TTL expired, then showed Preview unavailable. Controlled deletion is not lifecycle expiry. Production failure before switch was NOT-RUN (depends on unsupported P5-index PUT isolation); manifest 503/timeout and post-switch catalog-write failure remain NOT-RUN (no mechanism / D8). Keep the broader deployed-failure criterion open.
