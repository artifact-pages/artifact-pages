# IMP-13 — Thin GitHub Action wrapper

- Status: Open
- Phase: Post-MVP distribution; not Phase 1 implementation authority.
- Depends on: [IMP-11](IMP-11-cli.md), [IMP-12](IMP-12-provider-boundary.md), [IMP-14](IMP-14-provider-serving.md), [IMP-15](IMP-15-provider-retention.md), [IMP-18](IMP-18-cloudflare-preview-adapter.md), [T2](../technical-design/T2-cli-action-interface.md), and [T9](../technical-design/T9-cloudflare-store-mapping.md)
- Proves: [T4](../verification/T4-serving-boundary.md), [T8](../verification/T8-stale-reference-cleanup.md)

## Outcome

Offer an optional Action that prepares checkout/credentials, verifies same-repository PR head identity before publisher access, invokes the CLI, and returns its typed URLs/result. Workflows decide timing and whether to post a PR comment; no reusable workflow or separate cleanup algorithm is required.

## Acceptance criteria

- Fork-origin PR is rejected before provider credentials or untrusted head execution; privileged `pull_request_target` checkout of fork content is not used.
- Explicit PR input is passed through and validated; absence remains a manual preview even in a PR event.
- Outputs include group-list and PR-contextual revision document URLs from the CLI; Action does not post comments or infer PR provenance.
- Production invocation calls the same CLI cleanup path as local use; CI/local parity and failure reporting are verified under T8.
