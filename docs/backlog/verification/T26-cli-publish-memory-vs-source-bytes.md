# T26 — CLI publish memory against source bytes

- Status: Done
- Assignee: Codex
- Phase: Post-launch measurement
- Scope: peak RSS and time of `site publish` (no-op, diff, dry-run, first publish) near candidate limits
- Implementer: Codex
- Source: public-launch review 2026-10-13, section 3 (CLI part)

## Contract to prove

The memory use of a publish is known as a function of source bytes, and a maximum file size and total source size are documented.

`cli/internal/indexer/prepare.go` (around line 356) reads every file, including resources, and keeps the bytes in the snapshot. Provider-neutral objects take byte slices, and `cli/internal/publisher/site_publish_apply.go` (`putSitePublishObject`, around line 132) may re-read a source file at upload. Large images, generated reports, PDFs or video can therefore drive peak RSS even with few files. No out-of-memory failure has been reproduced.

## Exit criteria

- [x] Peak RSS and wall time are recorded for no-op, differential publish, dry-run and first publish at sizes near the candidate limits.
- [x] A maximum file size and total source size are documented from the measurements (owner choice, 2026-10-17): 512 MiB per file and 1 GiB total per publish, documented and not enforced by the CLI; see Owner decision.
- [x] The result states whether streaming or immutable staging is needed: not pursued now (owner decision, 2026-10-17).

## Evidence

- [CLI publish memory measurement report](../../research/cli-publish-memory.md) and [sample results](../../research/cli-publish-memory.results.json) record the measured conditions, results, code paths and options for an owner decision.
- Under local storage on `Mac16,10`, the run measured all 20 corpus/scenario cells three times; the largest observed peaks were 888.8 MiB for `many-small` and 2,033.5 MiB for `many-large`.

## Verification

- [Report](../../research/cli-publish-memory.md) and [sample results](../../research/cli-publish-memory.results.json) retain all 60 timed command samples; every command returned exit status 0.
- Measurement is complete. The owner decision of 2026-10-17 closed the size-limit and streaming/staging criteria.

## Owner decision

2026-10-17: document a size limit (512 MiB per file, 1 GiB total per publish; the largest measured shapes), not enforced by the CLI. Streaming and immutable staging are not pursued now. The guideline is in the specification (Publishable source directory, "Memory and source size") and the root README status list; it follows the [report](../../research/cli-publish-memory.md).

## Initial local RSS baseline, 2026-10-15

| Condition | Value |
| --- | --- |
| Source | Monorepo `86841bb1`; CLI built with `go build -trimpath` |
| Host | macOS arm64, 32 GiB RAM, Go 1.26.7 |
| Target | Local provider; no cloud traffic |
| Input | One committed Markdown page with a fixed H1, plus one zero-filled resource file; resource sizes 0, 64 and 256 MiB |
| Measurement | `/usr/bin/time -l`, one run per cell; macOS maximum resident set size in bytes, divided by 1,048,576 for MiB |
| Cache conditions | OS/filesystem cache not controlled. Initial/dry-run had no published site content; no-op ran after the initial publish. These are not controlled cold/warm timing benchmarks |

| Mode | Resource MiB | Peak RSS MiB | Wall seconds |
| --- | --- | --- | --- |
| `site sync --dry-run` | 0 | 23.6 | 0.12 |
| `site sync --dry-run` | 64 | 151.3 | 0.16 |
| `site sync --dry-run` | 256 | 535.8 | 0.48 |
| `site sync` initial | 256 | 536.7 | 1.02 |
| `site sync` no-op | 256 | 277.0 | 0.28 |

Reproduction: initialize a disposable Git repository with an `origin` such as `https://github.com/acme/review.git`; commit `content/page.md`; configure the local provider and register that repository with `sourcePath: content`. Create `content/resource.bin` at the selected byte size (zero-filled is sufficient). Run `registry sync`, then time `site sync --site review --config <local-config> --dry-run` for each input size. For 256 MiB, time one real local sync and the immediately following no-op. Keep all target paths outside the source directory.

These measurements confirm growth with resource bytes even with one indexed page. No OOM occurred. They do not establish a supported input limit, differential-publish behavior, cloud-provider overhead, large-document parse costs or percentiles. This is partial evidence; no exit criterion is marked complete and no streaming/staging design is selected.

Supplementary workspace artifacts: `reviews/2026-10-15-project/cli-memory-probe.py`, `cli-memory-results.json`, `cli-memory-apply-results.json` and `memory-*.log`. The synthetic repositories/resource trees were removed after inventory; the script and logs remain.
