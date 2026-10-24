# Hosting cost model

Updated 2026-10-24 with the T29 measured reader-session model. This is a local, no-credentials estimate for the fixed S/M/L launch workloads; it is not an AWS or Cloudflare bill and does not measure a live CDN. Dollar amounts are monthly marginal infrastructure subtotals, excluding domain, GitHub, runner, support, tax, WAF, logging, and other account costs. The October 18 model is preserved at [legacy snapshot](hosting-cost-model-legacy-2026-10-18.md).

## Current results

Reader bodies now use observed SPA sessions and gzip6 compression estimates. Invalidation remains the largest AWS component in S/M/L; transfer remains inside AWS's modeled 1,000 GB free tier for S and M, while L exceeds it. At 10% miss rate the AWS US/Canada subtotal is $4.02 / $117.07 / $163.25 for S/M/L; gross R2 is $0.07 / $1.46 / $3.95. The L result differs between US/Canada and the PriceClass 100 upper bound because of the highest regional viewer-request price.

| Size | Miss | R2 gross | R2 after dedicated free allowance | AWS storage | AWS publisher requests | AWS reader origin requests | AWS viewer requests US/Canada | AWS transfer | AWS invalidation | AWS US/Canada subtotal | AWS PC100 upper bound |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S | 10% | $0.07 | $0.00 | $0.00 | $0.04 | $0.03 | $0.00 | $0.00 | $3.95 | $4.02 | $4.02 |
| S | 50% | $0.12 | $0.00 | $0.00 | $0.04 | $0.09 | $0.00 | $0.00 | $3.95 | $4.08 | $4.08 |
| S | 100% | $0.19 | $0.00 | $0.00 | $0.04 | $0.17 | $0.00 | $0.00 | $3.95 | $4.16 | $4.16 |
| M | 10% | $1.46 | $0.00 | $0.01 | $0.99 | $0.63 | $0.00 | $0.00 | $115.45 | $117.07 | $117.07 |
| M | 50% | $2.52 | $0.00 | $0.01 | $0.99 | $1.80 | $0.00 | $0.00 | $115.45 | $118.25 | $118.25 |
| M | 100% | $3.84 | $0.00 | $0.01 | $0.99 | $3.26 | $0.00 | $0.00 | $115.45 | $119.71 | $119.71 |
| L | 10% | $3.95 | $0.00 | $0.01 | $1.26 | $3.13 | $30.79 | $2.96 | $125.11 | $163.25 | $169.41 |
| L | 50% | $9.23 | $4.52 | $0.01 | $1.26 | $8.99 | $30.79 | $2.96 | $125.11 | $169.11 | $175.27 |
| L | 100% | $15.82 | $11.11 | $0.01 | $1.26 | $16.32 | $30.79 | $2.96 | $125.11 | $176.44 | $182.60 |

