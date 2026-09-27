# IMP-01 — Preview records and storage-key codec

- Status: Done
- Phase: Phase 1 local preview contract
- Depends on: minimum [T1 record shape](../technical-design/T1-preview-record-contract.md); remaining fields can be refined by the local round trip.
- Proves: [T4](../verification/T4-serving-boundary.md), [T5](../verification/T5-concurrency-recovery.md)

## Outcome

Provide versioned, validated catalog and immutable revision-manifest types plus canonical site/revision/document storage-key construction. The catalog is discovery; the manifest independently resolves a fixed document URL. Keep the storage adapter boundary provider-neutral.

## Evidence

Go tests validate strict schema/path rejection, canonical encoded keys and PR URLs, fixture catalog/manifest decoding, PR/manual groups that share a head, same-head immutable retry behavior, and rejection of mismatched catalog/manifest site and head references. Playwright verifies direct manifest-backed routes, a missing manifest, missing raw files, and reserved/Unicode preview URLs. Exact v1 records and keys are recorded in [T1](../technical-design/T1-preview-record-contract.md).

## Acceptance criteria

- Round-trip fixture records for a PR group and manual head group; reject unknown versions, duplicate/colliding IDs, unsafe paths, and mismatched site/head references.
- Resolve a revision document from its manifest without consulting the catalog; resources are not routable documents.
- Preserve full head SHA and source-relative filename/extension; group context never changes artifact identity or bytes.
- Tests cover missing catalog, missing manifest, malformed records, and same-head manifest validation. Record exact schema and keys in T1 before calling this done.
