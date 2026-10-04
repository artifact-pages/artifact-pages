# T19 — Publish-state layout and provider-cost comparison

- Status: Done
- Phase: Local verification of the provider-neutral publishing contract
- Primary lane: CLI
- Participating lanes: Infra
- Related: [T5](T5-concurrency-recovery.md), [T14](T14-production-reconciliation.md), [T18](T18-publish-scale-baseline.md)

## Proof needed

- [x] Compare the current flat compressed state with recursive two-slot directory nodes, fixed two-slot hash shards across shard counts, and a fixed-64 hybrid that keeps generated projection rows at the coordinator.
- [x] Compare explicit HTTP policy rows separately from policy-profile-factored rows; keep each topology's output and policy semantics equivalent.
- [x] Use the real builder's desired object set as the oracle and exercise a repeatable size × changed fraction × path-distribution matrix, including resource changes, page changes, rename/delete, full-text output, and global input changes.
- [x] Count layout-only state HEAD/GET/LIST/PUT/DELETE requests, request bodies, current/peak retained state bytes, bootstrap, pending/commit retries, and unreachable-object cleanup. Report common publisher projection operations separately.
- [x] Verify prototype projections and metadata against the builder's desired output, including changed/reverted retries, interruption recovery, cache failure, and directory-state GC.
- [x] Apply current provider pricing to normalized monthly request/storage/transfer quantities, with free allowances and billing rounding shown separately; distinguish modeled provider operations from adapter request logs.
- [x] Obtain independent protocol/fee review and record the cost-profile recommendation; no production default was changed by this verification.

## Method and results

### Reproduction and provenance

The full workload sweep and prototype reports were generated locally on 2026-10-04. They make no provider calls. Both sweep JSON files record base product revision `67e55aa6884429e7e21dda9b58c1acde77a772fd` (the harness files were then untracked), Go `go1.26.7`, and seed `26214277158`. The full-sweep source snapshot had harness SHA-256 `ec635cc22ce0aa113a7790ed9f803162c22c9095671827aaa30ac7ca368d0ae2`; the later monthly-only no-op counting optimization produced the source snapshot used for the monthly run, SHA-256 `7d930fae81ab60211b2f815cb8763ae113a8e98c0cab20325a4fb4c2adc1e52a`. That optimization changes how monthly no-op reads are counted and extrapolated; it does not change the full-profile scenarios or transition logic. The final harness is committed as `1c6592b4` (layout model) and `4dcf68de` (scale/cost sweep); the fusion harness was committed as `76924700`. Reproduce the full profile from the repository root with:

```sh
ARTIFACT_PAGES_STATE_LAYOUT_SWEEP=1 \
ARTIFACT_PAGES_STATE_LAYOUT_SWEEP_PROFILE=full \
  go test ./cli/internal/publisher -run '^TestSitePublishStateLayoutSweep$' -count=1 -v
```

The report is `.local/publish-scale-state-layout-sweep/state-layout-sweep.json`. The separate layout transition and recovery reports are `.local/publish-scale-state-layout-matrix/state-layout-matrix.json` and `recovery-sequence.json`; rerun both with `ARTIFACT_PAGES_STATE_LAYOUT_MATRIX=1 go test ./cli/internal/publisher -run '^TestSitePublishStateLayout(Matrix|Recovery)$' -count=1 -v`.

The fusion prototype used the same source revision and fixture, with SHA-256 `7d5dd97ab30c65cba67db9d2a5595bc818ef05ab44b56f0e8127b82b4798c85e` for `cli/internal/publisher/site_publish_state_layout_fusion_test.go`. Reproduce it with:

```sh
ARTIFACT_PAGES_STATE_LAYOUT_FUSION=1 \
  go test ./cli/internal/publisher -run '^TestSitePublishStateLayoutFusion$' -count=1 -v
```

Its output is `.local/publish-scale-state-layout-fusion/fusion.json`. The local JSON files are generated evidence and are not Git-managed.

