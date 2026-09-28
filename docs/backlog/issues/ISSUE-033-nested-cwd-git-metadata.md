# Keep Git metadata stable when building from a repository subdirectory

- Status: Open
- Priority: P2
- Area: Indexer / working-directory resolution
- Review: 2026-09-28, finding 20, source revision `50c327d886c71fc5e0d086a5967b90cd9038e01e`

## Problem

Git commands use repository-relative pathspecs without a matching repository-root working directory. A successful build from a subdirectory silently loses committer metadata and can misdetect working-tree changes.

## Evidence and reproduction

1. Build a tracked source from repository root using `--source docs/artifacts`.
2. From that repository's docs directory, build the same source using `--source artifacts`.
3. The review recorded metadata in the root invocation but no committer in the nested invocation, both successful.

Reviewed source: [internal/indexer/build.go:697,746](../../../internal/indexer/build.go). The review's supplementary local evidence is `.local/reviews/2026-09-28/nested-directory-evidence.json`; it is ignored and is not required to understand or reproduce this issue. Preserve the reproduction as a committed regression when implementing the fix.

## Expected outcome

Equivalent source selections produce equivalent Git-derived metadata regardless of the caller's directory inside the checkout.

## Acceptance criteria

- [ ] Root and nested-directory builds of the same source produce matching history metadata and dirty-state classification.
- [ ] Relative and absolute source forms resolve to the same registered source boundary.
- [ ] Tests cover staged/unstaged changes and tracked nested paths, not just clean commits.
- [ ] Metadata failures do not become silent fabricated or missing provenance; preserve validation of sources outside the Git working tree.
