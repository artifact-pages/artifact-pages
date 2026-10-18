# ISSUE-112 — Large AWS generated JSON loses compressed delivery

- Status: Open
- Assignee: Codex
- Priority: P2
- Area: AWS / CLI generated reader-data delivery
- Related: [ISSUE-110](ISSUE-110-site-index-deadline-covers-body-download.md), [T25](../verification/T25-web-first-load-and-search-at-scale.md), [T15](../verification/T15-provider-delivery.md)

## Problem

AWS reference deployments can serve a large site index uncompressed despite relying on compressed delivery to meet the reader's accepted 20-second total deadline. Retrying cannot compensate for insufficient throughput. CloudFront automatic compression has a per-object size ceiling; enabling compression in Terraform alone does not remove it.

## Evidence and reproduction

1. The [T25 benchmark](../../research/web-scale-benchmark.md) measured a 50,000-page index at 45.90 MB raw; gzip level 9 was estimated at 2.63 MB. The raw body alone requires about 18.36 Mbps within 20 seconds. The 5,000-page raw index (4.39 MB) repeatedly timed out in the controlled 1.6 Mbps test.
2. [Site projection publication](../../../cli/internal/publisher/site_publish_manifest.go) currently stores generated JSON with no encoding. The [AWS module](../../../terraform/modules/aws/main.tf) enables CloudFront compression, which applies only between 1,000 and 10,000,000 bytes per object; see the [AWS compression contract](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/ServingCompressedFiles.html). A live AWS timeout reproduction was not run in the accepted read-only analysis.
3. Search `manifest.json` is also plain generated JSON and can grow with pack references/omission paths. The benchmark fetched 950.2 kB; no manifest above 10 MB was demonstrated. Search root/leaves/sections/text `.gz` objects are already compressed opaque files, and their aggregate size is not evidence that any one object crosses the ceiling.

## Expected outcome

AWS serves gzip-encoded site indexes and search manifests at the existing URLs, independently of CloudFront's automatic-compression size window. Browsers decode the same JSON schemas with the existing reader. The deadline remains unchanged; encoding does not guarantee every site/network meets it or reduce decoded index memory.

## Settled backend behaviour and implementation brief

**Owner decision, 2026-10-18 (decided):** adopt AWS-only pre-encoding of `/_indexes/<site>/index.json` and `/_indexes/<site>/search/manifest.json`, with accurate `Content-Encoding: gzip`, unchanged URLs/decoded schemas and unchanged 20-second deadline. No further delivery-policy decision is pending.

**Sol decisions, 2026-10-18:**

- Encode both selected objects at **every size**, including empty-site indexes; only emit a search manifest when full-text output exists. Use a single deterministic gzip member, level 9, zero mtime, empty filename/comment and fixed OS header. Hash and size the actual stored gzip bytes. Keep `application/json; charset=utf-8`, inline disposition and existing index cache policy. Keep local builder output JSON plain. Select encoding by the configured AWS adapter, never by endpoint hostname or object size. Cloudflare, directory/local and `gcp-local` keep current delivery.
- Exclude `meta.json`, `sites.json`, preview catalogs/manifests, app bundles, user artifacts/resources and all opaque search `.gz` objects. Those search objects keep their compressed-byte integrity contract and **no HTTP Content-Encoding**; never double-compress them. No reader change, sharding, new service, generic compression flag or Terraform resource is required. Retain the existing AWS cache/Accept-Encoding settings.
- Advance the provider-aware site input-policy fingerprint so unchanged sources migrate on their next successful sync. Preserve transaction journals, CAS/lock guards, upload order, stale cleanup, invalidation and dry-run semantics. Inventory/state/reconciliation comparisons include actual encoding and stored-byte size/SHA. Readers of prior state accept the old plain and new gzip policies only on these two keys; unknown encodings or encoding on other keys remain invalid. Desired policy is adapter-specific, so accepting old state cannot keep AWS plain on a no-op fast path or make other adapters start encoding.
- In `site_publish_prior.go`, validate deployed index stored-byte size/digest and metadata against the committed row **before** decoding. Decode exactly one gzip member with CRC verification, reject trailing data, and cap decoded JSON at 512 MiB (plain prior-index reads use the same cap). On missing/digest-mismatching prior objects retain the existing no-prior fallback. A matching object with unsupported encoding, corrupt gzip, overflow or invalid JSON is an explicit read error before content mutation, not trusted carry-forward. Read both historical plain and encoded indexes; unchanged shallow-checkout attribution must survive migration.
- **Minimum writer: CLI 0.5.0.** Ship the encoding change in that minor series, not a 0.4 patch. Before any migrated AWS publish, pin every writer for that site (local, scheduled and Actions) to 0.5.0+ and stop in-flight old writers. Prepare all four Actions as v0.3.0 with bootstrap CLI 0.5.0 and `cliRange: >=0.5.0 <0.6.0`; refresh official generated setup pins accordingly. The expected v0.2.0 Action `cliRange` is `>=0.4.0 <0.5.0`, **to be confirmed against the v0.2.0 Action release.json in each of the four published Action repositories** before rollout. Record the tag/commit and actual range in the implementation evidence. An Action whose confirmed range excludes 0.5.0 is incompatible with the new writer and must fail the range check rather than silently run it. Release/version/pin implementation belongs to this rollout; actual tags/publication and operator pin/deployment changes require owner approval.
- **Rollback boundary:** after the first migrated AWS commit, supported writer rollback stays at CLI >=0.5.0 with this policy. Revert content using a compatible writer; the web bundle can roll back independently because decoded schemas are unchanged. A 0.4 writer encountering encoded committed state must fail before content writes (pin a released 0.4.4 regression); never delete control state to permit downgrade. Downgrading below 0.5.0 requires an exceptional, quiesced restore of the complete pre-migration site projection **and matching private control records**, with a fresh reviewed recovery plan and owner approval. There is no automated reverse migration or compression-disable switch. A pending transaction must be recovered by a compatible writer before rollback.

