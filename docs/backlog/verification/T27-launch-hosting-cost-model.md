# T27 — Launch hosting cost model

- Status: In progress
- Assignee: Codex
- Phase: Post-launch measurement
- Scope: recorded request counts and storage for the launch workload; Cloudflare R2 first, AWS separately
- Implementer: Codex
- Source: public-launch review 2026-10-13, section 3 (cost part)

## Contract to prove

The launch budget rests on recorded request counts and storage, not on earlier estimates. Pricing: [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/) as of the measurement date; AWS is modelled separately because its billing units differ.

## Exit criteria

- [ ] Record request counts and stored bytes for: sites x objects x publishes; preview heads x retention; views x cache-miss rate, and search queries (index, shards, packs); purge calls.
- [ ] Convert them with current R2 pricing, and AWS pricing separately.
- [x] No paid load test is run without owner approval.
- [x] The result notes that `app deploy` keeps old hashed assets on purpose (warm browsers and rollback). Any future garbage collection first needs a maximum tab lifetime and a rollback retention period.

## Evidence

[Hosting cost model](../../research/hosting-cost-model.md) records local publish counts for 1k, 5k and 50k pages, reuses the T25 local browser evidence with its provenance, applies current R2/S3/CloudFront list prices to the fixed scenarios, and records 3.60 MB of newly hashed assets in the current app build. Preview lifecycle bytes and calls, registry sync, app-deploy provider calls, and a T27 local Compose/browser rerun remain unmeasured; the first two criteria remain open, so this ticket stays In progress.

T29's completed reader-session and compression re-estimate is recorded in the updated [hosting cost model](../../research/hosting-cost-model.md), with raw reader evidence and calculated results in [hosting-cost-reader-session-results.json](../../research/hosting-cost-reader-session-results.json) and [hosting-cost-model-results.json](../../research/hosting-cost-model-results.json). This evidence updates the reader cost inputs; it does not close T27's still-open preview, registry-sync, app-deploy, or local Compose/browser criteria.

The 2026-10-24 owner-approved no-invalidation / CLI-owned cache policy is handed off in [IMP-82](../implementation/IMP-82-cli-owned-cache-policy.md). [T30](T30-cache-freshness-and-root-latency.md) supplies the separate live freshness/root-latency proof and class-specific origin-rate inputs for its cost follow-up. Reuse T29's measured reader vectors, distinguish modeled class miss rates from observations, and retain the exclusions above; T30 does not close this ticket automatically.
