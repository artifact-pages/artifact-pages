# IMP-06 — Production publish preview reconciliation

- Status: Open
- Phase: Post-MVP preview
- Depends on: [IMP-05](IMP-05-publication.md) and the existing production publish integration point.
- Proves: [T8](../verification/T8-stale-reference-cleanup.md)

## Outcome

Make ordinary site publish prune only preview catalog references whose manifests are confirmed absent, after the production projection is committed at origin. Keep this in the CLI's normal publish operation, not a separate cleanup workflow.

## Acceptance criteria

- Merged, closed-unmerged, open and manual groups with live manifests remain discoverable; no PR-state query or separate cleanup workflow is introduced.
- Failed production publish does not change preview catalog; successful production update plus catalog-write failure reports incomplete cleanup for retry.
- Local and CI invocations use the same core reconciliation operation; tests include provider read errors and idempotent retry without touching other sites.
