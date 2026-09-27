# IMP-06 — Production publish preview reconciliation

- Status: Done
- Phase: Phase 1 local proof; provider-origin behavior remains post-MVP
- Depends on: [IMP-05](IMP-05-publication.md) and the existing production publish integration point.
- Proves: [T8](../verification/T8-stale-reference-cleanup.md)

## Outcome

Make ordinary site publish prune only preview catalog references whose manifests are confirmed absent, after the production projection is committed to the configured backend. Keep this in the CLI's normal publish operation, not a separate cleanup workflow.

## Acceptance criteria

- Merged, closed-unmerged, open and manual groups with live manifests remain discoverable; no PR-state query or separate cleanup workflow is introduced.
- Failed production publish does not change preview catalog; successful production update plus catalog-write failure reports incomplete cleanup for retry.
- The local CLI invokes the provider-neutral `publisher.PublishSite` reconciliation path. Local tests cover provider read errors, idempotent retry, and site-scoped effects. CI wrapper parity is outside this ticket and remains in [IMP-34](IMP-34-actions.md) and [T8](../verification/T8-stale-reference-cleanup.md).

## Evidence

`internal/publisher/site_publish_preview_test.go` verifies that production projection writes precede catalog pruning, that live open/merged/closed PR fixture groups and a manual group remain when their manifests exist, that a failed production write leaves the catalog unchanged, and that a failed catalog write reports retryable incomplete cleanup and converges on retry. `internal/preview/store_test.go` covers unavailable-manifest retention, idempotence, and isolation from other sites. `cmd/artifact-pages/main_test.go` exercises the shared operation through the local CLI process. These are local backend proofs; CI Action parity and real AWS/Cloudflare origin behavior remain separate verification gates.
