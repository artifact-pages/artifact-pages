# IMP-02 — Git snapshot and changed-document selection

- Status: Done
- Phase: Phase 1 local preview contract
- Depends on: none; its output can be tested independently of storage.
- Informs: [T1](../technical-design/T1-preview-record-contract.md)
- Proves: [T6](../verification/T6-resources-navigation.md)

## Outcome

Resolve source head, default-branch HEAD and merge-base from Git, then select only added/modified HTML or Markdown documents under the registered source path. Read selected bytes from the head snapshot, not the current working tree or a temporary merge.

## Evidence

`go test ./internal/preview ./cmd/preview-local` passed on 2026-09-27. Integration cases cover added/modified documents, rename destination, deletion-only `no-preview`, non-document-only failure, default-branch-only changes, full SHA provenance, unchanged files, symlink rejection, and preservation of a dirty working tree.

## Acceptance criteria

- Tests cover additions, modifications, rename destination, deletion-only `no-preview`, non-document-only error, unchanged documents, and default-branch-only changes.
- A default-branch advance alone does not change the identity of an existing head revision; record default HEAD and merge-base distinctly.
- Reject paths outside the registered source tree and unsupported/symlinked entries without reading escaped bytes.
- Selection is deterministic for the same Git inputs; it does not mutate source files or production indexes.
