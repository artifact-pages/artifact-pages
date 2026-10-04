# T19 — Publish-state layout and provider-cost comparison

- Status: In progress
- Phase: Local verification of the provider-neutral publishing contract
- Primary lane: CLI
- Participating lanes: Infra
- Related: [T5](T5-concurrency-recovery.md), [T14](T14-production-reconciliation.md), [T18](T18-publish-scale-baseline.md)

## Proof needed

- [ ] Compare the current flat compressed state with recursive two-slot directory nodes, fixed two-slot hash shards across shard counts, and a fixed-64 hybrid that keeps generated projection rows at the coordinator.
- [ ] Compare explicit HTTP policy rows separately from policy-profile-factored rows; keep each topology's output and policy semantics equivalent.
- [ ] Use the real builder's desired object set as the oracle and exercise a repeatable size × changed fraction × path-distribution matrix, including resource changes, page changes, rename/delete, full-text output, and global input changes.
- [ ] Count layout-only state HEAD/GET/LIST/PUT/DELETE requests, request bodies, current/peak retained state bytes, bootstrap, pending/commit retries, and any unreachable-object cleanup. Report common publisher projection operations separately.
- [ ] Verify every prototype's final projection keys, bytes, SHA and HTTP metadata against the same desired build, including retries after a different or reverted desired tree.
- [ ] Apply current provider pricing to normalized monthly request/storage/transfer quantities, with free allowances and billing rounding shown separately; distinguish actual adapter counters from modeled provider wire operations.
- [ ] Obtain independent review and record the measured recommendation before changing the production default.

## Method and results

The runnable harness, pinned inputs, operation classifications, provider assumptions, actual measurements, and limitations will be recorded here after the comparison completes. A prototype counter is not a provider request log; Cloudflare and AWS figures must be labeled as cost models unless provider wire instrumentation records the requests.

