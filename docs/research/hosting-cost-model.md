# Launch hosting cost model

Measurement date: 2026-10-18. This is a local, no-credentials model for the three fixed launch workloads in [T27](../backlog/verification/T27-launch-hosting-cost-model.md). Dollar amounts are monthly marginal infrastructure charges; they exclude domain, GitHub, runner, support, tax, WAF, logging, and other account costs.

## Findings

- A 50,000-page one-document change reads and writes about **45.8 MB** of publisher object bodies. This is close to the locally recorded 45.90 MB full index, so a full mutable-index read/write is the likely dominant component; the probe totals bytes across keys rather than attributing them per key.
- A 50,000-page steady projection occupies **118.5 MB** of public projection objects plus **2.17 MB** of compressed private publish state. Search files alone account for **13.85 MB across 1,478 objects**.
- CloudFront transfer is the largest modeled AWS cost: about **$225/month in M** and **$1,745/month in L**. These figures assume every page view is a cold visit fetching the uncompressed site index. In the reader, the index is fetched once per cold visit/tab session and later revalidated with `304` responses (`max-age=0, must-revalidate`); CloudFront compresses objects up to 10 MB, so real transfer is likely several times lower. Treat the transfer figures as likely-high upper bounds.
- CloudFront invalidation paths are the second large AWS cost driver, at about **$115/month in M** and **$125/month in L**; these costs are included in the table totals. Invalidation compaction matters: the provider-neutral first-publish plan contains 1,182–51,788 paths, while the adapter plans 178–1,481 AWS paths and 2 Cloudflare purge paths. A one-document change plans 3 paths for either adapter.
- App deployment retains old hashed asset URLs. The current build has **60 hashed assets totaling 3,603,721 raw bytes (3.60 MB)**. A rollout where every hashed asset changes can add up to that much per deploy; unchanged content hashes are reused. A maximum browser-tab lifetime and rollback retention period are needed before designing garbage collection.

## Measurement boundary and repeatability

### Publisher probe

The publisher probe ran against the provider-neutral in-memory counting backend with the local CLI code at `db0336fc63145b64b21b28671bbf3c6e42fc2d14`, Go `go1.26.9 darwin/arm64`, and generated version-2 sites from `scripts/benchmark-web-scale.mjs` (seed `20261014`). The source fixture includes the T25 generator's committed `README.md` files; the reported page count excludes those README files. The probe creates an isolated copy, runs first publish, no-op republish, appends one HTML comment to one page, and runs one-document change. It records backend method calls, request-body bytes, final projection bytes, compressed publish-state bytes, and each provider adapter's planned invalidation paths.

Reproduce it from the repository root in a clean checkout:

```sh
node scripts/benchmark-web-scale.mjs --counts 1000,5000,50000 --generate-only --run-dir codex-t27-20261018
cd cli
for count in 1000 5000 50000; do
  ARTIFACT_PAGES_HOSTING_COST_SOURCE=.local/web-scale/codex-t27-20261018/satellite/sites/scale-$count/content \
  ARTIFACT_PAGES_HOSTING_COST_SITE=scale-$count \
  go test ./internal/publisher -run '^TestHostingCostProbe$' -count=1 -v
done
```

The test harness source SHA-256 is `2d74a445064f53f2825bb6802e56cff3b8d1e033fc046516b19b4b2d4e107cca`; the generator script SHA-256 is `874dabcbd2f8d258620e258ee505ddaeb4514ea791ffb90a1d1cc489e97795c1`. Raw logs are ignored under `.local/hosting-cost/publish-{1000,5000,50000}.log`; generated source fixtures are ignored under `.local/web-scale/codex-t27-20261018/`.

This is a logical provider-neutral method count, not a capture of R2/S3 HTTP requests or billing logs. One `LIST` is one backend prefix call (provider pagination is not counted), one `DELETE` is one logical batch (provider batch limits are not counted), and SDK retries, HTTP framing, concurrent requests, and provider latency are absent. The AWS and Cloudflare invalidation path counts are the output of the adapters' pure path-planning functions; the test did not call either provider API.

