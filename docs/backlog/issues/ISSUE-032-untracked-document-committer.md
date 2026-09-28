# Do not assign a resource committer to a document without Git history

- Status: Open
- Priority: P2
- Area: Indexer / Git provenance
- Review: 2026-09-28, finding 19, source revision `50c327d886c71fc5e0d086a5967b90cd9038e01e`

## Problem

Shared-resource history is applied to all artifacts in a directory, including untracked documents. A new document can display someone else's resource commit as its last committer, contrary to the no-history metadata contract.

## Evidence and reproduction

1. Commit only `source/assets/logo.svg`.
2. Create untracked `source/new.md` and build the source index.
3. The review observed new.md inheriting the logo committer despite having no document Git history.

Reviewed source: [internal/indexer/build.go:731,794](../../../internal/indexer/build.go). The review's supplementary local evidence is `.local/reviews/2026-09-28/indexer-evidence.json / git_status and new.md`; it is ignored and is not required to understand or reproduce this issue. Preserve the reproduction as a committed regression when implementing the fix.

## Expected outcome

Artifacts without Git history remain indexable but omit lastCommitter; displayed provenance describes facts rather than inferred authorship.

## Acceptance criteria

- [ ] Untracked and never-committed ignored/generated documents omit lastCommitter and use the documented timestamp fallback.
- [ ] Tracked documents retain legitimate document/resource-derived update behavior where the contract permits it.
- [ ] Tests distinguish document tracking/history from shared-resource history, including mixed tracked/untracked directories.
- [ ] No Git authorship or viewer identity fields are invented as a workaround.
