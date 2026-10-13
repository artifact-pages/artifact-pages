# T27 — Launch hosting cost model

- Status: Open
- Phase: Post-launch measurement
- Scope: recorded request counts and storage for the launch workload; Cloudflare R2 first, AWS separately
- Implementer: Codex
- Source: public-launch review 2026-10-13, section 3 (cost part)

## Contract to prove

The launch budget rests on recorded request counts and storage, not on earlier estimates. Pricing: [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/) as of the measurement date; AWS is modelled separately because its billing units differ.

## Exit criteria

- [ ] Record request counts and stored bytes for: sites x objects x publishes; preview heads x retention; views x cache-miss rate, and search queries (index, shards, packs); purge calls.
- [ ] Convert them with current R2 pricing, and AWS pricing separately.
- [ ] No paid load test is run without owner approval.
- [ ] The result notes that `app deploy` keeps old hashed assets on purpose (warm browsers and rollback). Any future garbage collection first needs a maximum tab lifetime and a rollback retention period.

## Evidence

(empty)