### Reader measurements reused from T25

The browser rows reuse the sanitized local-nginx results in [web-scale-benchmark-results.json](web-scale-benchmark-results.json) and the detailed [T25 report](web-scale-benchmark.md), rather than claiming a fresh T27 browser run. The extended phase ran on 2026-10-17 at commit `c7d5d2b9661f8f95193044636ff0d7a86d875de0`, generator v2 / seed `20261014`, Chromium 153.0.8010.12 and Playwright 1.63.0. It used local nginx 1.29 over loopback with no HTTP compression, three unthrottled iterations, a fresh browser context, and a later build than the publisher probe.

The current sandbox could not start Docker because access to `/var/run/docker.sock` was denied. A loopback listener was denied with `EPERM`, and Chromium could not launch because the sandbox denied its mach-port rendezvous. Therefore no new browser or real local object-store profile was captured for T27. No cloud credentials or production endpoints were used.

## Measured publishing units

Counts are `GET / HEAD / LIST / PUT / DELETE / invalidate calls`. `PUT body` sums bytes passed to backend writes, including private lock/state records. Stored projection totals include `_artifacts/<site>/` and `_indexes/<site>/`, but exclude private control records; the separately reported publish state is the compressed stored object.

| Site pages | First publish: calls; PUT body; planned paths (AWS / CF) | No-op republish: calls; GET / PUT body | One-document change: calls; GET / PUT body; planned paths (AWS / CF) | Final public projection; search; publish state |
|---:|---|---|---|---|
| 1,000 | 15 / 1 / 2 / 1,188 / 1 / 1; 2,603,988 B; 178 / 2 | 12 / 1 / 0 / 2 / 0 / 0; 1,014 B / 272 B | 15 / 1 / 0 / 7 / 1 / 1; 788,294 B / 788,080 B; 3 / 3 | 1,182 objects / 2,413,150 B; 175 search objects / 463,955 B; 50,492 B |
| 5,000 | 15 / 1 / 2 / 5,376 / 1 / 1; 13,135,968 B; 353 / 2 | 12 / 1 / 0 / 2 / 0 / 0; 1,012 B / 271 B | 15 / 1 / 0 / 7 / 1 / 1; 4,382,984 B / 4,382,761 B; 3 / 3 | 5,370 objects / 12,319,944 B; 350 search objects / 2,069,622 B; 224,618 B |
| 50,000 | 15 / 1 / 2 / 51,794 / 1 / 1; 126,804,832 B; 1,481 / 2 | 12 / 1 / 0 / 2 / 0 / 0; 1,018 B / 274 B | 15 / 1 / 0 / 7 / 1 / 1; 45,803,271 B / 45,804,225 B; 3 / 3 | 51,788 objects / 118,497,241 B; 1,478 search objects / 13,846,540 B; 2,168,183 B |

Each changed publish makes one logical invalidation call. The path counts above are after adapter compaction: Cloudflare collapses the artifact and index groups to two prefix purges on first publish; AWS leaves the index objects exact and compacts the artifact group when its thresholds require it. A one-document update leaves the changed artifact, `index.json`, and `meta.json` as three exact paths.

The no-op is not a zero-write operation: it stores small control/lock records, but has no content writes, deletes, list calls, or invalidation. The one-document change's large read/write body is close to the measured full `index.json` size, indicating that the mutable monolithic index is the dominant component; per-key transfer bytes were not retained by this probe.

## Preview, registry sync, and app deployment

| Unit | Evidence and measured boundary |
|---|---|
| Preview head and cleanup | **Not measured in T27.** T17's local retirement evidence observed a deleted preview revision containing a changed HTML file, copied CSS, and completion manifest, but did not count provider calls or retained bytes. The product delegates expiry to provider lifecycle; both Cloudflare and AWS example configurations use `preview_retention_days = 1`. R2/S3 lifecycle expiration is asynchronous, so one day is a policy threshold, not an exact deletion time. Preview objects and create/cleanup requests are excluded from monthly totals. |
| Registry sync | **Not measured in T27.** The launch scenarios do not specify a registry-sync frequency, and this sandbox had no local object-store profile available. Calls, bytes, and invalidations are excluded. |
| `app deploy` | The local `npm run build` output had 100 files / 4,228,171 B, including 60 hashed assets / 3,603,721 B. Hashed assets with a new URL accumulate; fixed-name shell files are updated in place. Provider calls, purge paths, asset-to-asset overlap with the prior deployment, and old retained-build bytes were not measured, so no app-deploy call charge or historical asset total is included. |

