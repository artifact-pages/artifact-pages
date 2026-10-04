# T20 — Fused publish-state recovery and candidate validation

- Status: In progress
- Phase: Local verification and isolated Cloudflare verification target
- Related implementation: [IMP-49](../implementation/IMP-49-fused-publish-state-journal.md)
- Related design: [TD6](../technical-design/TD6-fused-publish-state.md)
- Related baseline: [T19](T19-publish-state-layout-cost.md)

## Proof needed

- [x] Verify older private-control shapes fail closed with exact-site reset guidance; current schema-1 state bootstraps only when the state key is absent.
- [x] Simulate journal and final-root conditional writes that persist but return errors; create a fresh publisher wrapper and prove retry classifies the persisted records correctly.
- [ ] Verify pending journal monotonicity across changed/reverted desired inputs, stale deletions, newly added keys, cache invalidation retry, journal cleanup, and dry-run.
- [ ] Verify Cloudflare R2 state GET returns all HTTP metadata needed for decoding with no state HEAD; preserve AWS HEAD+GET and ETag behavior.
- [ ] Measure operation/body counts for whole publish while reporting private-state/journal and common registry/lock/projection duties separately.
- [ ] Run Go package and race suites, compat-gate unit tests, web package/consumer checks, and candidate preflight at the final source SHA.
- [ ] Publish one bounded content change and a no-op only on the existing `artifact-pages-verify` target; verify the full registry remains intact, public objects match desired bytes/metadata, and private control records are not served.

No production target, infra apply, push, tag, or public release is part of this verification.
