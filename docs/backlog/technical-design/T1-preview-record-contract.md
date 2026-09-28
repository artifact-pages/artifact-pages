# T1 — Preview catalog and revision-manifest contract

- Status: Done
- Phase: Phase 1 local preview contract; provider lifecycle remains post-MVP

## Design question

What are the exact versioned records and storage keys for a site-scoped discovery catalog and an immutable head-SHA revision? The reader must not invent a PR association from a branch name, Git history, or a coincidentally shared head SHA.

## Settled v1 contract

The implementation and fixture use these records:

- Catalog: `{ schemaVersion, site, groups[] }`.
- Group: `{ id, kind, headSha, prUrl?, updatedAt, documents[] }`; `id` is `pr:<number>` for an explicit same-repository PR or `head:<full SHA>` for a manual preview.
- Revision manifest: `{ schemaVersion, site, headSha, defaultHeadSha, mergeBaseSha, createdAt, bundleDigest, files[], documents[] }`.
- File: `{ path, sha256, contentType }`. Document: `{ path, title, format }`.
- Static keys: `/_previews/<site>/catalog.json`, `/_previews/<site>/revisions/<full SHA>/manifest.json`, and `/_previews/<site>/revisions/<full SHA>/files/<source-relative path>`.
- Logical document URL: `/:site/_previews/<full SHA>/<document path>`. Optional `?group=pr%3A<number>` is reader context only and does not alter the revision URL or stored bytes.

SHA values are full lowercase 40- or 64-character Git object IDs. Manifest paths are canonical source-relative POSIX paths and preserve their raw UTF-8 names. Canonical `PreviewStore` file keys percent-encode each path segment once; `DirectoryStore` and `publisher.ObjectPreviewStore` validate and decode each segment exactly once when mapping to a local file or provider object key. Physical storage keys therefore preserve the source name, and the reader and Action URLs encode each segment once. The bundle digest sorts raw paths and hashes, for each path and its final head-tree bytes, an eight-byte big-endian path length, UTF-8 path bytes, an eight-byte big-endian content length, and content bytes. Documents and resources are stored unchanged; changed/unchanged link routing is resolved by the reader.

The provider boundary is `PreviewStore`: `ReadObject` distinguishes confirmed absence (`ErrObjectNotFound`) from other failures; `CreateImmutableObject` does not replace an existing key with different bytes; `ReplaceMutableObject` updates the catalog; and `WithSiteLock` serializes cooperating operations by site. `DirectoryStore` implements this boundary for preview development and coordinates operations only within the current process. `publisher.ObjectPreviewStore` bridges the contract to deployment backends; real-provider origin, locking, cache, and lifecycle behavior remains under separate verification.

## Accepted provenance input and reader context

Pre-publish may receive an explicit PR number or URL. Only then may the group be PR-scoped and the application display a PR link; without that input, it is a manual head-SHA group and no PR link appears. The local helper currently accepts a canonical same-repository GitHub URL and validates its repository and head SHA. The eventual CLI/Action spelling remains in [T2](T2-cli-action-interface.md).

Keep PR metadata on the explicitly named catalog group, not on the immutable head-SHA manifest. The reader shows its PR link only after confirming that the explicitly PR-associated group currently points to that head SHA. A bare fixed document URL, a manual preview, or one whose group no longer matches still renders but shows no PR link. This avoids falsely attributing one revision to a PR when two explicit PR groups share the same head.

## Exit criteria

- [x] Specify catalog and manifest fields, canonical paths, storage keys, and the relationship between a group and a revision in the [publishing contract](../../architecture/preview-publishing-contract.html#shape).
- [x] Settle whether a bare fixed URL omits the PR link and whether optional group context is validated against the catalog.
- [x] Validate a generated local projection in the browser, including same-head retry and a manifest becoming missing at the serving boundary.
- [x] Update the [specification](../../specification.md#post-mvp-pre-publish-preview-contract) for the accepted browser-facing behavior.

## Evidence

`internal/preview/records.go` and `store.go` implement strict v1 validation, canonical keys, same-head checks, and the store contract. Go tests validate shared-head PR/manual fixture records, schema/path rejection, idempotent local writes, and encoded filesystem keys. The ISSUE-015 regressions also compare raw keys across `DirectoryStore` and `ObjectPreviewStore` and exercise an encoded document and resource URL against the configured local target through nginx. Playwright covers committed fixtures, direct routes, missing manifests, same-head PR disambiguation, and encoded path reloads. A separate smoke run built a local preview from a temporary Git repository, served it from `.local/previews` through nginx, opened the generated document in the browser, retried the same head, then removed the manifest and confirmed the direct route became unavailable and its catalog candidate was hidden. This closes the local v1 contract; live provider-origin behavior remains under T2/T3/T9 and T4/T5/T8.

## Implementation links

The record decisions feed [IMP-01 records](../implementation/IMP-01-preview-records.md), [IMP-04 provenance](../implementation/IMP-04-pr-provenance.md), [IMP-05 publication](../implementation/IMP-05-publication.md), [IMP-08 reader](../implementation/IMP-08-preview-reader.md), [IMP-09 discovery](../implementation/IMP-09-discovery.md), and [IMP-10 PR return links](../implementation/IMP-10-pr-return-link.md). The [implementation index](../implementation/README.md) maps every dependent slice. Provider-specific implementation and lifecycle proofs remain open.
