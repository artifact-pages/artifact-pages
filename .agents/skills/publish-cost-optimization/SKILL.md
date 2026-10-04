---
name: publish-cost-optimization
description: Compare and improve the cost or performance of build, diff, state, publish, or preview workflows using measured provider behavior and preserved correctness. Use for optimization investigations, not ordinary bug fixes.
---

# Publish cost and performance investigations

Use this skill when the requested work is to reduce provider cost, request volume, build time, or publish latency in a stateful content pipeline. Keep the user's stated objective primary: cost and latency are separate measures, and the cheapest design is not automatically the fastest.

Preserve the task's existing scope and authorization. This skill does not authorize cloud mutations, resets, pushes, tags, or releases. Ask for the needed authorization only when the concrete operation requires it; continue with local or read-only evidence meanwhile. Do not turn one project's compatibility choice, release policy, or model assignment into a universal rule.

## Establish the contract and objective

Read the repository instructions and current product contract before changing architecture. Identify the actual entrypoints, provider adapters, persisted state, build outputs, failure/retry behavior, and the user's cost or latency goal. Separate accepted behavior from hypotheses and past implementation choices.

Ask or infer from the task which objective matters: request fees, bytes stored/transferred, total invoice, wall time, CPU, or a stated combination. Keep latency and billable usage in separate columns. Do not optimize a metric the user did not ask to improve at the expense of their goal.

## Price the real operation

Use current primary provider pricing and API documentation. Record the access date, provider, region or transfer path, storage class, request classes, and pricing units. Check which actions are billed as reads, writes, listings, deletes, storage, retrieval, or transfer; include CDN/cache behavior and whether the origin request actually traverses a CDN.

Model allowances and rounding as account-level rules: distinguish per-request marginal cost from invoice cost, shared free allowances from workload-local allowances, daily-average storage from peak storage, and rounded billing units from raw counts. State assumptions where account usage or deployed configuration is unknown. Link the specific primary sources used; do not carry old prices forward as current.

## Define a trustworthy build fingerprint

Before adding an early no-op path, enumerate every input that can change published bytes or HTTP representation: source bytes and paths, repository/ref/update metadata, site metadata, generated timestamps, full-text/index policy, HTTP headers, and builder or format versions. Include dependencies discovered from the current implementation. If an output depends on invocation time, mutable external data, or an unresolved file state, either capture that value in the fingerprint or disable reuse for that case.

Bind the fingerprint to an immutable prepared snapshot. Build and upload from the captured bytes, or revalidate a content digest immediately before applying the plan; do not fingerprint one tree and later publish a different read. Check for concurrent source edits and document unavoidable local work such as hashing all bytes.

Measure two different opportunities separately: an unchanged-input fast path that can skip the build, and an object-level diff after changed input has been built. A root fingerprint can avoid build work; it does not by itself make changed-input comparison incremental.

## Compare layouts as hypotheses

Compare compact flat manifests, directory/Merkle summaries, and fixed shards or chunks only when they fit the actual workload. Count metadata fetches and writes, per-object reads, listing pages, state bytes, write amplification, retained inactive slots, and garbage-collection work. A smaller transfer or manifest is not a cost saving unless the provider's price model makes it one.

Measure no-op, sparse and dense changes, additions, deletions, metadata-only changes, renames, reverts, and repair/reconcile paths. Include clustered and scattered edits and relevant directory shapes. Check whether global indexes, search data, catalog files, or other shared outputs change when one source changes. Do not infer a Merkle advantage merely from a tree-shaped data structure.

## Build reproducible evidence

Use deterministic, versioned fixtures suitable for repeated verification. Keep durable representative fixtures tracked when they are part of repository verification; keep generated run state, temporary mutations, and raw transient output ignored. Pin the baseline code revision, candidate revision, fixture profile, seed, and scenario so both sides use the same inputs. If a historical behavior must be modeled after the builder changes, isolate that transformation in test code and label it clearly.

Cover a useful matrix of site sizes, changed-file counts or rates, and distributions rather than one cherry-picked case. Include zero-change, single-file, sparse, and dense changes, with page/resource mixes and generated-output effects. Reinitialize scenarios from the same seed when comparing alternatives; do not let accumulated changes give one candidate a different starting state.

For each phase, record build/prepare time, reconciliation time, total wall time, calls by API operation and provider request class, request payload bytes, bytes read/written, stored state size, listing pagination, and garbage collection. Separate common duties (locks, registry checks, cache work) from the variable state/diff strategy. Report logical publisher calls separately from actual provider HTTP requests; never derive exact wire counts from user-facing CLI output alone.

## Keep correctness and recovery in the comparison

Treat comparison and recovery as part of performance, not follow-up work. Verify final keys, bytes, hashes, sizes, and complete HTTP metadata, plus generated indexes/search output and neighboring-site isolation. Exercise dry-run, interruption at meaningful write/delete/commit boundaries, retry after the desired input changes or reverts, and cache invalidation retry.

Persist enough uncertainty before mutating the origin to recover an ambiguous write. Preserve monotone touched-key information across retries; force uncertain desired keys to be rewritten and uncertain absent keys to be removed. Commit the authoritative root only after ordered projection writes/deletes succeed. Keep cache retries durable until invalidation succeeds. Treat malformed or unknown state as an error; make migration, repair, and compatibility policy explicit instead of silently trusting or deleting state.

Keep correctness, shared diff logic, and transaction recovery in the core. Let provider adapters expose narrow capabilities and read policies, such as whether a conditional GET can replace HEAD-then-GET safely. Avoid separate provider-specific transaction engines or automatic cost tuning based on provider name alone. A preview may share a plan-once/apply-changes pattern while retaining immutable revision semantics and full-byte verification; do not force one diff predicate across different mutability contracts.

## Report and review the decision

State what was measured, what was modeled, and what remains unknown. Identify fake, emulator, and live-provider evidence separately. Include the exact commands, source/fixture/pricing provenance, tested scenarios, result table, chosen design, cost/latency tradeoff, failure evidence, and limitations. If request prices are small relative to allowances, show both marginal and account-invoice views without allocating a shared allowance twice.

When delegating, separate design/review from implementation where useful. Give each contributor a bounded file or subsystem ownership, explicit invariants, acceptance checks, and expected evidence; avoid concurrent edits to the same flow. A model choice made for one investigation is an example, not a requirement for future work.

Build candidate artifacts only from a clean, identified source commit. Record package/source checksums and distinguish local preflight from checks that require an authorized push or remote release gate. This workflow does not grant that authorization.

## Repository examples

These files record one project's contracts and evidence; consult them for context, not as universal defaults:

- [Publisher state contract](../../../docs/specification.md)
- [TD6: fused publish-state design](../../../docs/backlog/technical-design/TD6-fused-publish-state.md)
- [T18: scale baseline](../../../docs/backlog/verification/T18-publish-scale-baseline.md)
- [T19: state layout and cost comparison](../../../docs/backlog/verification/T19-publish-state-layout-cost.md)
- [T20: recovery and candidate verification](../../../docs/backlog/verification/T20-publish-state-and-candidate.md)
- [Delegation guidance](../../../docs/backlog/delegation.md)
