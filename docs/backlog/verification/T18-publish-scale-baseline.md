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

## Pre-change Cloudflare baseline

This separate live baseline used publisher revision `182a6bc4fb94955628a4462e3eeb0fa7ed563872`, the committed scale corpus at `fc00c139`, and verification config commit `d39a65eb`. The provider target was R2 bucket `artifact-pages-verify` with public origin `https://artifact-pages.stream`. A read-only registry dry-run showed exactly the pre-existing `smoke` registration and five scale-site creates; the authorized registration then added `verify-scale-{10,100,1000,5000,10000}` and retained `smoke`. Commands ran in a clean `env -i` environment with only `PATH`, `HOME`, `CF_VERIFY_R2_ACCESS_KEY_ID`, `CF_VERIFY_R2_SECRET_ACCESS_KEY`, and `CF_VERIFY_API_TOKEN`; no production config or `CF_R2_*` values were supplied.

The measured publishes used `--fulltext=false`:

| Site | Source files (pages / resources) | Run | Outcome | Changed objects | Wall time |
| --- | ---: | --- | --- | ---: | ---: |
| `verify-scale-10` | 10 (2 pages: 1 HTML, 1 Markdown; 8 resources) | first | `published` | 12 | 9.77 s |
| `verify-scale-10` | 10 (2 pages: 1 HTML, 1 Markdown; 8 resources) | repeat | `no-op`; zero changes and invalidation paths | 0 | 3.19 s |
| `verify-scale-100` | 100 (10 pages: 7 HTML, 3 Markdown; 90 resources) | first | `published` | 102 | 52.12 s |
| `verify-scale-100` | 100 (10 pages: 7 HTML, 3 Markdown; 90 resources) | repeat | `no-op`; zero changes and invalidation paths | 0 | 12.66 s |

The preflight and publication command forms were `artifact-pages registry register --config artifact-pages.verify.yaml --dry-run --format json`, then the same registration without `--dry-run`, followed by each site twice with `artifact-pages site publish --config artifact-pages.verify.yaml --site <verify-scale-id> --fulltext=false --format json`. `/usr/bin/time -p` recorded the wall times. The actual clean-environment commands, JSON results, time files, and empty stderr captures remain in ignored `.local/publish-scale-cloud-baseline/RESULTS.md` and sibling files. The CLI's changed-object counts are not provider request counts. The Cloudflare adapter exposed no request/byte counters, so provider requests and transfer bytes were not measured.

## Candidate state-assisted measurements — pending

Post-change Cloudflare measurements are pending the final candidate run. Keep them separate from the pre-change values above and use the same verification bucket, fixture revision, full-text setting, and command sequence. Do not estimate provider request counts or bytes from changed-object counts. Record candidate no-op and explicit `--reconcile` results only after the commands complete; retain the raw JSON/time output under ignored `.local/`.

## Final evidence

Add the post-change in-memory interface-count table here after implementation, with the exact test command and fixture revision. Keep raw logs under `.local/`, and compare the same source revision/profile and desired state. Report remote call counts at the shared interface boundary unless an adapter-level test measures provider pagination and batching directly.
