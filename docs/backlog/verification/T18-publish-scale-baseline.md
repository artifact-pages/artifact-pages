# T18 — Publisher scale baseline and state-manifest comparison

- Status: In progress
- Phase: Local verification of the provider-neutral publishing contract
- Related: [T5](T5-concurrency-recovery.md), [T14](T14-production-reconciliation.md), [T15](T15-provider-delivery.md)

## Proof needed

- [x] Measure the unmodified shared `PublishSite` flow against deterministic, committed multi-site fixtures.
- [ ] Implement state-assisted reconciliation and repeat the same matrix at the same fixture revision.
- [ ] Verify unchanged local inputs can avoid unnecessary build/index work without skipping registry, lock, cache-retry, pending-journal or preview duties.
- [ ] Prove state migration, interruption recovery, dry-run, malformed-state failure, explicit repair, unregister cleanup and neighboring-site isolation.
- [ ] Record final request, byte, manifest-size and local-time results without presenting the local fake backend as a cloud benchmark.

## Baseline method

The opt-in [`TestSitePublishScaleProbe`](../../../cli/internal/publisher/site_publish_scale_test.go) exercises the production `PublishSite` implementation with a deterministic in-memory `ConditionalObjectBackend`, seeded deployed registry, neighboring-site object and private control sentinel. It publishes an initial site, repeats a no-op, runs a dry-run, applies a small add/update/removal, changes registry metadata, enables and disables full text, injects a partial artifact-upload failure followed by a different desired source, and exercises a manifestless legacy state. Each run copies the tracked fixture into ignored `.local/` and retains source modification times.

Run from the repository root:

```sh
for site in verify-scale-10 verify-scale-100 verify-scale-1000 verify-scale-5000 verify-scale-10000; do
  ARTIFACT_PAGES_SCALE_SOURCE="fixtures/scale/sites/$site/source" \
  ARTIFACT_PAGES_SCALE_SITE="$site" \
  go test ./cli/internal/publisher -run '^TestSitePublishScaleProbe$' -count=1 -v
done
```

The fixed 10 ms per-call column below is an illustrative request-latency model (`interface calls × 10 ms`), not a measured provider latency or cost estimate. `LIST` counts one provider-neutral `ListKeys` interface call per prefix, not paginated S3/R2 wire requests. `LISTjson` is the size of the JSON-marshaled returned keys, not wire bytes. GET and PUT byte counts are object body bytes observed at the shared interface. Wall time is local in-memory execution and includes local planning/build work; the interface does not split those stages, so it is not a cloud timing.

## Untouched baseline

Captured before publisher edits at source revision `fc00c139162b3f388ce0771c7135bbced28a5d21`, after correcting the deterministic fixture resource links. The full corpus contains 16,110 files: 1,612 HTML/Markdown pages and 14,498 resources, across source sites sized 10, 100, 1,000, 5,000 and 10,000 files. Generated search-object counts are separate from these source counts.

| Source files | Initial: HEAD / LIST / PUT | Initial wall | No-op: HEAD / LIST / GET / PUT | No-op wall | No-op GET bodies | No-op LISTjson | No-op modeled |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 12 / 2 / 16 | 77.9 ms | 12 / 2 / 7 / 2 | 72.2 ms | 2,579 B | 721 B | 230 ms |
| 100 | 102 / 2 / 106 | 84.0 ms | 102 / 2 / 7 / 2 | 74.5 ms | 8,622 B | 7,810 B | 1.13 s |
| 1,000 | 1,002 / 2 / 1,006 | 129.4 ms | 1,002 / 2 / 7 / 2 | 120.5 ms | 78,036 B | 79,480 B | 10.13 s |
| 5,000 | 5,002 / 2 / 5,006 | 441.3 ms | 5,002 / 2 / 7 / 2 | 289.3 ms | 386,396 B | 397,560 B | 50.13 s |
| 10,000 | 10,002 / 2 / 10,006 | 668.8 ms | 10,002 / 2 / 7 / 2 | 482.1 ms | 774,453 B | 805,162 B | 100.13 s |

Counts include the lock, registry and preview operations. The baseline's no-op makes 10,000 per-object `HEAD` calls at the largest scale, in addition to two complete prefix listings. The 10 ms illustration shows request amplification only; it is not a prediction of wall time because provider latency, paging, concurrency and retries differ. Initial `PUT` count includes provider-neutral calls for site objects and control records.

Full phase JSON logs are retained locally at `.local/publish-scale-baseline/verify-scale-*.log`; they are generated evidence and stay untracked. Every run reported `neighborAndControlPreserved: true`. The harness intentionally makes no Cloudflare, AWS, S3 or R2 request.

## Final evidence

Add the post-change table and exact commands here after implementation. Keep raw logs under `.local/`, and compare the same source revision/profile and desired state. Report remote call counts at the shared interface boundary unless an adapter-level test measures provider pagination and batching directly.
