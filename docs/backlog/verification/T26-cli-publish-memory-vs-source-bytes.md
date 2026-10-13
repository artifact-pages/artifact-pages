# T26 — CLI publish memory against source bytes

- Status: Open
- Phase: Post-launch measurement
- Scope: peak RSS and time of `site publish` (no-op, diff, dry-run, first publish) near candidate limits
- Implementer: Codex
- Source: public-launch review 2026-10-13, section 3 (CLI part)

## Contract to prove

The memory use of a publish is known as a function of source bytes, and a maximum file size and total source size are documented.

`cli/internal/indexer/prepare.go` (around line 356) reads every file, including resources, and keeps the bytes in the snapshot. Provider-neutral objects take byte slices, and `cli/internal/publisher/site_publish_apply.go` (`putSitePublishObject`, around line 132) may re-read a source file at upload. Large images, generated reports, PDFs or video can therefore drive peak RSS even with few files. No out-of-memory failure has been reproduced.

## Exit criteria

- [ ] Peak RSS and wall time are recorded for no-op, differential publish, dry-run and first publish at sizes near the candidate limits.
- [ ] A maximum file size and a total source size to document are proposed from the measurements.
- [ ] The result states whether streaming or immutable staging is needed. The decision itself is taken after the measurement, not in this ticket.

## Evidence

(empty)