The full sweep completed in 322.40 seconds. The monthly profile completed in 667.58 seconds with harness SHA-256 `7d930fae81ab60211b2f815cb8763ae113a8e98c0cab20325a4fb4c2adc1e52a`; reproduce it with `ARTIFACT_PAGES_STATE_LAYOUT_SWEEP=1 ARTIFACT_PAGES_STATE_LAYOUT_SWEEP_PROFILE=monthly ARTIFACT_PAGES_STATE_LAYOUT_SWEEP_OUTPUT=.local/publish-scale-state-layout-sweep/state-layout-sweep-monthly.json go test ./cli/internal/publisher -run '^TestSitePublishStateLayoutSweep$' -count=1 -timeout=15m -v`. It reports the same base product revision and fixture seed. The monthly JSON is also generated under ignored `.local/`.

### Inputs and compared models

The sweep rebuilt the five committed `verify-scale-*` fixtures through the real indexer and compared serialized-state transitions against those desired projections. Across the fixtures there are 16,110 source files: 1,612 HTML/Markdown pages and 14,498 resources. Each site also produces generated index/search objects; those counts are recorded separately below. The 136 workload rows cover 17, 23, 30, 33 and 33 scenarios at the five sizes, respectively. Each row evaluates 17 state variants. Coverage includes no-op, single-file and rounded percentage changes, uniform, clustered and 80%-in-one-subtree patterns, resource-only and page-only edits, full-text on/off and sparse page edits, rename/delete, dense changes, and site-title, ref and builder-policy changes. The 1,000-file topology sensitivity remaps source keys into flat, deep-chain, broad and skewed trees and runs five mutation patterns on each; it preserves built output rows and is limited to state fanout/depth analysis.

| Fixture source files | Pages | Resources | Source bytes | Generated objects, full text off / on |
| ---: | ---: | ---: | ---: | ---: |
| 10 | 2 | 8 | 10,750 | 2 / 5 |
| 100 | 10 | 90 | 151,030 | 2 / 39 |
| 1,000 | 100 | 900 | 1,531,537 | 2 / 59 |
| 5,000 | 500 | 4,500 | 7,665,970 | 2 / 111 |
| 10,000 | 1,000 | 9,000 | 15,390,349 | 2 / 129 |

The layouts are prototypes, not shipped adapters: the current flat state with full HTTP-policy rows; a profile-factored flat codec; recursive two-slot directory nodes with both codecs; fixed two-slot shards at K=1, 4, 16, 64, 128 and 256 with both codecs; and a K=64 hybrid that keeps generated rows in the coordinator. The topology comparison keeps HTTP semantics equivalent and separates codec compression from layout. Every modeled transition reads and writes serialized state through the traced store, then checks reconstructed keys, content hashes and HTTP metadata against the builder's desired projection.

The report separates private-state and retry-journal calls/body bytes from common source/index projection PUTs and DELETEs. `commonProjectionDelta` records actual desired source/generated object changes; those requests and bytes do not belong to the layout-only columns. The estimates exclude registry, preview pruning, lock work, CDN invalidations, provider latency and HTTP/TLS overhead. Build preparation hashes local inputs in O(source bytes); a matching fingerprint skips `BuildPrepared`, but does not eliminate that local hashing cost.

### Representative measurements

Counts below are modeled object-store calls for private state only, in `HEAD / GET / LIST / PUT / DELETE` order. Bytes are serialized state bodies. Common projection changes are shown separately.

