# CLI publish memory against source bytes

## Conditions

Under these conditions, we measured the local CLI process's peak resident memory and elapsed time for the four publish scenarios below. These are measurements of this build and these corpora, not support limits.

| Item | Value |
| --- | --- |
| Run | 2026-10-17, captured at 2026-10-17T07:26:10.719Z |
| Machine | `Mac16,10`, arm64, 34,359,738,368 bytes RAM (32 GiB), from `sysctl hw.model hw.memsize` |
| OS | macOS 26.5.1 |
| Go | go1.26.9 darwin/arm64 |
| CLI source commit | `3a2a3702aca7afa063cf9ff7dcd8b531f3fa98b6` (recorded base commit; CLI source is unchanged on this branch) |
| CLI build | `go build -o <run>/artifact-pages ./cli/cmd/artifact-pages`; run-local `GOCACHE`, `GOPROXY=off`, `GOTOOLCHAIN=local` |
| Storage target | Local filesystem provider; no cloud traffic |
| Timing | macOS `/usr/bin/time -l`; maximum resident set size in bytes and `real` elapsed seconds |
| Repetitions | 3 per scenario and corpus; median and maximum shown below |
| Binary source generation | Deterministic AES-256-CTR byte stream, seed `artifact-pages-cli-publish-memory-t26-20261017` |
| Harness command | `npm run benchmark:cli-publish-memory -- --repetitions 3` |

First publish began with an empty storage root for each repetition. No-op publish used the same commit. Differential publish used one new commit changing one HTML page body by 1 KiB. Dry-run used a further one-file change. All 60 timed commands returned exit status 0. The [committed results JSON](cli-publish-memory.results.json) retains all samples and measured numbers; verbose command stdout and stderr were omitted from this copy.

The generated HTML pages were small valid documents of 8 KiB each. Source sizes and largest-file sizes below are read from the committed results JSON. MiB is bytes divided by 1,048,576; the scenario tables show the median and maximum of the three measured samples.

| Corpus | Source shape | Files | Total source (MiB) | Largest file (MiB) |
| --- | --- | ---: | ---: | ---: |
| `many-small` | 5,000 HTML pages × 8 KiB; 5,000 PNG-named binary resources × 32 KiB | 10,000 | 195.3 | 0.03 |
| `one-large-64` | 20 HTML pages × 8 KiB; one 64 MiB binary resource | 21 | 64.2 | 64 |
| `one-large-256` | 20 HTML pages × 8 KiB; one 256 MiB binary resource | 21 | 256.2 | 256 |
| `one-large-512` | 20 HTML pages × 8 KiB; one 512 MiB binary resource | 21 | 512.2 | 512 |
| `many-large` | 20 HTML pages × 8 KiB; 40 binary resources × 25 MiB | 60 | 1,000.2 | 25 |

## Results

### `many-small`

| Scenario | Median peak RSS (MiB) | Max peak RSS (MiB) | Median time (s) | Max time (s) |
| --- | ---: | ---: | ---: | ---: |
| First publish | 749.9 | 766.7 | 152.160 | 152.220 |
| No-op publish | 236.8 | 291.5 | 4.120 | 5.600 |
| Differential publish | 783.9 | 888.8 | 2.740 | 2.750 |
| Dry-run | 801.4 | 868.1 | 2.300 | 2.440 |

### `one-large-64`

| Scenario | Median peak RSS (MiB) | Max peak RSS (MiB) | Median time (s) | Max time (s) |
| --- | ---: | ---: | ---: | ---: |
| First publish | 157.6 | 157.7 | 0.560 | 0.580 |
| No-op publish | 86.1 | 86.1 | 0.150 | 0.160 |
| Differential publish | 157.1 | 157.6 | 0.250 | 0.290 |
| Dry-run | 157.3 | 157.4 | 0.150 | 0.160 |

### `one-large-256`

| Scenario | Median peak RSS (MiB) | Max peak RSS (MiB) | Median time (s) | Max time (s) |
| --- | ---: | ---: | ---: | ---: |
| First publish | 542.2 | 542.2 | 0.890 | 1.000 |
| No-op publish | 278.0 | 278.3 | 0.260 | 0.270 |
| Differential publish | 541.8 | 541.8 | 0.390 | 0.400 |
| Dry-run | 541.7 | 542.0 | 0.260 | 0.350 |

### `one-large-512`

| Scenario | Median peak RSS (MiB) | Max peak RSS (MiB) | Median time (s) | Max time (s) |
| --- | ---: | ---: | ---: | ---: |
| First publish | 1,054.3 | 1,054.3 | 1.150 | 1.510 |
| No-op publish | 534.3 | 534.5 | 0.370 | 0.370 |
| Differential publish | 1,055.5 | 1,055.7 | 0.540 | 0.640 |
| Dry-run | 1,053.9 | 1,054.4 | 0.400 | 0.770 |

### `many-large`

