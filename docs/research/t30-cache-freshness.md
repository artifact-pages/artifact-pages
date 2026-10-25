# T30 — No-invalidation freshness and shared-root latency (Cloudflare run, 2026-10-25)

This is the first live run of [T30](../backlog/verification/T30-cache-freshness-and-root-latency.md) on the verification deployment `artifact-pages.stream` (Cloudflare edge in front of R2), run by the Claude main session under the owner's 2026-10-25 approval recorded in [IMP-82](../backlog/implementation/IMP-82-cli-owned-cache-policy.md). It covers Cloudflare only. AWS was not run and stays unverified.

## Conditions

- CLI: released 0.5.2 (the old, purging writer) to build the starting state, released 0.6.1 for the migration, and a local measurement build of 0.6.1 whose root classes switch to `s-maxage=0` (`ARTIFACT_PAGES_T30_ROOT_TTL=0`). The measurement build was never pushed or released; its patch is kept with the run evidence.
- Delivery: the reference Cloudflare module (cache rule `respect_origin` for edge and browser). Web app 0.3.2.
- Sites: `smoke` (2 documents), `verify-scale-100`, `verify-scale-1000` (index ≈97 KB), one preview revision on `smoke`.
- Regions: Japan from the operator's machine (edge colo KIX, with about 20 % NRT in the 0-second run); North America from GitHub-hosted `ubuntu-24.04` runners (workflow `t30-probe`). The North America 5-second run reached colo IAD and the 0-second run colo LAX, so the two North America runs probably used runners in different US regions. Europe was not measured.
- Traffic: no natural traffic exists on this deployment. All requests are synthetic and back to back, so hit rates in the reader runs are much higher than a long-tail workload would see (see [Decision inputs](#decision-inputs)).
- Tooling: [`scripts/t30/`](../../scripts/t30/README.md). Each root request uses a new TLS connection, and TTFB is measured from before DNS, so it includes TCP and TLS setup. Timing is browser→edge only; whether the edge received a 304 from R2 is not observable.
- Raw data: [`t30/*.jsonl.gz`](t30/) (public URLs and timings only); aggregated tables: [`t30/summary.md`](t30/summary.md).

## Results

### Edge behaviour per class

After migration, a first request was a MISS and an immediate second request was:

| Class | Origin `Cache-Control` | Second request |
| --- | --- | --- |
| Registry, site metadata, site index | `s-maxage=5` | HIT |
| Search manifest, artifacts, preview catalog, application shell | `s-maxage=0` / `no-cache` | REVALIDATED |
| Preview revision manifest and files | `s-maxage=0` | no `cf-cache-status` reported |
| Hashed search blobs and application assets | `max-age=31536000, immutable` | HIT |

### Freshness after publish (5-second roots)

- An updated artifact was visible on the next request, 0.03–0.04 s after `site sync` returned (3 cycles; the plan targets about 10).
- A changed site index reached the edge 1.2–1.6 s after `site sync` returned (3 cycles), inside the 5-second bound.

### Root latency, 5 s versus 0 s (mean TTFB over the five root URLs, ms)

| Region | 5 s, edge hit (`fresh`) | 0 s, revalidated (`fresh`) | Difference |
| --- | --- | --- | --- |
| Japan | 47 | 99 | 52 |
| North America | 37 | 210 | 173 (different colos, see below) |

50 samples per URL and kind. The cleanest estimate of the cost of revalidating a root comes from within the 5-second run itself, where the same runner and colo were used: an expired request (6 s after the last one, so it revalidates) took 87 ms in Japan and 243 ms in North America, against 47 ms and 37 ms for an edge hit, i.e. about **40 ms (Japan)** and **about 206 ms (North America, IAD)** per root request. In the expired rows `cf-cache-status` often reads HIT (North America 206 of 250, Japan 35 of 250) without an `Age` header while the latency shows an upstream fetch, so the label is not reliable there; the timing is. The "expired, changed" root state was not measured.

### Reader operations, 5 s versus 0 s (ms, mean / p95, 20 samples)

| Operation | Japan 5 s | Japan 0 s | North America 5 s (IAD) | North America 0 s (LAX) |
| --- | --- | --- | --- | --- |
| Cold open of a site (list visible) | 208 / 284 | 247 / 329 | 576 / 691 | 623 / 676 |
| Reload of the site home | 97 / 118 | 155 / 180 | 323 / 369 | 418 / 482 |
| Open a document | 120 / 151 | 107 / 130 | 356 / 394 | 295 / 370 |
| Open a second document | 108 / 142 | 118 / 217 | 346 / 363 | 254 / 328 |

Document steps make no root requests. In Japan they stay close between the two runs; in North America the 0-second run was 60–90 ms faster on them, which shows the two North America runs are not comparable: the North America reader differences cannot be attributed to the root TTL. In the 5-second runs, 70–80 % of root requests during a cold open were edge hits, because samples ran within seconds of each other; with 0-second roots every root request revalidated. The search step timed out in 1 of 20 North America samples at 5 s and 3 of 20 at 0 s; search timings are in the summary but not used for the comparison.

## Finding: negative caching of 404 (fixed)

R2 answers a missing object with a 404 that has no `Cache-Control`. Cloudflare's default negative caching kept it at the edge for about three minutes. Without purges, a path requested while missing stayed 404 for **≈177 s** after it was created (3 cycles: delete, request, recreate, poll). Realistic cases are a site's first preview (the reader asks for `_previews/<site>/catalog.json` before any preview exists), a restored document and a re-registered site.

Fix: the reference Cloudflare module no longer stores 4xx responses at the edge (#226). After a targeted apply of that ruleset on `artifact-pages.stream`, the 404 was `BYPASS` and the recreated path was visible after 0.03–0.04 s (3 cycles). AWS was already unaffected (`error_caching_min_ttl = 0`). Cost: every 404 on content paths now reaches R2, including the 404s the reader expects in normal use.

## Runbook rehearsal

The [cache policy migration guide](../guides/cache-policy-migration.md) was exercised once in each direction:

- **Starting state:** registry, three sites and one preview published with CLI 0.5.2 (old headers: roots 60 s, artifacts and preview revisions 300 s).
- **Migration (steps 1–7):** step 3's Terraform plan showed no cache-rule change; the full apply was skipped because the plan also contained unrelated drift (see below). `registry sync`, `site sync --reconcile` and `app deploy` with 0.6.1 converged every header, and no result contained invalidation fields. The preview helper updated 3 objects and then reported `no-op`. After the 300-second wait, edge headers matched the table above.
- **Rollback (steps 1–7):** an old `site sync` failed on the compatible CLI's publish state as the guide warns ("unknown HTTP policy"). After resetting each site's publish state (downloading `_control/sites/<site>/publish-state.json.gz` with its metadata, then deleting only that object), `site sync --reconcile` with 0.5.2 rebuilt it and restored the old headers; a second run was `no-op`. The registry and preview catalog kept their new headers, as the guide says they may.
- **Second migration:** 0.6.1 converged everything again; the preview helper reported `no-op`.
- **Not exercised:** migration of legacy journals, because no old run was interrupted, so no journal or `legacy/` backup was ever written.
- **Registry omission:** omitting `verify-scale-100` removed it from the registry and its index returned 404; re-registering and republishing made it visible again. The visibility timing was not conclusive, because more than three minutes had passed since the 404.

## Infrastructure drift (owner decision)

The verification Terraform state manages the R2 custom domain and a WAF rule without an IP allowlist, while the local `terraform.tfvars` says `connect_custom_domain = false` and sets an allowlist. A full apply would detach the custom domain and block the North America runner, so only the cache ruleset was applied (`-target`). Which side is correct is for the owner to decide.

## Decision inputs

The T30 rule keeps 5 seconds when a relevant reader operation *reproducibly* improves by at least 20 ms in the mean or 100 ms at p95 and the operation represents the observed workload, and chooses 0 when the hit rate is below 5 % with no meaningful improvement.

- **Japan, single run:** cold open +39 ms and reload +58 ms mean in favour of 5 s, while the document steps stayed close. This exceeds 20 ms mean in one run; reproducibility was not shown (one run per state).
- **North America:** the reader comparison is confounded by the IAD/LAX split and is not used. Within the 5-second run, revalidating a root costs about 206 ms per request.
- **Hit rate:** unmeasured. These runs forced edge hits by repeating requests within seconds. For a long-tail internal-document workload a second request reaching the same edge location within 5 seconds is probably rare, but no natural-traffic or aggregate edge data was available for `artifact-pages.dev`, so the "below 5 % → 0" branch cannot be applied either.
- **Cost of 5 seconds:** a published change to the registry, site metadata or index can take up to 5 s to appear (1.2–1.6 s observed).

Under the rule this result is **inconclusive (underpowered)**, so the 5-or-0 choice goes to the owner. In short: 5 seconds saves about 40 ms per root request in Japan and about 200 ms in North America, but only for a request that finds the root already cached at its edge, and delays root changes by up to 5 s. A repeat of the North America pair on the same runner region, or natural-traffic hit rates from production, would make the result conclusive.

## Not verified in this run

- Europe; AWS.
- Natural-traffic hit rates and URL-class frequencies.
- Whether the edge received a 304 from R2 on revalidation (only browser→edge is observable).
- Legacy journal migration on a live provider.
- Search-generation changes and old search-blob 404 recovery in the reader, app update/remove timing, and HTML resources with modules or JSON fetch beyond the reader's own requests.
- Reproducibility over repeated runs on different days (one run per state), and a same-region North America pair.
- About 10 warm-update cycles (3 were run) and the "expired, changed" root state.

Observed but not separately assessed: root JSON was delivered with `br` content encoding under both TTLs.

## State left on `artifact-pages.stream`

CLI 0.6.1 headers with 5-second roots; registry `smoke`, `verify-scale-100`, `verify-scale-1000` with content and one `smoke` preview; the cache ruleset with the 4xx override applied. Control records from before the run are kept outside Git with the run evidence.
