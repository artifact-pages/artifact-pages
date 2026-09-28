# Preview decision register

Status: **Phase 1 local preview slice exists; provider publishing remains post-MVP**

This page records product decisions for pre-publish previews. The [specification](../specification.md#post-mvp-pre-publish-preview-contract) is authoritative for accepted behavior; the [publishing contract](preview-publishing-contract.html) is a technical proposal. Track unresolved technical design, implementation slices, and unrun verification in the [backlog](../backlog/README.md), separately from [product issues](../backlog/issues/README.md). Keep this register short: move a resolved product decision into the specification and record its outcome here.

Phase 1 has a local preview-development path using `cmd/preview-local`, a directory-backed `PreviewStore`, static nginx serving, and the browser preview reader. Separately, the registered-site `site publish` path uses the provider-neutral deployment backend and reconciles confirmed-missing preview catalog entries after production writes. Its configured local target (for example `.local/storage`) is separate from the preview-development output at `.local/previews`. This establishes the local reconciliation flow only; CI wrapper parity and AWS/Cloudflare origin, cache, and lifecycle behavior remain separate implementation or verification work. Provider-specific read/write/lock mechanics belong behind the storage interfaces; shared record keys, publication ordering, and browser routes stay provider-neutral.

## Status vocabulary

| Status | Meaning |
| --- | --- |
| **Open — product** | A data-model, access-policy, or reader-UX choice needs an explicit product decision. |
| **Accepted** | Decided and recorded in the specification. Do not reopen merely because the implementation is pending. |
| **Deferred** | Deliberately outside the initial preview release. |

## Open product decisions

No open product decisions are recorded for this preview lifecycle.

## Recently accepted

| ID | Status | Outcome |
| --- | --- | --- |
| P1 | Accepted | Site home provides a quiet link to the dedicated Previews list. It does not display an inline preview list or require a potentially stale count. |
| P2 | Accepted | The hosting provider exclusively owns preview lifetime. The application stores no expiry timestamp, runs no expiry timer, and does not promise exact-time removal. Catalog candidates are checked against provider manifest availability when read. |
| P3 | Accepted | Use [B: header context](../ui/ui-preview-identity-concepts.html#b). Keep the document H1 untouched. When PR provenance is unambiguous, its number is a subtle link to that PR; manual previews have no PR link. No app-managed expiry label or persistent reader strip. |
| P4 | Accepted | A preview stays discoverable while its catalog entry and manifest exist, even when its PR is merged or closed without merging. Provider removal makes it unavailable to the reader; the next catalog write prunes the stale reference. No PR-close workflow or browser-side PR-state polling. |
| P5 | Accepted | Do not require a PR-close or scheduled-cleanup workflow. Preview discovery follows provider availability: merged, unmerged, closed and manual previews remain listed while their manifests exist. `artifact-pages site publish` prunes only references whose provider manifests are confirmed missing, in both local and CI runs. If changed, commit the site-scoped catalog after the production projection is committed at origin. GitHub Actions wraps the same CLI operation rather than owning cleanup. Completed revision bytes and fixed URLs remain provider-owned. |
| P6 | Accepted | Pre-publish attaches PR provenance only when the caller explicitly supplies a PR number or URL. No input means a manual head-SHA group and no PR link in the reader. The supplied reference must match the registered source repository; the CLI/Action do not infer one from branch, commit, or CI event. Exact input spelling and validation remain technical design. |
| P7 | Accepted | Each PR-associated preview artifact URL carries its PR-group view context, so the reader can link back to the PR from every preview document and preserve that context across changed-document navigation. Show the PR link only while the catalog confirms that the explicitly PR-associated group points to the URL's head SHA. A bare URL, manual preview, or unavailable/mismatched group shows no PR link but does not block document rendering from its completion manifest. Group context never changes revision identity or artifact bytes. |
| P8 | Accepted | Preview HTML uses the production HTML trust model: trusted executable content in a same-origin, unsandboxed iframe, with intentional parent-DOM/browser-storage access. Pre-publish is publication approval; registered-source and no-fork checks remain, and no additional preview hostname or null/wildcard CORS grant is required. Markdown stays sanitized/non-executable. Accepted by the owner on 2026-09-28; TD3 records the contract, while ISSUE-026 and T4/T6/T15 own implementation and proof. |

## Unfinished work

The [backlog](../backlog/README.md) is the status source for technical design, implementation, and verification associated with this contract. Keep their status and evidence there; this register records only product decisions. TD3 is settled, but ISSUE-026 must still replace the former isolated-loopback/opaque-frame reader and re-prove the accepted rendering contract.

## Accepted product contract

The following are not open decisions: a preview belongs to a registered site; automatic PR publication accepts same-repository heads but not forks; a revision is identified by full head SHA; only added/modified HTML or Markdown documents are previewed; deletions are not pages; local resources come from the head snapshot; the production index and normal search stay unchanged; discovery is a site-local mutable catalog with one latest revision per group; direct document links remain revision-specific; catalog cleanup follows provider availability rather than PR or merge state; the administrator defines provider retention; the same per-site lock coordinates pre-publish, production publish and unregister. See the [specification](../specification.md#post-mvp-pre-publish-preview-contract) for precise boundaries and exceptions.

## Deferred

- Fork-origin PR previews need a separate approval and isolation model.
- Preview-only viewer access is not modeled. Previews use the same operator-managed edge or network boundary configured for the distribution; catalog membership, PR state, and an unguessable SHA do not make preview content private. See [Specification §18](../specification.md#18-viewer-access-and-identity).
- Exact-time revocation is a separate future capability, not an accidental lifecycle promise.