| Fixture / workload | Common projection delta | State variant | State calls | State body read / written | Persistent state after / peak | Retained old/unreachable bytes |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| 1,000 / no-op | 0 PUT, 0 B | Flat explicit | 1 / 0 / 0 / 0 / 0 | 0 / 0 B | 41,078 / 41,078 B | 0 B |
| 1,000 / 1% mixed, uniform | 10 PUT, 18,514 B | Flat explicit | 1 / 1 / 0 / 2 / 0 | 41,078 / 82,354 B | 41,096 / 41,258 B | 0 B |
| 1,000 / 1% mixed, uniform | 10 PUT, 18,514 B | Directory explicit | 1 / 18 / 0 / 19 / 0 | 26,834 / 27,442 B | 81,046 / 81,227 B | 26,472 B |
| 1,000 / 1% mixed, uniform | 10 PUT, 18,514 B | Fixed K=64, explicit | 1 / 9 / 0 / 10 / 0 | 15,277 / 20,518 B | 90,236 / 90,464 B | 10,297 B |
| 1,000 / 100% mixed | 1,001 PUT, 1,642,347 B | Flat explicit | 1 / 1 / 0 / 2 / 0 | 41,078 / 85,557 B | 41,028 / 44,529 B | 0 B |
| 1,000 / 100% mixed | 1,001 PUT, 1,642,347 B | Directory explicit | 1 / 37 / 0 / 38 / 0 | 54,511 / 57,911 B | 108,645 / 111,698 B | 54,149 B |
| 1,000 / 1% full-text page-only | 17 PUT, 25,800 B; 4 DELETE; 7 generated PUTs | Flat explicit | 1 / 1 / 0 / 2 / 0 | 43,592 / 87,620 B | 43,698 / 43,922 B | 0 B |

The 1% mixed 1,000-file case changed 10 source paths (2 pages, 8 resources), from 18,074 to 18,514 bytes across 7 directories. With full text off, this changed source objects but did not change generated output. For the full-text page-only case, the common delta includes changed search/index output and is identical for every state layout.

At 10,000 files the full-text-off flat manifest is 398,180 B at no-op; the profile-factored flat body is 394,309 B. Directory explicit is 462,380 B spread across 141 committed state objects; the K=64 hybrid and fixed-shard variants are 473,116 B and 472,908 B across 65 objects. Every variant's modeled no-op issues one state `HEAD`, reads no state body, and performs no state mutation. For a 10,000-file 0.1% uniform change (10 source paths), the common projection delta is 10 PUTs / 9,129 B; flat explicit reads 398,180 B and writes 796,656 B across its pending and committed CAS writes, while fixed K=64 reads 72,241 B and writes 77,516 B but makes 10 state GETs and 11 PUTs and retains 67,257 B in old slots. These rows expose the trade: flat reads/writes the whole compressed manifest for a changed publication, while sharding can lower those body bytes in sparse cases by doing more operations and retaining more state.

The 10,000-file single-file update makes the operation trade concrete. Flat uses `1 HEAD / 1 GET / 2 PUT`; recursive directories use `1 / 6 / 7`; fixed K=64 uses `1 / 2 / 3`. Their state body read/write sizes are 398,180/796,464 B, 7,538/7,982 B and 12,578/17,663 B, respectively. Across each workload, the common object projection is the same for all state layouts. For the 10,000-file single edit, 1% clustered page edit, 1% uniform edit, 10% uniform edit and full edit, the one-transition R2 Class A/B request costs (before storage) are:

| Workload | Flat | Directory | Fixed K=64 |
| --- | ---: | ---: | ---: |
| Single file | $0.00000972 | $0.00003402 | $0.00001458 |
| 1% clustered pages | $0.00000972 | $0.00003402 | $0.00026244 |
| 1% uniform | $0.00000972 | $0.00038394 | $0.00024786 |
| 10% uniform | $0.00000972 | $0.00064638 | $0.00032076 |
| Full site | $0.00000972 | $0.00069012 | $0.00032076 |

With S3 Standard `us-east-1` and its shared 100 GB transfer allowance already consumed, a modeled changed publication plus one month of resulting state costs about $0.0000527 / $0.0000485 / $0.0000275 for flat/directory/K=64 on a single-file edit; about $0.0000527 / $0.0000484 / $0.0003421 for 1% clustered pages; $0.0000527 / $0.0004640 / $0.0003238 for 1% uniform; $0.0000528 / $0.0007765 / $0.0004162 for 10% uniform; and $0.0000527 / $0.0008254 / $0.0004162 for a full update. These state-only estimates combine request charges, measured state-body egress and one month of resulting state storage; they exclude common projection and control-plane costs and are not a full bill. When the 100 GB allowance remains available, the transfer term is zero in this comparison and flat has the lowest request-plus-storage amount in each case. The S3 crossover therefore depends on path distribution and transfer quota, not just the changed-file percentage.

