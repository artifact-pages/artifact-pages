# Hosting cost model

Updated 2026-10-26 with the CLI 0.6 class-based cost model. It is a local estimate for fixed S/M/L workloads, not an AWS or Cloudflare bill or a total budget. Dollar amounts are monthly subtotals. The [T29 reader-session model](#t29-historical-results) and the [October 18 model](hosting-cost-model-legacy-2026-10-18.md) remain below as historical records.

## CLI 0.6 / class-based model

This model reuses T29's measured C/W/R reader response vectors and search vectors, reclassifies each response by URL using the current CLI cache classes, and uses the new plain/AWS-policy publisher probes for operations and stored bytes. The base case uses `q=3`, no reload, 1,024 response-header bytes, gzip6, and the following modeled origin rates. These rates apply only to network requests after browser-cache hits have been removed.

| URL class | Modeled origin rate |
| --- | ---: |
| `sites.json`, site `meta.json` and `index.json` | 100% |
| Artifacts/resources, search manifest, preview catalog/revisions | 100% |
| App shell and fixed-name app files | 100% |
| Hashed app assets | 10% |
| Hashed search blobs | 50% |
| Cloudflare 404 | 100% per 404 request; occurrence is excluded from the base workload |

TTL-0 classes use 100% because each network request requires origin validation in this model; this does not add requests that were served from browser memory/cache. The 10% app and 50% search rates are inherited design assumptions, not measured hit rates. Root rates use a conservative 100% long-tail assumption. The two sensitivity cases below are alternatives, not confidence intervals.

### Base monthly subtotals

| Scenario | R2 gross | R2 after dedicated free allowance | R2 after-free rounded reference | AWS US/Canada | AWS PriceClass 100 upper bound |
| --- | ---: | ---: | ---: | ---: | ---: |
| S | $0.09 | $0.00 | $0.00 | $0.10 | $0.10 |
| M | $1.90 | $0.00 | $0.00 | $2.11 | $2.11 |
| L | $6.12 | $1.40 | $1.44 | $37.59 | $43.74 |

The rounded R2 figure applies the dedicated 10 GB-month, 1 million Class A, and 10 million Class B free allowances to this workload, then rounds the remaining storage and request quantities to billing units ([R2 pricing and rounding](https://developers.cloudflare.com/r2/pricing/)). Actual accounts share these allowances with other use. R2 has no modeled egress fee. AWS uses S3 Standard and CloudFront; transfer is $0.00 at these base loads (L is 877.05 GB against the modeled 1,000 GB allowance). The PriceClass 100 upper bound differs for L because of regional viewer-request pricing.

### Cost breakdown

AWS component values are rounded individually to cents; the subtotal is calculated from unrounded values and can differ by a cent from the displayed component sum.

| Scenario | Storage | Publisher requests | Reader-origin requests | Viewer requests, US/Canada | Transfer | AWS US/Canada subtotal | AWS PC100 subtotal |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S | $0.00 | $0.04 | $0.06 | $0.00 | $0.00 | $0.10 | $0.10 |
| M | $0.01 | $0.99 | $1.11 | $0.00 | $0.00 | $2.11 | $2.11 |
| L | $0.01 | $1.26 | $5.53 | $30.79 | $0.00 | $37.59 | $43.74 |

| Scenario | R2 storage | Publisher Class A | Publisher Class B | Reader-origin requests | R2 gross | After free allowance | Rounded reference |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S | $0.00 | $0.04 | $0.00 | $0.05 | $0.09 | $0.00 | $0.00 |
| M | $0.01 | $0.87 | $0.03 | $1.00 | $1.90 | $0.00 | $0.00 |
| L | $0.01 | $1.11 | $0.03 | $4.98 | $6.12 | $1.40 | $1.44 |

The AWS US/Canada subtotal is storage + publisher requests + reader-origin requests + viewer requests + transfer. There is no invalidation component or invalidation charge in CLI 0.6. The R2 gross subtotal is storage + publisher Class A + publisher Class B + reader-origin Class B requests. The free-allowance figures are workload-only estimates, not account bills.

### Origin-rate sensitivities

| Scenario | Case | AWS US/Canada | AWS PC100 | R2 gross | R2 after free allowance | R2 rounded reference |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| S | Roots 0%, other rates at base | $0.09 | $0.09 | $0.08 | $0.00 | $0.00 |
| S | All classes 100% origin | $0.21 | $0.21 | $0.19 | $0.00 | $0.00 |
| M | Roots 0%, other rates at base | $1.87 | $1.87 | $1.68 | $0.00 | $0.00 |
| M | All classes 100% origin | $4.26 | $4.26 | $3.84 | $0.00 | $0.00 |
| L | Roots 0%, other rates at base | $36.39 | $42.54 | $5.04 | $0.32 | $0.36 |
| L | All classes 100% origin | $48.37 | $54.53 | $15.82 | $11.11 | $11.16 |

Changing origin rates changes origin requests and their request costs; viewer requests and bytes stay fixed. The complete JSON also stores every effective assumption and the existing q, compression, reload, changed-index, and header-size sensitivities for S/M/L.

For L, those one-factor sensitivities include q=1 / 3 / 5 at AWS US/Canada $240.06 / $37.59 / $23.28 and R2 gross $11.09 / $6.12 / $5.12; one reload with unchanged/changed index gives AWS US/Canada $48.07 / $66.59 and R2 gross $8.35 in both cases. Brotli5 reduces modeled L reader bytes from 877.05 GB to 848.72 GB, but does not change the AWS subtotal because both remain below the transfer allowance. Header sizes 512 / 1,024 / 2,048 bytes produce modeled L reader transfer of 856.17 / 877.05 / 918.82 GB; the subtotal remains within the transfer allowance. See [CLI 0.6 calculated results](hosting-cost-cli06-results.json) for the full sensitivity rows.

### T30 evidence and limits

[T30's Cloudflare run](t30-cache-freshness.md) confirmed the sampled edge behavior for the tested classes, the visible artifact update within 0.03–0.04 seconds and index update within 1.2–1.6 seconds under the 5-second root policy, and no invalidation fields during the rehearsed CLI 0.6.1 commands. It also found Cloudflare's default negative caching could keep a missing object at the edge for about 177 seconds; the reference module was changed so sampled 404s bypass edge storage and are visible after recreation within 0.03–0.04 seconds.

T30 did not establish natural traffic rates or URL-class frequencies: the verification deployment had no natural traffic and the requests were synthetic, closely spaced samples. Its root 5-versus-0 comparison was inconclusive; the North American samples reached different colos, Europe was not measured, and the owner’s final 5-or-0 root decision remains open. Edge-to-R2 304 behavior was not observable. AWS was not run and remains unverified. Therefore T30 validates sampled delivery behavior but does not supply the model's 10%/50% immutable origin rates or prove production hit rates.

### Assumptions, provenance, and exclusions

- S/M/L workload counts, 30-day month, size proxies, L's 30:1 regular-to-large mix, search allocation, q=3, reloads=0, compression and 2026-10-18 price inputs follow T29. Shell transfer remains the conservative identity-size proxy; no speculative compression reduction is applied.
- Cloudflare assumes reference module 0.2.0. AWS assumes the monorepo compatibility module with CloudFront TTL caps `0/0/31536000`; this is a model only, not live AWS evidence. The published AWS 0.1.1 caps sensitivity is not included. A maximum TTL is an origin-TTL cap, not the configured retention period ([CloudFront TTL documentation](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/Expiration.html)). AWS error caching has a 1-second minimum for S3 origins even when the configured error TTL is zero; it is not modeled as Cloudflare's immediate bypass ([CloudFront custom error expiration](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/custom-error-pages-expiration.html)).
- Reader input: measured 2026-10-24, source commit `b9847b9e0a6104ca2428486f8bd56460821cba95`, SHA-256 `527fe39c7d3d54532bc01337a5f661755b86cdd3015e107d3e7e710475cc62f2`. The reader evidence is from CLI 0.5.2 and the then-current web; root headers in the local fixture partly used `no-store`. T29's observed 200/304 distribution is not represented as a CLI 0.6 production ratio.
- Publisher probes: plain and AWS-policy, 1k/5k/50k, measured 2026-10-25 on base commit `116521ef` plus the hosting-cost probe changes in this PR (uncommitted probe-test changes), cache-policy revision `d-lt-v1`. They remeasure operation counts and stored projection/state bytes. The calculated results retain phases, operation counts, sizes, per-class object counts, and summarized header checks in the [results JSON](hosting-cost-cli06-results.json); per-object lists are omitted.
- The base workload excludes preview frequency and bytes, and 404 frequency; T29's 648 responses include neither previews nor 404s. An explicitly supplied Cloudflare 404 counts as one origin read and includes its response body bytes. Other exclusions are registry synchronization, app deployment, CloudFront Functions, account-wide shared allowances, domain, GitHub, runner, support, tax, WAF, logging, and other account costs.
- These are subtotals for fixed workloads under stated assumptions, not actual bills or total budgets. Natural traffic origin rates remain unmeasured, and shared account allowances may already be consumed.

## T29 historical results

The following T29 text, tables, and waterfall are retained as historical evidence. Their uniform miss-rate rows and invalidation costs are not the current CLI 0.6 model.

Reader bodies now use observed SPA sessions and gzip6 compression estimates. Invalidation remains the largest AWS component in S/M/L. Base transfer is under the modeled 1,000 GB free tier for all three sizes, with L close enough to the boundary to be threshold-sensitive. At 10% miss rate the AWS US/Canada subtotal is $4.02 / $117.07 / $160.29 for S/M/L; gross R2 is $0.07 / $1.46 / $3.95. The L result differs between US/Canada and the PriceClass 100 upper bound because of the highest regional viewer-request price.

| Size | Miss | R2 gross | R2 after dedicated free allowance | AWS storage | AWS publisher requests | AWS reader origin requests | AWS viewer requests US/Canada | AWS transfer | AWS invalidation | AWS US/Canada subtotal | AWS PC100 upper bound |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S | 10% | $0.07 | $0.00 | $0.00 | $0.04 | $0.03 | $0.00 | $0.00 | $3.95 | $4.02 | $4.02 |
| S | 50% | $0.12 | $0.00 | $0.00 | $0.04 | $0.09 | $0.00 | $0.00 | $3.95 | $4.08 | $4.08 |
| S | 100% | $0.19 | $0.00 | $0.00 | $0.04 | $0.17 | $0.00 | $0.00 | $3.95 | $4.16 | $4.16 |
| M | 10% | $1.46 | $0.00 | $0.01 | $0.99 | $0.63 | $0.00 | $0.00 | $115.45 | $117.07 | $117.07 |
| M | 50% | $2.52 | $0.00 | $0.01 | $0.99 | $1.80 | $0.00 | $0.00 | $115.45 | $118.25 | $118.25 |
| M | 100% | $3.84 | $0.00 | $0.01 | $0.99 | $3.26 | $0.00 | $0.00 | $115.45 | $119.71 | $119.71 |
| L | 10% | $3.95 | $0.00 | $0.01 | $1.26 | $3.13 | $30.79 | $0.00 | $125.11 | $160.29 | $166.44 |
| L | 50% | $9.23 | $4.52 | $0.01 | $1.26 | $8.99 | $30.79 | $0.00 | $125.11 | $166.15 | $172.31 |
| L | 100% | $15.82 | $11.11 | $0.01 | $1.26 | $16.32 | $30.79 | $0.00 | $125.11 | $173.48 | $179.64 |

The unrounded AWS subtotal equals the sum of its six separately listed components; table cells are rounded independently to cents, so displayed rounded components may differ by a cent from the displayed subtotal. Transfer includes response-header bytes at 1,024 bytes per network response, and viewer requests include 200 and 304 responses; browser-cache hits are excluded. The R2 “after dedicated free allowance” column assigns the 10 GB-month, 1 million Class A, and 10 million Class B allowances solely to this workload. Actual account use shares those allowances. R2 has no modeled egress fee. Prices are fixed at the 2026-10-18 list-price inputs in the [calculator results](hosting-cost-model-results.json), with S3 Standard in us-east-1 and CloudFront PriceClass_100. Sources: [R2 pricing](https://developers.cloudflare.com/r2/pricing/), [S3 pricing](https://aws.amazon.com/s3/pricing/), [CloudFront pricing](https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/), and [invalidation pricing](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/PayingForInvalidation.html).

### AWS transfer and invalidation

At all three miss rates, AWS transfer is $0 for S (5.68 GB), M (160.03 GB), and L (877.05 GB). L sits about 123 GB below the modeled 1,000 GB free-tier boundary and is threshold-sensitive: q=1 reaches 2,540.61 GB and a reload with changed index reaches 1,215.88 GB, while q=5 is 544.34 GB. The 1,024-byte response-header assumption contributes 0.423 GB / 8.356 GB / 41.779 GB at S/M/L; its marginal transfer cost is $0 in all three base rows. AWS invalidation costs are $3.95 / $115.45 / $125.11, from 1,790 / 24,090 / 26,021 monthly paths after the 1,000-path allowance. Invalidation is constant across miss rates.

## Measurements and method

The browser measurement captured three iterations for each 1k, 5k, and 50k generated site. Each fresh context visited three documents with 45-second gaps, performed a normal reload, and ran separate quiet broad and short-query clients. The calculator derives the mean C/W/R vectors from the measured response traces. Two corrections are applied in the calculator, not in the raw trace: a compressible response whose Content-Length was not captured by the local fixture is sized from its decoded bytes before the compression model is applied, and a 200 response with zero encoded bytes (a browser memory-cache hit on reload) is counted as a cache hit, not a network request. The committed reader JSON predates the benchmark's `requestServedFromCache` capture, so its raw records still show those responses with `fromCache: false`. The calculator models each session as:

**sessionBody = (V / q) × (C + (q − 1) × W + reloads × R)**

Here C is the first cold document action, W is each later SPA navigation in the same session, R is reload, V is monthly page views, and q is page views per session (base q=3). The base case sets reloads=0. Search adds the measured independent query traffic, with a 50/50 broad/short query mix; L weights 30/31 of views at the 5k fixture and 1/31 at 50k. Monthly origin requests are always-origin requests plus cacheable requests × miss rate. CloudFront viewer charges count all network 200 and 304 responses; browser-cache hits are not billed. Header transfer is modeled as 1,024 bytes per network response. AWS compression uses eligible responses within CloudFront's documented 1,000-byte to 10,000,000-byte range, using the gzip6 audit sizes; stored generated JSON is already gzip and keeps its stored representation. R2 uses its actual stored gzip bytes for precompressed objects and its decoded bytes for eligible objects that would be recompressed.

### C/W/R vectors

Each cell gives requests / always-origin / cacheable / network 200 / network 304 / mean encodedDataLength bytes, including response headers. These measured vectors are the per-action inputs used by the session equation; monthly request totals are in the main results JSON.

| Fixture | C: requests / always / cacheable / 200 / 304 / bytes | W: requests / always / cacheable / 200 / 304 / bytes | R: requests / always / cacheable / 200 / 304 / bytes |
| --- | --- | --- | --- |
| 1,000 | 35 / 2 / 33 / 35 / 0 / 507,764.6 | 2 / 1 / 1 / 1 / 1 / 1,122.5 | 6 / 2 / 4 / 3 / 3 / 2,560.0 |
| 5,000 | 35 / 2 / 33 / 35 / 0 / 726,571.6 | 2 / 1 / 1 / 1 / 1 / 1,076.5 | 6 / 2 / 4 / 3 / 3 / 2,146.0 |
| 50,000 | 35 / 2 / 33 / 35 / 0 / 2,973,917.6 | 2 / 1 / 1 / 1 / 1 / 1,177.0 | 6 / 2 / 4 / 3.6666666666666665 / 2.3333333333333335 / 2,940.7 |

### Compressed and decoded object bytes

Audit counts and byte sizes below come from the generated T29 fixtures. “Stored” is the delivered object representation. gzip6 and Brotli5 columns show the measured stored representation for existing precompressed objects and recompressed sizes for ordinary source objects; the complete audit also stores recompressed alternatives for the precompressed JSON in the results JSON.

| Object type | Count | Decoded bytes | Stored bytes | gzip6 bytes | Brotli5 bytes |
| --- | --- | --- | --- | --- | --- |
| app-asset-css | 1 | 70,525 | 70,525 | 12,681 | 12,306 |
| app-asset-js | 97 | 4,161,334 | 4,161,334 | 1,186,349 | 1,112,320 |
| html | 38747 | 49,157,737 | 49,157,737 | 30,519,568 | 26,432,870 |
| json | 6 | 2,713 | 2,713 | 1,547 | 1,319 |
| md | 17584 | 19,163,149 | 19,163,149 | 11,979,258 | 10,481,103 |
| opaque-search-gzip | 2000 | 50,370,725 | 15,316,693 | 15,316,693 | 15,316,693 |
| search-manifest-1000 | 1 | 37,660 | 8,839 | 8,839 | 8,839 |
| search-manifest-5000 | 1 | 75,850 | 17,668 | 17,668 | 17,668 |
| search-manifest-50000 | 1 | 949,914 | 129,750 | 129,750 | 129,750 |
| site-index-1000 | 1 | 915,851 | 38,780 | 38,780 | 38,780 |
| site-index-5000 | 1 | 5,060,165 | 258,014 | 258,014 | 258,014 |
| site-index-50000 | 1 | 52,638,774 | 2,505,350 | 2,505,350 | 2,505,350 |

### 304 and response-header evidence

The raw reader JSON contains 648 response records: 61 were 304 responses, all retained actual conditional-header evidence (If-None-Match and/or If-Modified-Since), and 0 lacked evidence. 630 records use Network.requestWillBeSentExtraInfo; 18 fall back to Network.requestWillBeSent. Per-size modeled monthly 304/header counts are:

| Size | Monthly network requests | Monthly 304 responses | Header bytes at 1,024 B/response | Header marginal transfer cost |
| --- | --- | --- | --- | --- |
| S | 413,250 | 21,500 | 423,168,000 | $0.00 |
| M | 8,160,000 | 430,000 | 8,355,840,000 | $0.00 |
| L | 40,800,000 | 2,150,000 | 41,779,200,000 | $0.00 |

The 304 responses are included in the viewer/origin request model; their body contribution is zero, while their response headers are included in the modeled transfer byte count. Chromium encodedDataLength already includes response-header bytes; the model then adds 1,024 bytes per network response, so this is a small conservative double count of actual headers. The modeled header-byte transfer charge is the marginal amount after AWS tier pricing; all three base scenarios remain under the 1,000 GB allowance.

### Publisher projection evidence

Plain and AWS-policy publisher probes ran for each fixture from source commit b9847b9e0a6104ca2428486f8bd56460821cba95. They validated generated index and manifest JSON. The output includes call phases, PUT body bytes, adapter invalidation paths, stored projection/search bytes, and compressed private publish state.

| Provider | Pages | Projection bytes | Search bytes | Compressed publish state bytes | Index/manifest validation |
| --- | --- | --- | --- | --- | --- |
| plain | 1,000 | 2,426,215 | 463,955 | 50,484 | pass |
| plain | 5,000 | 12,395,214 | 2,069,622 | 224,616 | pass |
| plain | 50,000 | 119,100,937 | 13,846,540 | 2,168,181 | pass |
| AWS policy | 1,000 | 1,684,738 | 434,923 | 50,502 | pass |
| AWS policy | 5,000 | 8,356,016 | 2,010,893 | 224,640 | pass |
| AWS policy | 50,000 | 76,492,975 | 13,023,349 | 2,168,210 | pass |

Publisher evidence in the JSON retains first publish, no-op republish, and one-document-change call counts and byte totals for each provider/size. These are in-memory provider-contract probes, not real S3/R2 requests or billing records.

## One-factor sensitivity

Each size table gives monthly values at 10% / 50% / 100% miss. The base row appears once per size; every other row changes only the named factor.

### S

| Factor | Value | AWS US/Canada (10 / 50 / 100%) | AWS PC100 (10 / 50 / 100%) | R2 gross (10 / 50 / 100%) | R2 after dedicated free allowance (10 / 50 / 100%) |
| --- | --- | --- | --- | --- | --- |
| Base | q=3; gzip 6; no reload; unchanged index; 1,024 B | $4.02 / $4.08 / $4.16 | $4.02 / $4.08 / $4.16 | $0.07 / $0.12 / $0.19 | $0.00 / $0.00 / $0.00 |
| q (pages/session) | 1 | $4.06 / $4.22 / $4.42 | $4.06 / $4.22 / $4.42 | $0.10 / $0.24 / $0.42 | $0.00 / $0.00 / $0.00 |
| q (pages/session) | 5 | $4.02 / $4.06 / $4.10 | $4.02 / $4.06 / $4.10 | $0.06 / $0.10 / $0.14 | $0.00 / $0.00 / $0.00 |
| compression | Brotli 5 | $4.02 / $4.08 / $4.16 | $4.02 / $4.08 / $4.16 | $0.07 / $0.12 / $0.19 | $0.00 / $0.00 / $0.00 |
| reload; index response | 1 reload; index unchanged | $4.03 / $4.10 / $4.18 | $4.03 / $4.10 / $4.18 | $0.08 / $0.13 / $0.21 | $0.00 / $0.00 / $0.00 |
| reload; index response | 1 reload; index changed | $4.03 / $4.10 / $4.18 | $4.03 / $4.10 / $4.18 | $0.08 / $0.13 / $0.21 | $0.00 / $0.00 / $0.00 |
| response header assumption | 512 B | $4.02 / $4.08 / $4.16 | $4.02 / $4.08 / $4.16 | $0.07 / $0.12 / $0.19 | $0.00 / $0.00 / $0.00 |
| response header assumption | 2,048 B | $4.02 / $4.08 / $4.16 | $4.02 / $4.08 / $4.16 | $0.07 / $0.12 / $0.19 | $0.00 / $0.00 / $0.00 |
### M

| Factor | Value | AWS US/Canada (10 / 50 / 100%) | AWS PC100 (10 / 50 / 100%) | R2 gross (10 / 50 / 100%) | R2 after dedicated free allowance (10 / 50 / 100%) |
| --- | --- | --- | --- | --- | --- |
| Base | q=3; gzip 6; no reload; unchanged index; 1,024 B | $117.07 / $118.25 / $119.71 | $117.07 / $118.25 / $119.71 | $1.46 / $2.52 / $3.84 | $0.00 / $0.00 / $0.00 |
| q (pages/session) | 1 | $129.11 / $132.33 / $136.35 | $131.38 / $134.60 / $138.62 | $2.07 / $4.97 / $8.59 | $0.00 / $0.49 / $4.12 |
| q (pages/session) | 5 | $116.94 / $117.70 / $118.66 | $116.94 / $117.70 / $118.66 | $1.34 / $2.03 / $2.89 | $0.00 / $0.00 / $0.00 |
| compression | Brotli 5 | $117.07 / $118.25 / $119.71 | $117.07 / $118.25 / $119.71 | $1.46 / $2.52 / $3.84 | $0.00 / $0.00 / $0.00 |
| reload; index response | 1 reload; index unchanged | $117.27 / $118.57 / $120.19 | $117.27 / $118.57 / $120.19 | $1.64 / $2.81 / $4.27 | $0.00 / $0.00 / $0.00 |
| reload; index response | 1 reload; index changed | $117.27 / $118.57 / $120.19 | $117.27 / $118.57 / $120.19 | $1.64 / $2.81 / $4.27 | $0.00 / $0.00 / $0.00 |
| response header assumption | 512 B | $117.07 / $118.25 / $119.71 | $117.07 / $118.25 / $119.71 | $1.46 / $2.52 / $3.84 | $0.00 / $0.00 / $0.00 |
| response header assumption | 2,048 B | $117.07 / $118.25 / $119.71 | $117.07 / $118.25 / $119.71 | $1.46 / $2.52 / $3.84 | $0.00 / $0.00 / $0.00 |
### L

| Factor | Value | AWS US/Canada (10 / 50 / 100%) | AWS PC100 (10 / 50 / 100%) | R2 gross (10 / 50 / 100%) | R2 after dedicated free allowance (10 / 50 / 100%) |
| --- | --- | --- | --- | --- | --- |
| Base | q=3; gzip 6; no reload; unchanged index; 1,024 B | $160.29 / $166.15 / $173.48 | $166.44 / $172.31 / $179.64 | $3.95 / $9.23 / $15.82 | $0.00 / $4.52 / $11.11 |
| q (pages/session) | 1 | $360.60 / $376.70 / $396.83 | $379.96 / $396.06 / $416.19 | $6.98 / $21.47 / $39.58 | $2.26 / $16.76 / $34.87 |
| q (pages/session) | 5 | $146.41 / $150.23 / $155.00 | $149.93 / $153.75 / $158.52 | $3.35 / $6.78 / $11.07 | $0.00 / $2.07 / $6.36 |
| compression | Brotli 5 | $160.29 / $166.15 / $173.48 | $166.44 / $172.31 / $179.64 | $3.95 / $9.23 / $15.82 | $0.00 / $4.52 / $11.11 |
| reload; index response | 1 reload; index unchanged | $167.25 / $173.75 / $181.88 | $174.60 / $181.11 / $189.24 | $4.82 / $10.67 / $17.98 | $0.10 / $5.96 / $13.27 |
| reload; index response | 1 reload; index changed | $185.60 / $192.10 / $200.23 | $192.95 / $199.46 / $207.58 | $4.82 / $10.67 / $17.98 | $0.10 / $5.96 / $13.27 |
| response header assumption | 512 B | $160.29 / $166.15 / $173.48 | $166.44 / $172.31 / $179.64 | $3.95 / $9.23 / $15.82 | $0.00 / $4.52 / $11.11 |
| response header assumption | 2,048 B | $160.29 / $166.15 / $173.48 | $166.44 / $172.31 / $179.64 | $3.95 / $9.23 / $15.82 | $0.00 / $4.52 / $11.11 |

The index-changed versus index-unchanged reload variation changes the result only for L; S and M have no measured index revalidation in the reload trace. The JSON retains effective assumptions and every miss-rate subtotal.

## Legacy-to-current waterfall

The calculator reconstructs the archived legacy endpoints from [the legacy snapshot](hosting-cost-model-legacy-2026-10-18.md) and verifies the rounded old totals at cent precision. It reruns pricing after each fixed-order substitution: **compression → sessionReuse → searchTreatment → requestCount → storage**. At every step it records the intermediate subtotal and delta, applying free tiers and pricing again. Displayed values are rounded; the JSON retains full precision and every intermediate subtotal.

These are order-dependent model-substitution deltas, not independent causal effects. Step 1 keeps document views cold every page view and includes the cold-body remeasurement difference alongside compression, so it is not a pure compression effect. This waterfall uses q=3 and reloads=0. The requestCount step also carries changes to origin requests, publisher requests, and the response-header transfer delta. For AWS, M’s sessionReuse and searchTreatment deltas are $0.00 because compression has already moved M under the free transfer tier; those zeros depend on the substitution order.

| Size | Miss | AWS US legacy → new | Δ compression | Δ session reuse | Δ search treatment | Δ request count | Δ storage | AWS PC100 legacy → new | Δ compression | Δ session reuse | Δ search treatment | Δ request count | Δ storage |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S | 10% | $4.05 → $4.02 | $0.00 | $0.00 | $0.00 | -$0.02 | $0.00 | $4.05 → $4.02 | $0.00 | $0.00 | $0.00 | -$0.02 | $0.00 |
| S | 50% | $4.21 → $4.08 | $0.00 | $0.00 | $0.00 | -$0.13 | $0.00 | $4.21 → $4.08 | $0.00 | $0.00 | $0.00 | -$0.13 | $0.00 |
| S | 100% | $4.42 → $4.16 | $0.00 | $0.00 | $0.00 | -$0.26 | $0.00 | $4.42 → $4.16 | $0.00 | $0.00 | $0.00 | -$0.26 | $0.00 |
| M | 10% | $353.67 → $117.07 | -$224.93 | $0.00 | $0.00 | -$11.66 | $0.00 | $355.91 → $117.07 | -$224.93 | $0.00 | $0.00 | -$13.91 | $0.00 |
| M | 50% | $356.97 → $118.25 | -$224.93 | $0.00 | $0.00 | -$13.79 | $0.00 | $359.21 → $118.25 | -$224.93 | $0.00 | $0.00 | -$16.04 | $0.00 |
| M | 100% | $361.09 → $119.71 | -$224.93 | $0.00 | $0.00 | -$16.45 | $0.00 | $363.34 → $119.71 | -$224.93 | $0.00 | $0.00 | -$18.70 | $0.00 |
| L | 10% | $1,972.66 → $160.29 | -$1,613.47 | -$131.37 | $0.00 | -$67.53 | $0.00 | $1,991.89 → $166.44 | -$1,613.47 | -$131.37 | $0.00 | -$80.60 | $0.00 |
| L | 50% | $1,989.16 → $166.15 | -$1,613.47 | -$131.37 | $0.00 | -$78.17 | $0.00 | $2,008.39 → $172.31 | -$1,613.47 | -$131.37 | $0.00 | -$91.24 | $0.00 |
| L | 100% | $2,009.79 → $173.48 | -$1,613.47 | -$131.37 | $0.00 | -$91.47 | $0.00 | $2,029.01 → $179.64 | -$1,613.47 | -$131.37 | $0.00 | -$104.54 | $0.00 |

| Size | Miss | R2 gross legacy → new | Δ compression | Δ session reuse | Δ search treatment | Δ request count | Δ storage | R2 after-free legacy → new | Δ compression | Δ session reuse | Δ search treatment | Δ request count | Δ storage |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S | 10% | $0.09 → $0.07 | $0.00 | $0.00 | $0.00 | -$0.02 | $0.00 | $0.00 → $0.00 | $0.00 | $0.00 | $0.00 | $0.00 | $0.00 |
| S | 50% | $0.23 → $0.12 | $0.00 | $0.00 | $0.00 | -$0.11 | $0.00 | $0.00 → $0.00 | $0.00 | $0.00 | $0.00 | $0.00 | $0.00 |
| S | 100% | $0.42 → $0.19 | $0.00 | $0.00 | $0.00 | -$0.23 | $0.00 | $0.00 → $0.00 | $0.00 | $0.00 | $0.00 | $0.00 | $0.00 |
| M | 10% | $1.86 → $1.46 | $0.00 | $0.00 | $0.00 | -$0.40 | $0.00 | $0.00 → $0.00 | $0.00 | $0.00 | $0.00 | $0.00 | $0.00 |
| M | 50% | $4.83 → $2.52 | $0.00 | $0.00 | $0.00 | -$2.31 | $0.00 | $0.35 → $0.00 | $0.00 | $0.00 | $0.00 | -$0.35 | $0.00 |
| M | 100% | $8.54 → $3.84 | $0.00 | $0.00 | $0.00 | -$4.70 | $0.00 | $4.07 → $0.00 | $0.00 | $0.00 | $0.00 | -$4.07 | $0.00 |
| L | 10% | $5.93 → $3.95 | $0.00 | $0.00 | $0.00 | -$1.98 | $0.00 | $1.22 → $0.00 | $0.00 | $0.00 | $0.00 | -$1.22 | $0.00 |
| L | 50% | $20.78 → $9.23 | $0.00 | $0.00 | $0.00 | -$11.55 | $0.00 | $16.07 → $4.52 | $0.00 | $0.00 | $0.00 | -$11.55 | $0.00 |
| L | 100% | $39.34 → $15.82 | $0.00 | $0.00 | $0.00 | -$23.52 | $0.00 | $34.63 → $11.11 | $0.00 | $0.00 | $0.00 | -$23.52 | $0.00 |

The sequence’s exact step assumptions and every intermediate subtotal are in the decomposition.stages array of the linked JSON.

## Provenance, assumptions, and unmeasured scope

- Reader result: [hosting-cost-reader-session-results.json](hosting-cost-reader-session-results.json), measured 2026-10-24; model and calculated nine scenarios: [hosting-cost-model-results.json](hosting-cost-model-results.json).
- Environment: macOS Darwin arm64, Apple M4 / 10 cores / 32 GiB RAM; Node v22.14.0; Go go1.26.10 darwin/arm64; CLI 0.5.2; Chromium 153.0.8010.12; Playwright 1.63.0; nginx:1.29-alpine; clean working tree recorded at commit b9847b9e0a6104ca2428486f8bd56460821cba95; the run used script content identical to b9847b9e0a6104ca2428486f8bd56460821cba95. Generator v2, seed 20261014; three unthrottled iterations, local nginx, stored gzip indexes/manifests. Prices are fixed to 2026-10-18 inputs.
- The monthly S/M/L workloads retain the legacy 30-day schedule and view/search counts. The reader metrics and publisher projections are measured locally, but miss rates, page views, session grouping, query mix, and monthly publish counts remain scenario assumptions; no production traffic or billing data was used.
- AWS viewer-response bandwidth uses local response bytes plus modeled 1,024-byte response headers and AWS price tiers. It does not claim that local nginx reproduces live CloudFront negotiation or compression. AWS transfer costs at L reflect the model's 1 TB allowance and the complete counted bytes.
- CloudFront Functions execution cost is **unmeasured and excluded**. Preview lifecycle, registry sync, app-deploy provider calls, preview and registry storage, CloudFront WAF/logging, account-wide allowance consumption, taxes, and other account charges are also excluded. The totals are measured-unit subtotals, not an all-in budget.
- No cloud account, provider API, release, tag, or paid load test was used for these measurements.

## Measured publishing units — T29

These are the T29 plain and AWS-policy probe results generated from the model JSON. Call order is GET / HEAD / LIST / PUT / DELETE / INVALIDATE; path counts are logical plan / AWS-adapter plan. Projection, search, and state sizes are steady fixture totals. Phase PUT bytes are measured write bodies. The archived October 18 table remains in the [legacy snapshot](hosting-cost-model-legacy-2026-10-18.md).

| Provider | Pages | Phase | Calls | GET body bytes | PUT body bytes | Paths logical / AWS | Projection bytes | Search bytes | State gzip bytes | Index + manifest JSON |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| plain | 1,000 | first publish | 15 / 1 / 2 / 1188 / 1 / 1 | 825 | 2,617,047 | 1,182 / 178 | 2,426,215 | 463,955 | 50,484 | pass |
| plain | 1,000 | no-op republish | 12 / 1 / 0 / 2 / 0 / 0 | 1,015 | 272 | 0 / 0 | 2,426,215 | 463,955 | 50,484 | pass |
| plain | 1,000 | one-document change | 15 / 1 / 0 / 7 / 1 / 1 | 802,361 | 802,142 | 3 / 3 | 2,426,215 | 463,955 | 50,484 | pass |
| plain | 5,000 | first publish | 15 / 1 / 2 / 5376 / 1 / 1 | 825 | 13,211,241 | 5,370 / 353 | 12,395,214 | 2,069,622 | 224,616 | pass |
| plain | 5,000 | no-op republish | 12 / 1 / 0 / 2 / 0 / 0 | 1,015 | 272 | 0 / 0 | 12,395,214 | 2,069,622 | 224,616 | pass |
| plain | 5,000 | one-document change | 15 / 1 / 0 / 7 / 1 / 1 | 4,458,259 | 4,458,029 | 3 / 3 | 12,395,214 | 2,069,622 | 224,616 | pass |
| plain | 50,000 | first publish | 15 / 1 / 2 / 51794 / 1 / 1 | 828 | 127,408,529 | 51,788 / 1,481 | 119,100,937 | 13,846,540 | 2,168,181 | pass |
| plain | 50,000 | no-op republish | 12 / 1 / 0 / 2 / 0 / 0 | 1,018 | 274 | 0 / 0 | 119,100,937 | 13,846,540 | 2,168,181 | pass |
| plain | 50,000 | one-document change | 15 / 1 / 0 / 7 / 1 / 1 | 46,406,966 | 46,407,918 | 3 / 3 | 119,100,937 | 13,846,540 | 2,168,181 | pass |
| AWS-policy | 1,000 | first publish | 15 / 1 / 2 / 1188 / 1 / 1 | 825 | 1,875,580 | 1,182 / 178 | 1,684,738 | 434,923 | 50,502 | pass |
| AWS-policy | 1,000 | no-op republish | 12 / 1 / 0 / 2 / 0 / 0 | 1,015 | 272 | 0 / 0 | 1,684,738 | 434,923 | 50,502 | pass |
| AWS-policy | 1,000 | one-document change | 15 / 1 / 0 / 7 / 1 / 1 | 89,926 | 89,715 | 3 / 3 | 1,684,738 | 434,923 | 50,502 | pass |
| AWS-policy | 5,000 | first publish | 15 / 1 / 2 / 5376 / 1 / 1 | 823 | 9,172,046 | 5,370 / 353 | 8,356,016 | 2,010,893 | 224,640 | pass |
| AWS-policy | 5,000 | no-op republish | 12 / 1 / 0 / 2 / 0 / 0 | 1,015 | 272 | 0 / 0 | 8,356,016 | 2,010,893 | 224,640 | pass |
| AWS-policy | 5,000 | one-document change | 15 / 1 / 0 / 7 / 1 / 1 | 477,794 | 477,584 | 3 / 3 | 8,356,016 | 2,010,893 | 224,640 | pass |
| AWS-policy | 50,000 | first publish | 15 / 1 / 2 / 51794 / 1 / 1 | 829 | 84,800,572 | 51,788 / 1,481 | 76,492,975 | 13,023,349 | 2,168,210 | pass |
| AWS-policy | 50,000 | no-op republish | 12 / 1 / 0 / 2 / 0 / 0 | 1,019 | 274 | 0 / 0 | 76,492,975 | 13,023,349 | 2,168,210 | pass |
| AWS-policy | 50,000 | one-document change | 15 / 1 / 0 / 7 / 1 / 1 | 4,622,202 | 4,623,177 | 3 / 3 | 76,492,975 | 13,023,349 | 2,168,210 | pass |

These are in-memory publisher-contract probes, not real S3/R2 requests or billing records. The no-op phase writes control state but makes no content writes.

## Preview, registry sync, and app deployment

| Unit | Evidence and measured boundary |
|---|---|
| Preview head and cleanup | **Not measured in T27.** T17's local retirement evidence observed a deleted preview revision containing a changed HTML file, copied CSS, and completion manifest, but did not count provider calls or retained bytes. The product delegates expiry to provider lifecycle; both Cloudflare and AWS example configurations use `preview_retention_days = 1`. R2/S3 lifecycle expiration is asynchronous, so one day is a policy threshold, not an exact deletion time. Preview objects and create/cleanup requests are excluded from monthly totals. |
| Registry sync | **Not measured in T27.** The launch scenarios do not specify a registry-sync frequency, and this sandbox had no local object-store profile available. Calls, bytes, and invalidations are excluded. |
| `app deploy` | The local `npm run build` output had 100 files / 4,228,171 B, including 60 hashed assets / 3,603,721 B. Hashed assets with a new URL accumulate; fixed-name shell files are updated in place. Provider calls, purge paths, asset-to-asset overlap with the prior deployment, and old retained-build bytes were not measured, so no app-deploy call charge or historical asset total is included. |

The published projection and build outputs do not include preview-head bytes, registry data, or the application plane. Their omitted storage and operation costs are one reason T27 remains in progress.