Implementation belongs to Luna via the Claude main session. These choices are settled; report any uncovered decision to Sol before implementation rather than selecting a different policy.

## Acceptance criteria

- [ ] AWS small and >10,000,000-byte **decoded** index and search-manifest fixtures are stored as deterministic gzip at unchanged keys; decoded bytes equal builder output and HTTP metadata describes the stored representation. Repeat builds are byte-identical. Synthetic large manifest evidence is labeled synthetic.
- [ ] Prior plain state migrates on unchanged source, dry-run writes nothing, and the next successful sync is a no-op. State/journal size, SHA, HTTP metadata, origin rebuild, metadata repair, interrupted upload/index replacement, cache-failure retry and stale cleanup remain correct; no neighboring site/control/app objects change.
- [ ] Shallow-checkout prior-index tests cover plain→gzip migration and subsequent gzip reads with unchanged Git attribution; corrupted/truncated/concatenated gzip, trailing bytes, overflow, metadata mismatch and digest mismatch follow the settled boundaries above.
- [ ] Released 0.4.4 rejects encoded state before content writes; the new writer accepts both historical policies, and Action range tests reject 0.5.0 under v0.2.0 and accept it under the prepared v0.3.0 metadata. Rollout/recovery instructions state the 0.5.0 floor and prohibit control-state deletion as a downgrade strategy.
- [ ] A controlled HTTP test serves the 50,000-page benchmark with actual `Content-Encoding: gzip`: under the [existing constrained profile](../../research/web-scale-benchmark.md#constrained-profile-cpu-x4-150-ms-rtt-16-mbps-down-075-mbps-up) (CPU x4, 1.6 Mbps downstream, 0.75 Mbps upstream and 150 ms RTT), cold site-index body completion occurs within the existing 20 seconds in three runs and the current reader opens the site. Record bytes/timing, fixture/source/version, browser and profile; distinguish this delivery proof from total rendering time. The 2.63 MB estimate alone is not a test result. Same-URL browser JSON and full-text reads work with gzip and plain prior delivery.
- [ ] Negative coverage preserves Cloudflare/local/emulator representation, source artifact bytes and opaque search gzip length/hash verification. Relevant Go publisher/fulltext, Action/setup range/pin and existing provider route/cache tests pass; no new cloud account/resource is needed for these checks.
- [ ] Rollout documentation records the encoding and remaining throughput constraint, and the specification pointer remains consistent with the owner-owned user-visible wording. Prepare a bounded T15 AWS check for raw S3 stored bytes/metadata and CDN-decoded JSON (small/large, cold/warm, gzip accepted), same URLs and invalidation after migration. **Running it requires separate owner approval**; record actual results before claiming live AWS proof or rollout readiness.

## Prepared live follow-up

The [coordinated provider-proof plan, P10 / A9](../verification/provider-proof-plan-2026-10-18.md) specifies the bounded stored-gzip/CDN proof after this issue ships. It requires a reviewed amendment pinning actually released CLI 0.5.0 / Actions v0.3.0, then separate owner execution approval. Baseline provider proofs continue on CLI 0.4.4; no release, migration or live rollout is authorized here.
