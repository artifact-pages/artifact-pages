# IMP-77 — Full-text section table and text packs

- Status: Open
- Lanes: CLI (primary), Frontend (participating)
- Owner: Codex
- Depends on: [TD20](../technical-design/TD20-search-results-page-and-snippet-packs.md) (direction accepted 2026-10-11)
- Blocks: [ISSUE-085](../issues/ISSUE-085-page-text-search-snippets.md) (snippets in the results page)
- Workstream: WS1 Search results and snippets ([workstreams](../workstreams.md#current-work-packages-2026-10-11))

## Goal

TD20 slice 2: at publish time, write the section table and content-addressed text packs next to the v1 full-text objects, so the reader can show where a page matched without fetching pages at runtime.

## Scope

1. **Format contract first, as its own small PR.** Settle the byte layout of `sections-<sha256>.gz` and `text-<sha256>.gz`, the optional manifest fields `sections` and `texts`, the pack constants (minimum 16 KiB, target about 64 KiB, maximum 256 KiB raw unless the owner changes them), deterministic gzip, section levels (h1–h3 unless the owner adds h4), and the caps and their manifest record. Write it in `docs/architecture/fulltext-search.md` and add golden fixture files under `cli/internal/fulltext/testdata/` that both the Go writer and the web reader test against (web tests read them; only Codex edits them). Claude reviews the contract PR, then starts the reader side of ISSUE-085 in parallel.
2. Writer in the indexer, using the same text normalisation as the v1 index; sections at the `toc` anchors.
3. Publisher reconciliation: extend `sitePublishStateSearchBlob` (`cli/internal/publisher/site_publish_state.go`) and the object-policy mapping to `text-` and `sections-`; immutable cache headers like the existing leaf objects.
4. Caps: warn in the CLI output and record omitted or truncated documents in the manifest; never fail the publish.

## Not in scope

Reader code under `web/` (ISSUE-085, Claude). The CLI release that ships it (WS4).

## Acceptance criteria

- [ ] Format contract and golden fixtures merged before the writer; Claude reviewed it.
- [ ] Unchanged documents keep their packs (and hashes) across a republish; a test proves it.
- [ ] v1 readers keep working against an index with the new objects (no v1 object changes).
- [ ] Publisher state accepts the new keys; an older CLI's behaviour on such a site is recorded (TD20 notes it converges to v1 or fails closed).
- [ ] Caps warn and are recorded in the manifest.