The empty-prefix committed-snapshot bootstrap at 10,000 files writes one 398,180 B state object for flat explicit, 141 objects / 462,380 B for directory explicit, and 65 objects / 472,908 B for K=64 fixed shards. This is a snapshot-seeding comparison only. It excludes the transaction's pending/final state writes, cache-retry journal, source/index upload, registry/preview work, and absent-state inventory LIST/HEAD requests. Per-transition peak bytes include modeled pending/alternate slots; inactive or unreachable node/shard bytes are reported separately.

### GET-only and fused-journal prototype

The second report compares four local variants: current HEAD plus separate retry journal; GET-only plus separate journal; current HEAD plus fused journal; and GET-only plus fused journal. It uses the 1,000-file fixture (100 pages, 900 resources, 1,531,537 source bytes) and a changed resource projection. A representative sparse change writes the same common projection for all variants: 2 projection PUTs totaling 80,599 B.

| Variant / step | State+journal class A / class B requests | State body read / written | Journal body read / written | Projection PUTs / bytes |
| --- | ---: | ---: | ---: | ---: |
| Current HEAD + separate journal, sparse change | 3 / 3 | 41,376 / 82,989 B | 0 / 421 B | 2 / 80,599 B |
| GET-only + separate journal, sparse change | 3 / 2 | 41,376 / 82,988 B | 0 / 421 B | 2 / 80,599 B |
| Current HEAD + fused journal, sparse change | 2 / 3 | 41,376 / 41,377 B | 0 / 562 B | 2 / 80,599 B |
| GET-only + fused journal, sparse change | 2 / 2 | 41,376 / 41,376 B | 0 / 562 B | 2 / 80,599 B |
| Current HEAD + separate journal, no-op | 0 / 2 | 0 / 0 B | 0 / 0 B | 0 / 0 B |
| GET-only + separate journal, no-op | 0 / 2 | 41,376 / 0 B | 0 / 0 B | 0 / 0 B |

The fused sparse transition saves one modeled Class A request and 41,471 control-write bytes in this fixture while keeping projection writes equal. GET-only saves one Class B request on a changed transition by replacing the HEAD-plus-GET pair with a single GET. On a no-op, the Class B count remains two (cache journal GET plus state HEAD/GET), while GET-only reads 41,376 B of state. Combining fusion and GET-only with the current HEAD/separate-journal prototype saves one Class A and one Class B per changed run—$4.86 per million such changed runs at R2 Standard rates after allowances are consumed. It is not a no-op request-count saving, and external S3 egress from the no-op body GET can outweigh one saved Class B request. The report also injects cache-failure and journal-only interruption/restart sequences, including a mismatched-base rejection; these establish only the serialized local state-machine model.

The fusion comparison is a test-local schema-2 state envelope and cache journal; it does not call the production publisher or prove provider-side behavior. Production uses the separate schema-1 record shape. The separate-journal variant is a protocol-style baseline, not a capture of every byte in the production state. Its committed state and origin objects are preseeded outside per-step counters, so the run does not include cold bootstrap. The transaction IDs use `crypto/rand`; their values and report bytes are not exactly reproducible. Injected failures cover partial projection writes, cache invalidation, journal PUT before pending-state CAS, cold restart, and mismatched-base rejection. ETag checks are local comparisons, not provider-side conditional-write races or lost-response tests.

### Persistent 30-day workload model

The 1,000-file monthly profile uses the 1,000-source-file fixture and runs each of five mixes with full text off and on. Each mix models 1,000 runs over 30 days; one HEAD-only no-op is executed per layout/mix and its exact request and zero-byte counts are multiplied by the scheduled number. Changed transitions run through persistent serialized state. Where a workload has a periodic changed sequence, cycles two and three must match in request counts, body bytes, and per-step storage footprint before later cycles are extrapolated. The report records both simulated and extrapolated changed runs. Each profile ends with one directory-state GC; fixed-shard variants do not run GC.

