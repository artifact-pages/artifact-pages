# IMP-13 — Thin GitHub Action wrapper

- Status: Done
- Phase: Post-MVP distribution; not Phase 1 implementation authority.
- Depends on: [IMP-11](IMP-11-cli.md), [IMP-12](IMP-12-provider-boundary.md), [IMP-15](IMP-15-provider-retention.md), [IMP-18](IMP-18-cloudflare-preview-adapter.md), [T2](../technical-design/T2-cli-action-interface.md), and [T9](../technical-design/T9-cloudflare-store-mapping.md)
- Proves: [T4](../verification/T4-serving-boundary.md), [T8](../verification/T8-stale-reference-cleanup.md)

## Outcome

Offer optional composite Actions plus a credential-free preview trust-preflight Action. The adopting workflow controls its checkout and provider credentials; the example runs preflight before the provider job requests credentials. The preview Action validates provenance again before building or invoking the CLI and returns typed URLs/results. Workflows decide timing and whether to post a PR comment; no reusable workflow or separate cleanup algorithm is required.

## Acceptance criteria

- The example skips fork-origin PR jobs before any step and completes credential-free preflight before the provider job requests credentials; the preview Action rejects untrusted PR metadata before CLI/provider operations and does not check out PR-head content. Privileged `pull_request_target` is not used.
- Explicit PR input is passed through and validated; absence remains a manual preview even in a PR event.
- Outputs include group-list and PR-contextual revision document URLs from the CLI; Action does not post comments or infer PR provenance.
- Production invocation calls the same CLI cleanup path as local use; source-level workflow checks and CLI/Action parity verify the wrapper contract. Provider-origin cleanup remains a T8 verification gate.

## Source and local evidence

`node scripts/test-actions-parity.mjs` passed. The local parity run exercises the admin, site-publish, and preview wrappers against separate temporary repositories and local targets; it checks typed outputs, failure exit classes, dry-run immutability, preview resource includes, and the shared CLI cleanup path. `verify-preview-pr.mjs` checks explicit same-repository PR identity and selected head SHA, rejects fork-origin events and `pull_request_target`, and preserves omitted PR provenance as a manual preview. The workflow example runs a credential-free preflight job before the provider job assumes credentials, checks out only the base branch, and skips fork jobs before any step runs. This completes the Action source and local contract; the hosted release, live provider behavior, and provider-origin cleanup remain in T8/T16.

The example's immutable Artifact Pages Action and admin-config refs remain release placeholders. No GitHub-hosted Action run or live provider operation has been performed. The composite Action cannot revoke credentials a caller acquired before invoking it, so provider workflows must use the separate preflight before their credential step.
