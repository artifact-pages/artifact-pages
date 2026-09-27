# T1 — Preview catalog and revision-manifest contract

- Status: In progress
- Phase: Post-MVP preview

## Design question

What are the exact versioned records and storage keys for a site-scoped discovery catalog and an immutable head-SHA revision? The reader must not invent a PR association from a branch name, Git history, or a coincidentally shared head SHA.

## Accepted provenance input

Pre-publish may receive an explicit PR number or URL. Only then may the group be PR-scoped and the application display a PR link; without that input, it is a manual head-SHA group and no PR link appears. The CLI/Action must normalize and validate the supplied reference against the registered source repository. The exact option spelling and validation mechanism belong to [T2](T2-cli-action-interface.md).

The fixed route `/:site/_previews/<head SHA>/<artifact path>` still renders from its revision manifest without catalog membership. A PR-specific group-list URL and PR-group-contextual revision-specific document URLs are available as CLI outputs for a caller-owned workflow to post in a PR comment; the Action does not post comments itself.

## Accepted reader-context behavior

Keep PR metadata on the explicitly named catalog group, not on the immutable head-SHA manifest. Every PR-associated preview artifact URL carries that group's view context; changed-document navigation within the revision preserves it. The reader shows its PR link only after confirming that the explicitly PR-associated group currently points to that head SHA. A bare fixed document URL, a manual preview, or one whose group no longer matches still renders but shows no PR link. This avoids falsely attributing one revision to a PR when two explicit PR groups share the same head. The PR link can disappear when a group leaves discovery, while the document remains accessible until provider removal. The exact query encoding and schema remain to be specified and proven.

The candidate manifest's `comparisonBaseSha` currently labels a resolved default-branch HEAD, while document selection also uses a merge-base. Proposed field names are `defaultHeadSha` and `mergeBaseSha` for these distinct Git values; verify the same-head retry comparison before freezing them. Keep catalog document summaries only if the Previews list/palette needs them without loading every full manifest; measure that choice in [T7](../verification/T7-discovery-performance.md).

## Exit criteria

- [ ] Specify catalog and manifest fields, canonical paths, storage keys, and the relationship between a group and a revision in the [publishing contract](../../architecture/preview-publishing-contract.html#shape).
- [x] Settle whether a bare fixed URL omits the PR link and whether optional group context is validated against the catalog.
- [ ] Validate a local producer/reader round trip, including same-head retry and a manifest removed by the provider.
- [x] Update the [specification](../../specification.md#post-mvp-pre-publish-preview-contract) for the accepted browser-facing behavior.

## Evidence

The [publishing contract](../../architecture/preview-publishing-contract.html#shape) contains candidate JSON examples. Explicit PR input and group-contextual PR return links are accepted product rules; the URL encoding and record schema are not yet frozen or producer/reader-tested.