| Scenario | Median peak RSS (MiB) | Max peak RSS (MiB) | Median time (s) | Max time (s) |
| --- | ---: | ---: | ---: | ---: |
| First publish | 2,032.1 | 2,032.1 | 2.410 | 2.710 |
| No-op publish | 1,023.6 | 1,023.8 | 0.600 | 0.620 |
| Differential publish | 2,032.7 | 2,033.5 | 0.920 | 1.020 |
| Dry-run | 2,032.3 | 2,032.6 | 0.800 | 0.800 |

## Observations

- Under these conditions, measured peak RSS rose with total source bytes in the single-large-file series. At 64.2 MiB source, non-no-op scenario maxima were 157.4–157.7 MiB; at 256.2 MiB they were 541.8–542.2 MiB; at 512.2 MiB they were 1,054.3–1,055.7 MiB. The 64 MiB case has more fixed overhead relative to its source size; the larger cases are about 2× source bytes.
- For the 1,000.2 MiB `many-large` corpus, first, differential and dry-run maxima were 2,032.1–2,033.5 MiB, about 2× source bytes. Its no-op maximum was 1,023.8 MiB, about 1× source bytes. The same pattern appears in the larger single-file corpora: no-op maxima were 278.3 MiB for 256.2 MiB source and 534.5 MiB for 512.2 MiB source.
- The `many-small` corpus contained 195.3 MiB across 10,000 files, including 5,000 HTML pages. Its first, differential and dry-run medians ranged from 749.9 to 801.4 MiB, and the largest of those samples was 888.8 MiB. This is about 750–890 MiB RSS for about 200 MiB of source. The corpus changes both file count and document count relative to the one-large cases, so these results do not isolate a per-file or indexing allocation cost.
- The source path in `cli/internal/publisher/site_publish.go:PublishSite` calls `indexer.PrepareBuild` before loading publish state. In `cli/internal/indexer/prepare.go:captureSourceTree`, the normal publish path reads each file with `os.ReadFile`, hashes that in-memory slice with SHA-256, and retains it in `SourceFileSnapshot.bytes`. `PreparedBuild.ReadSourceFile` returns a new byte-slice copy. For non-no-op builds, `cli/internal/publisher/site_publish_manifest.go:preparedSiteObjects` calls it for every source file and retains those copies in desired objects. This matches the roughly 2× peaks observed for the large-file publishes.
- No-op still reads and hashes the source snapshot, but `cli/internal/publisher/site_publish_manifest.go:loadSitePublishSnapshot` marks an unchanged reusable input as a fast path; `buildSitePublishDiff` returns before calling `preparedSiteObjects`. That path is consistent with no-op peaks near 1× source bytes.
- `cli/internal/publisher/site_publish_apply.go:putSitePublishObject` has an optional `sourcePath` branch that re-reads and hashes a whole file. `preparedSiteObjects` supplies `data` and leaves `sourcePath` empty, so this branch was not used for these measured snapshot-backed objects. Hashing at capture and the local backend operates on existing slices; the local filesystem provider does not add an application-level encryption copy. R2/S3 were not measured and may add upload buffers.

## Input for an owner decision

These candidate boundaries are options derived from the measured corpora, not supported limits or a pass/fail threshold. Total-source candidates round the measured source totals up to the next whole MiB. “Highest observed RSS” means the largest sample among the measured corpora that fit the candidate pair.

| Candidate maximum single file | Candidate maximum total source | Highest observed RSS among matching measured shapes | Measurement behind the value |
| ---: | ---: | ---: | --- |
| 64 MiB | 65 MiB | 157.7 MiB | `one-large-64`, 64.2 MiB total |
| 256 MiB | 257 MiB | 888.8 MiB | `many-small` (195.3 MiB, 10,000 files) is higher than `one-large-256` (542.2 MiB) |
| 512 MiB | 1,001 MiB | 2,033.5 MiB | `many-large`, 1,000.2 MiB total; the 512 MiB single-file corpus measured 1,055.7 MiB |

The repository verification workflow selects `ubuntu-24.04` in [.github/workflows/verify.yml](../../.github/workflows/verify.yml). GitHub's [standard hosted runner documentation](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) lists 16 GB RAM for standard Linux runners on public repositories and 7 GB for private repositories. The largest measured CLI peak was about 2.0 GiB on this 32 GiB Mac. That leaves nominal capacity on either documented runner size, with materially less headroom on a 7 GB runner; the OS, Node, browser tests and other processes also need memory. This benchmark did not measure a GitHub-hosted runner.

These results provide evidence for the owner's decision by showing that non-no-op large-file publishes retained the source snapshot and made a second full-size byte copy. A documented size limit bounds accepted inputs, although the `many-small` results show that total bytes alone do not capture the higher-RSS shape with many files and documents. Streaming could reduce heap duplication, with changes needed for streaming storage and stable hashing/source-change checks across reads. Disk-backed immutable staging could preserve a fixed upload snapshot and reduce heap copies, with additional disk capacity, I/O, and temporary-file cleanup and recovery work. The measurements inform these tradeoffs but do not select an option; the size-limit and streaming/staging criteria await an owner decision.
