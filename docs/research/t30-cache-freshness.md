# T30 — No-invalidation freshness and shared-root latency (Cloudflare run, 2026-10-25)

This is the first live run of [T30](../backlog/verification/T30-cache-freshness-and-root-latency.md) on the verification deployment `artifact-pages.stream` (Cloudflare edge in front of R2), run by the Claude main session under the owner's 2026-10-25 approval recorded in [IMP-82](../backlog/implementation/IMP-82-cli-owned-cache-policy.md). It covers Cloudflare only. AWS was not run and stays unverified.

## Conditions

- CLI: released 0.5.2 (the old, purging writer) to build the starting state, released 0.6.1 for the migration, and a local measurement build of 0.6.1 whose root classes switch to `s-maxage=0` (`ARTIFACT_PAGES_T30_ROOT_TTL=0`). The measurement build was never pushed or released; its patch is kept with the run evidence.
- Delivery: the reference Cloudflare module (cache rule `respect_origin` for edge and browser). Web app 0.3.2.
- Sites: `smoke` (2 documents), `verify-scale-100`, `verify-scale-1000` (index ≈97 KB), one preview revision on `smoke`.
- Regions: Japan from the operator's machine (edge colo KIX); North America from a GitHub-hosted `ubuntu-24.04` runner (workflow `t30-probe`). Europe was not measured.
- Traffic: no natural traffic exists on this deployment. All requests are synthetic and back to back, so hit rates in the reader runs are much higher than a long-tail workload would see (see [Decision inputs](#decision-inputs)).
- Tooling: [`scripts/t30/`](../../scripts/t30/README.md). Each root request uses a new TLS connection. Timing is browser→edge only; whether the edge received a 304 from R2 is not observable.
- Raw data: [`t30/*.jsonl.gz`](t30/) (public URLs and timings only); aggregated tables: [`t30/summary.md`](t30/summary.md).

## Results

### Edge behaviour per class

After migration, a first request was a MISS and an immediate second request was:

| Class | Origin `Cache-Control` | Second request |
| --- | --- | --- |
| Registry, site metadata, site index | `s-maxage=5` | HIT |
| Search manifest, artifacts, preview catalog and files, application shell | `s-maxage=0` / `no-cache` | REVALIDATED |
| Hashed search blobs and application assets | `max-age=31536000, immutable` | HIT |

### Freshness after publish (5-second roots)

- An updated artifact was visible on the next request, 0.03–0.04 s after `site sync` returned (3 cycles).
- A changed site index reached the edge 1.2–1.6 s after `site sync` returned (3 cycles), inside the 5-second bound.

### Root latency, 5 s versus 0 s (mean TTFB over the five root URLs, ms)

| Region | 5 s, edge hit (`fresh`) | 0 s, revalidated (`fresh`) | Difference |
| --- | --- | --- | --- |
| Japan | 47 | 99 | 52 |
| North America | 37 | 210 | 173 |

50 samples per URL and kind. When the 5-second copy has expired, the request revalidates like the 0-second case (Japan 87 ms, North America ≈230 ms). The North America penalty is larger because the R2 bucket is far from that edge.

### Reader operations, 5 s versus 0 s (ms, mean / p95, 20 samples)

| Operation | Japan 5 s | Japan 0 s | North America 5 s | North America 0 s |
| --- | --- | --- | --- | --- |
| Cold open of a site (list visible) | 208 / 284 | 247 / 329 | 576 / 691 | 623 / 676 |
| Reload of the site home | 97 / 118 | 155 / 180 | 323 / 369 | 418 / 482 |
| Open a document, go back, open another | no root requests; within noise | | | |

In the 5-second runs, 70–80 % of the root requests during a cold open were edge hits, because samples ran within seconds of each other. With 0-second roots every root request revalidated.

## Finding: negative caching of 404 (fixed)

R2 answers a missing object with a 404 that has no `Cache-Control`. Cloudflare's default negative caching kept it at the edge for about three minutes. Without purges, a path requested while missing stayed 404 for **≈177 s** after it was created (3 cycles: delete, request, recreate, poll). Realistic cases are a site's first preview (the reader asks for `_previews/<site>/catalog.json` before any preview exists), a restored document and a re-registered site.

Fix: the reference Cloudflare module no longer stores 4xx responses at the edge (#226). After a targeted apply of that ruleset on `artifact-pages.stream`, the 404 was `BYPASS` and the recreated path was visible after 0.03–0.04 s (3 cycles). AWS was already unaffected (`error_caching_min_ttl = 0`). Cost: every 404 on content paths now reaches R2, including the 404s the reader expects in normal use.

## Runbook rehearsal

The [cache policy migration guide](../guides/cache-policy-migration.md) was exercised once in each direction:

- **Starting state:** registry, three sites and one preview published with CLI 0.5.2 (old headers: roots 60 s, artifacts and preview revisions 300 s).
- **Migration (steps 1–7):** step 3's Terraform plan showed no cache-rule change; the full apply was skipped because the plan also contained unrelated drift (see below). `registry sync`, `site sync --reconcile` and `app deploy` with 0.6.1 converged every header, and no result contained invalidation fields. The preview helper updated 3 objects and then reported `no-op`. After the 300-second wait, edge headers matched the table above.
- **Rollback (steps 1–7):** an old `site sync` failed on the compatible CLI's publish state as the guide warns ("unknown HTTP policy"). After resetting each site's publish state, `site sync --reconcile` with 0.5.2 rebuilt it and restored the old headers; a second run was `no-op`. The registry and preview catalog kept their new headers, as the guide says they may.
- **Second migration:** 0.6.1 converged everything again; the preview helper reported `no-op`.
- **Not exercised:** migration of legacy journals, because no old run was interrupted, so no journal or `legacy/` backup was ever written.
- **Registry omission:** omitting `verify-scale-100` removed it from the registry and its index returned 404; re-registering and republishing made it visible again. The visibility timing was not conclusive, because more than three minutes had passed since the 404.

## Infrastructure drift (owner decision)

The verification Terraform state manages the R2 custom domain and a WAF rule without an IP allowlist, while the local `terraform.tfvars` says `connect_custom_domain = false` and sets an allowlist. A full apply would detach the custom domain and block the North America runner, so only the cache ruleset was applied (`-target`). Which side is correct is for the owner to decide.

## Decision inputs

The T30 rule keeps 5 seconds when a relevant reader operation improves by at least 20 ms in the mean or 100 ms at p95, and the operation represents the observed workload.

- **Measured gain when the edge already holds the root:** cold open +39 ms mean (Japan) and +47 ms (North America); reload +58 ms and +95 ms mean, +113 ms p95 (North America). These clear the threshold.
- **Whether that gain happens in practice depends on a second request reaching the same edge location within 5 seconds.** These runs forced that. For a long-tail internal-document workload the real hit rate is unmeasured and likely low; no natural-traffic or aggregate edge data was available for `artifact-pages.dev`.
- **Cost of 5 seconds:** a published change to the registry, site metadata or index can take up to 5 s to appear (1.2–1.6 s observed).

The result is therefore conditional. Keeping 5 seconds helps readers when several of them open the same sites within seconds, and costs at most 5 s of delay. Moving to 0 seconds removes that delay but makes every root request revalidate (≈50 ms in Japan, ≈170 ms in North America). The owner decides; production traffic data, if available, would settle the hit-rate question.

## Not verified in this run

- Europe; AWS.
- Natural-traffic hit rates and URL-class frequencies.
- Whether the edge received a 304 from R2 on revalidation (only browser→edge is observable).
- Legacy journal migration on a live provider.
- Search-generation changes and old search-blob 404 recovery in the reader, app update/remove timing, and HTML resources with modules or JSON fetch beyond the reader's own requests.
- Reproducibility over repeated runs on different days (one run per state).

## State left on `artifact-pages.stream`

CLI 0.6.1 headers with 5-second roots; registry `smoke`, `verify-scale-100`, `verify-scale-1000` with content and one `smoke` preview; the cache ruleset with the 4xx override applied. Control records from before the run are kept outside Git with the run evidence.
