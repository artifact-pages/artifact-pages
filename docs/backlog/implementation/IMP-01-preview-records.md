# IMP-01 — Preview records and storage-key codec

- Status: Open
- Phase: Post-MVP preview
- Depends on: minimum [T1 record shape](../technical-design/T1-preview-record-contract.md); remaining fields can be refined by the local round trip.
- Proves: [T4](../verification/T4-serving-boundary.md), [T5](../verification/T5-concurrency-recovery.md)

## Outcome

Provide versioned, validated catalog and immutable revision-manifest types plus canonical site/revision/document storage-key construction. The catalog is discovery; the manifest independently resolves a fixed document URL. Keep the storage adapter boundary provider-neutral.

## Acceptance criteria

- Round-trip fixture records for a PR group and manual head group; reject unknown versions, duplicate/colliding IDs, unsafe paths, and mismatched site/head references.
- Resolve a revision document from its manifest without consulting the catalog; resources are not routable documents.
- Preserve full head SHA and source-relative filename/extension; group context never changes artifact identity or bytes.
- Tests cover missing catalog, missing manifest, malformed records, and same-head manifest validation. Record exact schema and keys in T1 before calling this done.