The unrounded AWS subtotal equals the sum of its six separately listed components; table cells are rounded independently to cents, so displayed rounded components may differ by a cent from the displayed subtotal. Transfer includes response-header bytes at 1,024 bytes per network response, and viewer requests include 200 and 304 responses; browser-cache hits are excluded. The R2 “after dedicated free allowance” column assigns the 10 GB-month, 1 million Class A, and 10 million Class B allowances solely to this workload. Actual account use shares those allowances. R2 has no modeled egress fee. Prices are fixed at the 2026-10-18 list-price inputs in the [calculator results](hosting-cost-model-results.json), with S3 Standard in us-east-1 and CloudFront PriceClass_100. Sources: [R2 pricing](https://developers.cloudflare.com/r2/pricing/), [S3 pricing](https://aws.amazon.com/s3/pricing/), [CloudFront pricing](https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/), and [invalidation pricing](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/PayingForInvalidation.html).

### AWS transfer and invalidation

At all three miss rates, AWS transfer is $0 for S and M (6.02 GB and 190.61 GB respectively), and $2.96 for L (1,034.85 GB). The 1,024-byte response-header assumption contributes 0.423 GB / 8.356 GB / 41.779 GB at S/M/L; its marginal modeled transfer cost is $0 / $0 / $2.96 because only L crosses the 1,000 GB free tier. AWS invalidation costs are $3.95 / $115.45 / $125.11, from 1,790 / 24,090 / 26,021 monthly paths, after the 1,000-path allowance. Invalidation is constant across miss rates.

## Measurements and method

The browser measurement captured three iterations for each 1k, 5k, and 50k generated site. Each fresh context visited three documents with 45-second gaps, performed a normal reload, and ran separate quiet broad and short-query clients. The calculator derives the mean C/W/R vectors from the measured response traces and models each session as:

**sessionBody = (V / q) × (C + (q − 1) × W + reloads × R)**

Here C is the first cold document action, W is each later SPA navigation in the same session, R is reload, V is monthly page views, and q is page views per session (base q=3). The base case sets reloads=0. Search adds the measured independent query traffic, with a 50/50 broad/short query mix; L weights 30/31 of views at the 5k fixture and 1/31 at 50k. Monthly origin requests are always-origin requests plus cacheable requests × miss rate. CloudFront viewer charges count all network 200 and 304 responses; browser-cache hits are not billed. Header transfer is modeled as 1,024 bytes per network response. AWS compression uses eligible responses within CloudFront's documented 1,000-byte to 10,000,000-byte range, using the gzip6 audit sizes; stored generated JSON is already gzip and keeps its stored representation. R2 uses its actual stored gzip bytes for precompressed objects and its decoded bytes for eligible objects that would be recompressed.

### C/W/R vectors

Each cell gives requests / always-origin / cacheable / network 200 / network 304 / mean response-body bytes. These measured vectors are the per-action inputs used by the session equation; monthly request totals are in the main results JSON.

| Fixture | C: requests / always / cacheable / 200 / 304 / bytes | W: requests / always / cacheable / 200 / 304 / bytes | R: requests / always / cacheable / 200 / 304 / bytes |
| --- | --- | --- | --- |
| 1,000 | 35 / 2 / 33 / 35 / 0 / 541,116.9 | 2 / 1 / 1 / 1 / 1 / 1,122.5 | 8 / 2 / 6 / 5 / 3 / 857,450.0 |
| 5,000 | 35 / 2 / 33 / 35 / 0 / 879,500.0 | 2 / 1 / 1 / 1 / 1 / 1,076.5 | 8 / 2 / 6 / 5 / 3 / 857,036.0 |
| 50,000 | 35 / 2 / 33 / 35 / 0 / 3,277,728.0 | 2 / 1 / 1 / 1 / 1 / 1,177.0 | 8 / 2 / 6 / 5.666666666666667 / 2.3333333333333335 / 857,830.7 |

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
| L | 40,800,000 | 2,150,000 | 41,779,200,000 | $2.96 |

The 304 responses are included in the viewer/origin request model; their body contribution is zero, while their response headers are included in the modeled transfer byte count. The input header charge is not a standalone line item: it is the marginal amount of the tiered CloudFront transfer charge after adding those bytes.

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

Each row varies only the named factor from the base assumptions; all other inputs remain at q=3, gzip6, reloads=0, unchanged index, 1,024-byte headers, and the row's stated miss rate. Values are monthly AWS US/Canada, AWS PC100 upper-bound, gross R2 and R2 after dedicated free allowances. The complete rows are written with their effective assumptions in [hosting-cost-model-results.json](hosting-cost-model-results.json).

| Size | Effective assumptions | Miss | AWS US/Canada | AWS PC100 | R2 gross | R2 net |
| --- | --- | --- | --- | --- | --- | --- |
| S | {"q":1,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.1} | 10% | $4.06 | $4.06 | $0.10 | $0.00 |
| S | {"q":1,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.5} | 50% | $4.22 | $4.22 | $0.24 | $0.00 |
| S | {"q":1,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":1} | 100% | $4.42 | $4.42 | $0.42 | $0.00 |
| S | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.1} | 10% | $4.02 | $4.02 | $0.07 | $0.00 |
| S | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.5} | 50% | $4.08 | $4.08 | $0.12 | $0.00 |
| S | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":1} | 100% | $4.16 | $4.16 | $0.19 | $0.00 |
| S | {"q":5,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.1} | 10% | $4.02 | $4.02 | $0.06 | $0.00 |
| S | {"q":5,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.5} | 50% | $4.06 | $4.06 | $0.10 | $0.00 |
| S | {"q":5,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":1} | 100% | $4.10 | $4.10 | $0.14 | $0.00 |
| S | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.1} | 10% | $4.02 | $4.02 | $0.07 | $0.00 |
| S | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.5} | 50% | $4.08 | $4.08 | $0.12 | $0.00 |
| S | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":1} | 100% | $4.16 | $4.16 | $0.19 | $0.00 |
| S | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"brotli5","missRate":0.1} | 10% | $4.02 | $4.02 | $0.07 | $0.00 |
| S | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"brotli5","missRate":0.5} | 50% | $4.08 | $4.08 | $0.12 | $0.00 |
| S | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"brotli5","missRate":1} | 100% | $4.16 | $4.16 | $0.19 | $0.00 |
| S | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.1} | 10% | $4.02 | $4.02 | $0.07 | $0.00 |
| S | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.5} | 50% | $4.08 | $4.08 | $0.12 | $0.00 |
| S | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":1} | 100% | $4.16 | $4.16 | $0.19 | $0.00 |
| S | {"q":3,"reloads":1,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.1} | 10% | $4.03 | $4.03 | $0.08 | $0.00 |
| S | {"q":3,"reloads":1,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.5} | 50% | $4.10 | $4.10 | $0.14 | $0.00 |
| S | {"q":3,"reloads":1,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":1} | 100% | $4.19 | $4.19 | $0.22 | $0.00 |
| S | {"q":3,"reloads":1,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.1} | 10% | $4.03 | $4.03 | $0.08 | $0.00 |
| S | {"q":3,"reloads":1,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.5} | 50% | $4.10 | $4.10 | $0.14 | $0.00 |
| S | {"q":3,"reloads":1,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":1} | 100% | $4.19 | $4.19 | $0.22 | $0.00 |
| S | {"q":3,"reloads":1,"reloadIndexChanged":true,"headerBytes":1024,"compression":"gzip6","missRate":0.1} | 10% | $4.03 | $4.03 | $0.08 | $0.00 |
| S | {"q":3,"reloads":1,"reloadIndexChanged":true,"headerBytes":1024,"compression":"gzip6","missRate":0.5} | 50% | $4.10 | $4.10 | $0.14 | $0.00 |
| S | {"q":3,"reloads":1,"reloadIndexChanged":true,"headerBytes":1024,"compression":"gzip6","missRate":1} | 100% | $4.19 | $4.19 | $0.22 | $0.00 |
| S | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":512,"compression":"gzip6","missRate":0.1} | 10% | $4.02 | $4.02 | $0.07 | $0.00 |
| S | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":512,"compression":"gzip6","missRate":0.5} | 50% | $4.08 | $4.08 | $0.12 | $0.00 |
| S | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":512,"compression":"gzip6","missRate":1} | 100% | $4.16 | $4.16 | $0.19 | $0.00 |
| S | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.1} | 10% | $4.02 | $4.02 | $0.07 | $0.00 |
| S | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.5} | 50% | $4.08 | $4.08 | $0.12 | $0.00 |
| S | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":1} | 100% | $4.16 | $4.16 | $0.19 | $0.00 |
| S | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":2048,"compression":"gzip6","missRate":0.1} | 10% | $4.02 | $4.02 | $0.07 | $0.00 |
| S | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":2048,"compression":"gzip6","missRate":0.5} | 50% | $4.08 | $4.08 | $0.12 | $0.00 |
| S | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":2048,"compression":"gzip6","missRate":1} | 100% | $4.16 | $4.16 | $0.19 | $0.00 |
| M | {"q":1,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.1} | 10% | $129.11 | $131.38 | $2.07 | $0.00 |
| M | {"q":1,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.5} | 50% | $132.33 | $134.60 | $4.97 | $0.49 |
| M | {"q":1,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":1} | 100% | $136.35 | $138.62 | $8.59 | $4.12 |
| M | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.1} | 10% | $117.07 | $117.07 | $1.46 | $0.00 |
| M | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.5} | 50% | $118.25 | $118.25 | $2.52 | $0.00 |
| M | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":1} | 100% | $119.71 | $119.71 | $3.84 | $0.00 |
| M | {"q":5,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.1} | 10% | $116.94 | $116.94 | $1.34 | $0.00 |
| M | {"q":5,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.5} | 50% | $117.70 | $117.70 | $2.03 | $0.00 |
| M | {"q":5,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":1} | 100% | $118.66 | $118.66 | $2.89 | $0.00 |
| M | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.1} | 10% | $117.07 | $117.07 | $1.46 | $0.00 |
| M | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.5} | 50% | $118.25 | $118.25 | $2.52 | $0.00 |
| M | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":1} | 100% | $119.71 | $119.71 | $3.84 | $0.00 |
| M | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"brotli5","missRate":0.1} | 10% | $117.07 | $117.07 | $1.46 | $0.00 |
| M | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"brotli5","missRate":0.5} | 50% | $118.25 | $118.25 | $2.52 | $0.00 |
| M | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"brotli5","missRate":1} | 100% | $119.71 | $119.71 | $3.84 | $0.00 |
| M | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.1} | 10% | $117.07 | $117.07 | $1.46 | $0.00 |
| M | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.5} | 50% | $118.25 | $118.25 | $2.52 | $0.00 |
| M | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":1} | 100% | $119.71 | $119.71 | $3.84 | $0.00 |
| M | {"q":3,"reloads":1,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.1} | 10% | $117.28 | $117.28 | $1.65 | $0.00 |
| M | {"q":3,"reloads":1,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.5} | 50% | $118.65 | $118.65 | $2.88 | $0.00 |
| M | {"q":3,"reloads":1,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":1} | 100% | $120.35 | $120.35 | $4.41 | $0.00 |
| M | {"q":3,"reloads":1,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.1} | 10% | $117.28 | $117.28 | $1.65 | $0.00 |
| M | {"q":3,"reloads":1,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.5} | 50% | $118.65 | $118.65 | $2.88 | $0.00 |
| M | {"q":3,"reloads":1,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":1} | 100% | $120.35 | $120.35 | $4.41 | $0.00 |
| M | {"q":3,"reloads":1,"reloadIndexChanged":true,"headerBytes":1024,"compression":"gzip6","missRate":0.1} | 10% | $117.28 | $117.28 | $1.65 | $0.00 |
| M | {"q":3,"reloads":1,"reloadIndexChanged":true,"headerBytes":1024,"compression":"gzip6","missRate":0.5} | 50% | $118.65 | $118.65 | $2.88 | $0.00 |
| M | {"q":3,"reloads":1,"reloadIndexChanged":true,"headerBytes":1024,"compression":"gzip6","missRate":1} | 100% | $120.35 | $120.35 | $4.41 | $0.00 |
| M | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":512,"compression":"gzip6","missRate":0.1} | 10% | $117.07 | $117.07 | $1.46 | $0.00 |
| M | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":512,"compression":"gzip6","missRate":0.5} | 50% | $118.25 | $118.25 | $2.52 | $0.00 |
| M | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":512,"compression":"gzip6","missRate":1} | 100% | $119.71 | $119.71 | $3.84 | $0.00 |
| M | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.1} | 10% | $117.07 | $117.07 | $1.46 | $0.00 |
| M | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.5} | 50% | $118.25 | $118.25 | $2.52 | $0.00 |
| M | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":1} | 100% | $119.71 | $119.71 | $3.84 | $0.00 |
| M | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":2048,"compression":"gzip6","missRate":0.1} | 10% | $117.07 | $117.07 | $1.46 | $0.00 |
| M | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":2048,"compression":"gzip6","missRate":0.5} | 50% | $118.25 | $118.25 | $2.52 | $0.00 |
| M | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":2048,"compression":"gzip6","missRate":1} | 100% | $119.71 | $119.71 | $3.84 | $0.00 |
| L | {"q":1,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.1} | 10% | $400.84 | $420.19 | $6.98 | $2.26 |
| L | {"q":1,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.5} | 50% | $416.94 | $436.30 | $21.47 | $16.76 |
| L | {"q":1,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":1} | 100% | $437.07 | $456.42 | $39.58 | $34.87 |
| L | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.1} | 10% | $163.25 | $169.41 | $3.95 | $0.00 |
| L | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.5} | 50% | $169.11 | $175.27 | $9.23 | $4.52 |
| L | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":1} | 100% | $176.44 | $182.60 | $15.82 | $11.11 |
| L | {"q":5,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.1} | 10% | $146.41 | $149.93 | $3.35 | $0.00 |
| L | {"q":5,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.5} | 50% | $150.23 | $153.75 | $6.78 | $2.07 |
| L | {"q":5,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":1} | 100% | $155.00 | $158.52 | $11.07 | $6.36 |
| L | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.1} | 10% | $163.25 | $169.41 | $3.95 | $0.00 |
| L | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.5} | 50% | $169.11 | $175.27 | $9.23 | $4.52 |
| L | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":1} | 100% | $176.44 | $182.60 | $15.82 | $11.11 |
| L | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"brotli5","missRate":0.1} | 10% | $161.17 | $167.33 | $3.95 | $0.00 |
| L | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"brotli5","missRate":0.5} | 50% | $167.04 | $173.19 | $9.23 | $4.52 |
| L | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"brotli5","missRate":1} | 100% | $174.36 | $180.52 | $15.82 | $11.11 |
| L | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.1} | 10% | $163.25 | $169.41 | $3.95 | $0.00 |
| L | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.5} | 50% | $169.11 | $175.27 | $9.23 | $4.52 |
| L | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":1} | 100% | $176.44 | $182.60 | $15.82 | $11.11 |
| L | {"q":3,"reloads":1,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.1} | 10% | $245.84 | $253.59 | $4.89 | $0.18 |
| L | {"q":3,"reloads":1,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.5} | 50% | $252.66 | $260.42 | $11.03 | $6.32 |
| L | {"q":3,"reloads":1,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":1} | 100% | $261.19 | $268.94 | $18.70 | $13.99 |
| L | {"q":3,"reloads":1,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.1} | 10% | $245.84 | $253.59 | $4.89 | $0.18 |
| L | {"q":3,"reloads":1,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.5} | 50% | $252.66 | $260.42 | $11.03 | $6.32 |
| L | {"q":3,"reloads":1,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":1} | 100% | $261.19 | $268.94 | $18.70 | $13.99 |
| L | {"q":3,"reloads":1,"reloadIndexChanged":true,"headerBytes":1024,"compression":"gzip6","missRate":0.1} | 10% | $273.93 | $281.69 | $4.89 | $0.18 |
| L | {"q":3,"reloads":1,"reloadIndexChanged":true,"headerBytes":1024,"compression":"gzip6","missRate":0.5} | 50% | $280.75 | $288.51 | $11.03 | $6.32 |
| L | {"q":3,"reloads":1,"reloadIndexChanged":true,"headerBytes":1024,"compression":"gzip6","missRate":1} | 100% | $289.28 | $297.04 | $18.70 | $13.99 |
| L | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":512,"compression":"gzip6","missRate":0.1} | 10% | $161.47 | $167.63 | $3.95 | $0.00 |
| L | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":512,"compression":"gzip6","missRate":0.5} | 50% | $167.34 | $173.49 | $9.23 | $4.52 |
| L | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":512,"compression":"gzip6","missRate":1} | 100% | $174.66 | $180.82 | $15.82 | $11.11 |
| L | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.1} | 10% | $163.25 | $169.41 | $3.95 | $0.00 |
| L | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":0.5} | 50% | $169.11 | $175.27 | $9.23 | $4.52 |
| L | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":1024,"compression":"gzip6","missRate":1} | 100% | $176.44 | $182.60 | $15.82 | $11.11 |
| L | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":2048,"compression":"gzip6","missRate":0.1} | 10% | $166.80 | $172.96 | $3.95 | $0.00 |
| L | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":2048,"compression":"gzip6","missRate":0.5} | 50% | $172.66 | $178.82 | $9.23 | $4.52 |
| L | {"q":3,"reloads":0,"reloadIndexChanged":false,"headerBytes":2048,"compression":"gzip6","missRate":1} | 100% | $179.99 | $186.15 | $15.82 | $11.11 |

## Legacy-to-current waterfall

The calculator reconstructs the archived legacy endpoints from [the legacy snapshot](hosting-cost-model-legacy-2026-10-18.md) and verifies the rounded old totals at cent precision. It then reruns pricing after each fixed-order substitution: **compression → sessionReuse → searchTreatment → requestCount → storage**. At every step it holds the other inputs fixed and records both the intermediate subtotal and its delta in the results JSON. The displayed deltas below are rounded for readability; the JSON retains full precision and all intermediate subtotals for every provider and scenario.

These are order-dependent model-substitution deltas, not independent causal effects. Step 1 keeps document views cold every page view and includes the cold-body remeasurement difference along with compression; it is not a pure compression effect. The sequence changes only the inputs named at each step, reruns the relevant pricing function including free tiers, and leaves no unexplained residual when compared with the endpoint.

| Size | Miss | AWS US legacy → new | Δ compression | Δ session reuse | Δ search treatment | Δ request count | Δ storage | AWS PC100 legacy → new | Δ compression | Δ session reuse | Δ search treatment | Δ request count | Δ storage |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S | 10% | $4.05 → $4.02 | $0.00 | $0.00 | $0.00 | -$0.02 | -$0.00 | $4.05 → $4.02 | $0.00 | $0.00 | $0.00 | -$0.02 | -$0.00 |
| S | 50% | $4.21 → $4.08 | $0.00 | $0.00 | $0.00 | -$0.13 | -$0.00 | $4.21 → $4.08 | $0.00 | $0.00 | $0.00 | -$0.13 | -$0.00 |
| S | 100% | $4.42 → $4.16 | $0.00 | $0.00 | $0.00 | -$0.26 | -$0.00 | $4.42 → $4.16 | $0.00 | $0.00 | $0.00 | -$0.26 | -$0.00 |
| M | 10% | $353.67 → $117.07 | -$224.93 | $0.00 | $0.00 | -$11.66 | -$0.00 | $355.91 → $117.07 | -$224.93 | $0.00 | $0.00 | -$13.91 | -$0.00 |
| M | 50% | $356.97 → $118.25 | -$224.93 | $0.00 | $0.00 | -$13.79 | -$0.00 | $359.21 → $118.25 | -$224.93 | $0.00 | $0.00 | -$16.04 | -$0.00 |
| M | 100% | $361.09 → $119.71 | -$224.93 | $0.00 | $0.00 | -$16.45 | -$0.00 | $363.34 → $119.71 | -$224.93 | $0.00 | $0.00 | -$18.70 | -$0.00 |
| L | 10% | $1,972.66 → $163.25 | -$1,573.23 | -$162.48 | -$9.12 | -$64.57 | -$0.00 | $1,991.89 → $169.41 | -$1,573.23 | -$162.48 | -$9.12 | -$77.64 | -$0.00 |
| L | 50% | $1,989.16 → $169.11 | -$1,573.23 | -$162.48 | -$9.12 | -$75.21 | -$0.00 | $2,008.39 → $175.27 | -$1,573.23 | -$162.48 | -$9.12 | -$88.28 | -$0.00 |
| L | 100% | $2,009.79 → $176.44 | -$1,573.23 | -$162.48 | -$9.12 | -$88.51 | -$0.00 | $2,029.01 → $182.60 | -$1,573.23 | -$162.48 | -$9.12 | -$101.57 | -$0.00 |

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

The sequence's exact step assumptions and every intermediate subtotal are in the decomposition.stages array of the linked JSON, including the viewer-request regional price distinction and the post-free-tier R2 result.

## Provenance, assumptions, and unmeasured scope

- Reader result: [hosting-cost-reader-session-results.json](hosting-cost-reader-session-results.json), measured 2026-10-24; model and calculated nine scenarios: [hosting-cost-model-results.json](hosting-cost-model-results.json).
- Environment: macOS Darwin arm64, Apple M4 / 10 cores / 32 GiB RAM; Node v22.14.0; Go go1.26.10 darwin/arm64; CLI 0.5.2; Chromium 153.0.8010.12; Playwright 1.63.0; nginx:1.29-alpine; clean working tree at source commit b9847b9e0a6104ca2428486f8bd56460821cba95. Generator v2, seed 20261014; three unthrottled iterations, local nginx, stored gzip indexes/manifests. Prices are fixed to 2026-10-18 inputs.
- The monthly S/M/L workloads retain the legacy 30-day schedule and view/search counts. The reader metrics and publisher projections are measured locally, but miss rates, page views, session grouping, query mix, and monthly publish counts remain scenario assumptions; no production traffic or billing data was used.
- AWS viewer-response bandwidth uses local response bytes plus modeled 1,024-byte response headers and AWS price tiers. It does not claim that local nginx reproduces live CloudFront negotiation or compression. AWS transfer costs at L reflect the model's 1 TB allowance and the complete counted bytes.
- CloudFront Functions execution cost is **unmeasured and excluded**. Preview lifecycle, registry sync, app-deploy provider calls, preview and registry storage, CloudFront WAF/logging, account-wide allowance consumption, taxes, and other account charges are also excluded. The totals are measured-unit subtotals, not an all-in budget.
- No cloud account, provider API, release, tag, or paid load test was used for these measurements.

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