The published projection and build outputs do not include preview-head bytes, registry data, or the application plane. Their omitted storage and operation costs are one reason T27 remains in progress.

## Reader request and byte units

Browser “bytes” are transferred response bytes reported by Chromium; local nginx did not compress responses. The single document-view unit below is a cold `overview-0.md` page containing a Mermaid flowchart, so it includes the site index, application shell, page, and lazy Mermaid code. It is a repeatable document-view example and a conservative traffic proxy, not an average of all documents.

| Reader action | Requests | Transferred bytes | Boundary |
|---|---:|---:|---|
| Cold site-home open, 50k site | 7 | 46,738,136 B | T25's 50k search workspace opened before any query; includes the 45.9 MB site index. Older local site-open rows report 1.60 / 5.20 / 46.32 MB at 1k / 5k / 50k but did not retain a per-row request count. |
| Cold document view, 1k / 5k / 10k / 50k | 35 each | 2,421,390 / 6,027,535 / 10,562,157 / 47,537,297 B | First cold Mermaid render; current cost model uses 1k, 5k, and 50k rows. |
| Palette search | 0 additional requests in the product model | 0 additional bytes | Inferred from the palette searching the already-loaded in-memory index; no T27 browser trace measured it. |
| Full-text broad query `latency` at 50k | 9 total; 6 search-file requests | 1,936,164 total; 1,927,850 search-file bytes | First query in an open search workspace; manifest 1, root 1, leaf 1, sections 1, text 2. |
| Full-text short query `quokkaflux` at 50k | 6 total; 5 search-file requests | 40,949 total; 40,716 search-file bytes | Query ran after the broad query in the same workspace, so manifest/root/sections were already in memory. This is incremental, not a separately cold short-query trace. |

The extended T25 first load of `/` is separate from a site-home or document view: it used 6 requests and about 840.4 kB cold, including 769.2 kB of entry JS and only 1.3 kB of index metadata at 5k/50k.

### Cache classification