| Mix | Runs: no-op / sparse 1% / full / rename-delete | Changed transitions measured / extrapolated (period) |
| --- | ---: | ---: |
| No-op only | 1,000 / 0 / 0 / 0 | 0 / 0 (none) |
| Quiet | 970 / 9 / 1 / 20 | 30 / 0 (60) |
| Reference | 870 / 90 / 10 / 30 | 78 / 52 (26) |
| Active | 470 / 450 / 50 / 30 | 318 / 212 (106) |
| Dense-heavy | 70 / 0 / 900 / 30 | 186 / 744 (62) |

The directory's end-of-month GC adds one LIST request plus 38 GETs and deletes 36 unreachable state objects in full-text-off mode; with full text on it adds one LIST, 39 GETs, and deletes 37 objects. Deletes are free under the modeled R2/S3 request schedules. Fixed K=64 has no GC run: its reported retained bytes are inactive/unreachable slots left at month end, not objects collected by GC. In the reference mix, average/maximum daily peak state bytes are 43,327/44,537 flat, 108,942/111,808 directory, and 153,348/158,422 K=64 with full text off. With full text on, they are 46,818/47,243; 116,307/119,146; and 166,884/167,572 bytes. K=64 retains about 74,952 B (off) / 79,046 B (on) of inactive slots after zero GC runs; directory GC reduces 54,208 B / 57,209 B of unreachable bytes to zero.

The following totals are for the private state workload only, before common publisher operations. R2 standalone bills are $0 for all ten rows because this isolated workload remains within Standard storage and request free allowances. “R2 consumed” assumes those account allowances have already been used and gives unrounded request plus measured storage cost. S3 same-region is a conservative storage upper bound with request charges; the external-runner column assumes the shared transfer allowance is consumed and adds only measured state-body egress. All three layout values in each cell are ordered flat / directory / K=64. S3 storage is an upper bound based on daily peaks because update durations are not modeled.

| Mix | R2 consumed ($) | S3 same-region upper bound ($) | S3 external, transfer allowance consumed ($) |
| --- | ---: | ---: | ---: |
| No-op only, full text off | 0.000360616 / 0.000378998 / 0.000361199 | 0.000400880 / 0.000421368 / 0.000401712 | 0.000400880 / 0.000425937 / 0.000401712 |
| Quiet, full text off | 0.000641420 / 0.002623661 / 0.002212069 | 0.000712886 / 0.002915572 / 0.002458326 | 0.000816157 / 0.002971600 / 0.002503683 |
| Reference, full text off | 0.001577450 / 0.013989614 / 0.014049860 | 0.001752928 / 0.015544534 / 0.015611685 | 0.002200556 / 0.015886810 / 0.015925810 |
| Active, full text off | 0.005321468 / 0.057196857 / 0.059784336 | 0.005912954 / 0.063552595 / 0.066427793 | 0.007737983 / 0.064979497 / 0.067780734 |
| Dense-heavy, full text off | 0.009065468 / 0.167287377 / 0.298047636 | 0.010072954 / 0.185875395 / 0.331164793 | 0.013270670 / 0.190094003 / 0.337389351 |
| No-op only, full text on | 0.000360654 / 0.000379402 / 0.000361258 | 0.000400934 / 0.000421830 / 0.000401797 | 0.000400934 / 0.000426645 / 0.000401797 |
| Quiet, full text on | 0.000641480 / 0.002176814 / 0.005775297 | 0.000712971 / 0.002419049 / 0.006417737 | 0.000822630 / 0.002457761 / 0.006539691 |
| Reference, full text on | 0.001577502 / 0.010641545 / 0.027570583 | 0.001753003 / 0.011824491 / 0.030634775 | 0.002228754 / 0.012042645 / 0.031245224 |
| Active, full text on | 0.005321508 / 0.042962387 / 0.094688994 | 0.005913012 / 0.047736552 / 0.105210790 | 0.007853090 / 0.048646967 / 0.107348773 |
| Dense-heavy, full text on | 0.009065567 / 0.176035894 / 0.298295680 | 0.010073096 / 0.195596019 / 0.331440456 | 0.013471567 / 0.200077279 / 0.337981813 |