The [specification's cache contract](../specification.md#16-cache-model) and CLI object metadata classify URLs as follows:

| URL class | Cache policy | Reader cost treatment |
|---|---|---|
| `/index.html`, fixed app files | `no-cache, max-age=0, must-revalidate` | Always-origin revalidation. |
| Hashed `/assets/*` | `public, max-age=31536000, immutable` | CDN-cacheable and browser-cacheable. |
| `/_indexes/sites.json`, site `meta.json` and `index.json` | `public, max-age=0, s-maxage=60, must-revalidate` | CDN-cacheable up to 60 seconds; browser revalidates. |
| `/_artifacts/<site>/*` | `public, max-age=0, s-maxage=300, must-revalidate` | CDN-cacheable up to 300 seconds; browser revalidates. |
| Search manifest | Same 60-second index policy | CDN-cacheable for up to 60 seconds. |
| Content-addressed gzip search blobs | `public, max-age=31536000, immutable` | CDN-cacheable and browser-cacheable. |
| Preview catalog / revision objects | Catalog 60 seconds; revision objects 300 seconds | CDN-cacheable; not included in the reader scenario. |

The T25 response summary did not preserve each of the 35 document-view URLs with its response cache header. For the miss-rate arithmetic below, I assume one always-origin shell revalidation and 34 cacheable requests per document view. Full-text query requests are treated as cacheable origin reads. The request rates are therefore scenario inputs, not measured production hit ratios.

## Fixed launch scenarios and assumptions

All months have 30 days. Scheduled publishes are modeled as one-document changes, plus one initial publish per site; no-op republishes are shown as a unit but are not part of the scheduled publish count. Site sizes use the nearest measured fixture: S's 200 pages use the 1k fixture; M's 2k pages and L's 30 2k-page sites use the 5k fixture; L's additional site uses the exact 50k fixture. These measured proxies overstate the smaller requested page counts.

The number of page views is divided evenly across sites. In L, `30/31` of views use the 5k proxy and `1/31` use the 50k view. This avoids inventing a traffic hotspot. Half of searches are full-text and half palette; full-text searches split evenly between the measured broad and short query. The same 50k query sizes are applied to all scenarios because other sizes were not measured. The short-query byte count reuses assets fetched by the broad query, as described above.

Each page view is modeled as a cold Mermaid document visit that fetches the uncompressed site index. In the reader, the index is fetched once per cold visit/tab session and later revalidated with `304` responses (`max-age=0, must-revalidate`). CloudFront compresses objects up to 10 MB, while the local benchmark did not; real transfer is likely several times lower, so the modeled transfer figure is a likely-high upper bound. This model includes app/diagram bytes and is conservative versus a warm browser or plain Markdown view. CDN request charges still apply on cache hits. For origin-request charges, each page view has one always-origin shell request plus 34 cacheable requests multiplied by the stated miss rate; full-text query requests are multiplied by the miss rate. This is an explicit modeling assumption because the browser summaries do not retain the per-response cache-key/header partition.

The monthly preview counts from the fixed scenario table are not monetized because preview-head bytes, request counts and invalidation paths were not measured. Registry-sync and app-deploy frequency are not specified by the scenario and are also omitted; the 3.60 MB new-hashed-assets figure is a per-deploy storage observation, not an assumed monthly schedule. Retention uses the 1-day example policy noted above; no exact lifecycle deletion time is assumed. R2 free allowances are shown as if dedicated to this workload; actual allowances are shared with all account usage.

The fixed workload inputs are:

| Scenario | Sites and modeled pages | Publishes | Previews/week | Page views/day | Searches/day |
|---|---|---:|---:|---:|---:|
| S | 5 sites × 200 requested (1k proxy) | 2/site/day | 20 | 1,000 | 100 |
| M | 30 sites × 2,000 requested (5k proxy) | 5/site/day | 200 | 20,000 | 2,000 |
| L | M plus one exact 50k site | 5/site/day | 300 | 100,000 | 10,000 |

## Pricing inputs and monthly subtotal

Prices are USD list prices read 2026-10-18. R2 Standard uses **$0.015/GB-month**, **$4.50/million Class A** (`PUT`, `LIST`), **$0.36/million Class B** (`GET`, `HEAD`), free egress and free deletes. The included monthly R2 allowance is 10 GB-month, 1 million Class A operations, and 10 million Class B operations. Source: [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/).

AWS uses S3 Standard in `us-east-1`, matching [`terraform/deployments/aws/terraform.tfvars.example`](../../terraform/deployments/aws/terraform.tfvars.example): **$0.023/GiB-month**, $0.005/1,000 Class A requests, $0.0004/1,000 Class B requests; deletes are free. Sources: [Amazon S3 pricing](https://aws.amazon.com/s3/pricing/) and the [current us-east-1 price list](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/us-east-1/index.json).

AWS CloudFront uses `PriceClass_100`, as configured by the [AWS module](../../terraform/modules/aws/variables.tf) and verification example. The US/Canada headline prices are first 1 TB/month free, then $0.085/GB for the next 9 TB, $0.080/GB for the next 40 TB, then $0.060/GB for the next 100 TB. US/Canada HTTPS requests are $0.010 per 10,000 after the first 10 million monthly requests. The highest `PriceClass_100` HTTPS request rate is $0.012/10,000 for Europe/Israel/Türkiye; its data-transfer tier rates match US/Canada, so the transfer upper bound is the same. CloudFront invalidations include 1,000 paths/month, then $0.005 per path. Sources: [CloudFront pay-as-you-go pricing](https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/) and [CloudFront invalidation pricing](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/PayingForInvalidation.html). The 1 TB / 10 million allowances are treated as available to this model; existing account use can consume shared allowances.

The monthly storage inputs include measured public projections plus the compressed publish-state object: S 12.32 MB, M 376.34 MB, L 487.00 MB. They omit registry, preview, and app objects. Monthly request counts add one initial publish per site and scheduled one-document changes. AWS invalidation paths use the adapter-planned counts (178 / 353 / 1,481 for initial sites at 1k / 5k / 50k, then 3 per changed publish). R2 has no storage-egress charge; its cache purge API calls are counted but no separate fee is assigned under R2 storage pricing.

Each cell below shows the modeled monthly **gross R2 list-price subtotal** and, in parentheses, the theoretical subtotal after a dedicated R2 free allowance; then **AWS S3 + CloudFront at the US/Canada headline** and its **highest PriceClass_100 regional request-price bound**. R2 gross uses decimal GB-month; S3 storage uses GiB-month. AWS CloudFront transfer uses decimal GB. Displayed amounts are rounded to cents; calculations retain fractional request/byte quantities until billing-unit pricing.

| Scenario | CDN miss rate | R2 gross (after dedicated free allowance) | AWS US/Canada headline | AWS highest PC100 region bound |
|---|---:|---:|---:|---:|
| S | 10% | $0.09 ($0.00) | $4.05 | $4.05 |
| S | 50% | $0.23 ($0.00) | $4.21 | $4.21 |
| S | 100% | $0.42 ($0.00) | $4.42 | $4.42 |
| M | 10% | $1.86 ($0.00) | $353.67 | $355.91 |
| M | 50% | $4.83 ($0.35) | $356.97 | $359.21 |
| M | 100% | $8.54 ($4.07) | $361.09 | $363.34 |
| L | 10% | $5.93 ($1.22) | $1,972.66 | $1,991.89 |
| L | 50% | $20.78 ($16.07) | $1,989.16 | $2,008.39 |
| L | 100% | $39.34 ($34.63) | $2,009.79 | $2,029.01 |

R2's egress is free and its gross subtotal is mainly Class B origin reads at higher miss rates. The AWS totals add publisher and reader S3 requests/storage, CloudFront viewer requests and transfer, and modeled CloudFront invalidation paths. The US/Canada / highest-region difference is only the HTTPS request rate; the PC100 transfer rate is identical across the modeled tiers. Preview, registry, and app-deploy activity is excluded, so these figures are an incomplete measured-unit subtotal, not an account bill or a complete launch budget.

## Assumptions and limits

- The three generated fixture sizes proxy the fixed scenarios as described above; no interpolation is made between measured sizes.
- The 30-day month, one initial publish per site, one changed document per scheduled publish, uniform site traffic, even short/broad full-text mix, cold Mermaid document view, and one revalidating shell request per view are modeling assumptions, not observed launch behavior.
- The browser unit comes from the T25 local nginx run at its own commit. It is reused evidence, not a T27 browser rerun. Palette search is inferred as zero additional network requests from in-memory behavior; it has no browser trace here.
- The short full-text query ran after the broad query in one workspace, so its measured bytes are incremental and may understate a fresh workspace's first search.
- The monthly miss rate is not measured in production. CloudFront viewer requests/transfer are charged for every viewer response regardless of cache hit; only origin reads vary with the modeled miss rate.
- The cost report applies the free allowances as sensitivities. They are shared account allowances and may already be used. R2 API purges have no separate modeled fee; provider plan and account charges are outside this price schedule.
- CloudFront compression is enabled in the AWS module, while local nginx did not compress. The AWS transfer subtotal intentionally uses the larger measured local payload; no gzip/Brotli document-view capture was available to replace this bound.
- Provider method counts omit adapter pagination, retries, and wire behavior. The in-memory publish fixture and T25 reader fixture were not served from the repository's actual local object-store/Compose profile during this T27 run.
- Preview, registry-sync, and app-deploy request costs and monthly schedules are unmeasured or unspecified and are excluded; `preview_retention_days = 1` is asynchronous lifecycle policy, not a guaranteed one-day deletion.