These are normalized modeled costs rather than an account invoice: common lock, retry, registry, preview, artifact/index projection and CDN work are omitted, and provider billing was not queried. AWS currently includes 100 GB of Internet data transfer out per month, aggregated across AWS services and regions except China and GovCloud. The free allowance is shared with other account usage, so this report shows it only as a sensitivity alongside the consumed-allowance case; it does not allocate the allowance independently to the publish-state subsystem. R2 free tiers must likewise be applied to aggregate account usage.

### Pricing model and limitations

The run captured the official [Cloudflare R2 pricing page](https://developers.cloudflare.com/r2/pricing/) on 2026-10-04 (page updated 2026-10-01): R2 Standard Class A (`PUT` and `LIST`) at $4.50/million, Class B (`GET` and `HEAD`) at $0.36/million, storage at $0.015/decimal-GB-month, 1M Class A / 10M Class B / 10 GB-month included, free deletes and free egress. R2 rounds usage up to billing units after monthly allowances. Modelled LIST pages use 1,000 keys per request; deletes are free operations. The report retains per-transition unrounded marginal cost separately from any monthly aggregate.

The S3 snapshot uses S3 Standard in `us-east-1`: $0.005/1,000 Class A (`PUT`/`LIST`) requests, $0.0004/1,000 Class B (`GET`/`HEAD`) requests and $0.023/binary-GB-month; `DELETE`/`CANCEL` requests are treated as free. The transfer sensitivity uses AWS's shared 100 GB/month Internet DTO allowance; the consumed-allowance column assumes aggregate account usage has exhausted it. Sources: [Amazon S3 pricing](https://aws.amazon.com/s3/pricing/), its [current regional price list](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/us-east-1/index.json), the [AWS data-transfer pricing page](https://aws.amazon.com/ec2/pricing/on-demand/) and the [AWS Global Network FAQ](https://aws.amazon.com/about-aws/global-infrastructure/global-network/faqs/), which documents the aggregate monthly allowance and exceptions. CloudFront viewer requests, delivery and invalidation are common to every state layout and are excluded from this state-only comparison; its pricing references are [CloudFront pricing](https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/) and [invalidation pricing](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/PayingForInvalidation.html).

These values are cost-model inputs, not measured provider billing. The prototype's calls and object-body bytes are not Cloudflare or AWS HTTP request logs: there is no provider latency, SDK retries, HTTP framing, provider pagination trace, or transfer capture. The S3 external-runner state-body egress field is a lower bound and excludes LIST response bodies and protocol overhead. R2 has free egress under the captured Standard schedule. Monthly account use must aggregate common publisher operations with these state calls before applying allowances and billing-unit rounding. The monthly report models the private-state component only; it does not query an account balance or provider invoice.

### Recommendation

Keep flat compressed state as the production default. On R2 Standard and same-region S3, request-priced monthly results favor flat across the five workload mixes and both full-text modes. The external, quota-consumed S3 sensitivity is workload-dependent: K=64 is lowest for one isolated changed file, directory state is narrowly lowest for a clustered page change, and flat is lowest for the tested uniform and dense changes. When the shared 100 GB monthly DTO allowance remains available, the modeled transfer difference drops out and flat wins the tested single-transition comparisons. These results do not justify automatically selecting a different persistent layout for each publication; the layout must remain in the committed state schema and change only through an explicit migration.

Provider-specific optimization should be a small adapter policy based on the actual cost profile (storage class, runner region/network path, remaining transfer quota and workload), not provider name alone. The test-local GET-only/fused-journal prototype suggests a changed-run saving of one Class B and one Class A operation versus the historical separated-state transaction. Production now uses the fused journal and selects GET-only reads for R2 while keeping HEAD-plus-GET elsewhere; see [T20](T20-publish-state-and-candidate.md) for production fault and adapter verification. The shared core retains build input summaries, diff semantics, transaction journal, ordering, and recovery. Preview publication follows the compatible plan-once/apply-only-missing-creates shape while retaining its immutable full-byte verification; the comparison predicate is intentionally not shared with mutable production publication.

The independent reviewer signed off on the modeled fusion recovery and fee arithmetic. `go test ./...`, `go test -race ./internal/publisher`, and `go test -race ./internal/preview` passed for the measurement implementation. This item completes the requested layout and cost comparison; provider-wire billing remains unmeasured and is not claimed here.
