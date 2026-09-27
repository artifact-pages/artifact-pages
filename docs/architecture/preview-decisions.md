# Preview decision register

Status: **post-MVP design tracking; no preview implementation is implied**

This page records product decisions for pre-publish previews. The [specification](../specification.md#post-mvp-pre-publish-preview-contract) is authoritative for accepted behavior; the [publishing contract](preview-publishing-contract.html) is a technical proposal. Track unresolved technical design and unrun verification in the [backlog](../backlog/README.md), separately from [product issues](../backlog/issues/README.md). Keep this register short: move a resolved product decision into the specification and record its outcome here.

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

## Unfinished work

The [backlog](../backlog/README.md) is the status source for the three technical-design items and five verification items associated with this contract. Keep their status and evidence there; this register records only product decisions.

## Accepted product contract

The following are not open decisions: a preview belongs to a registered site; automatic PR publication accepts same-repository heads but not forks; a revision is identified by full head SHA; only added/modified HTML or Markdown documents are previewed; deletions are not pages; local resources come from the head snapshot; the production index and normal search stay unchanged; discovery is a site-local mutable catalog with one latest revision per group; direct document links remain revision-specific; catalog cleanup follows provider availability rather than PR or merge state; the administrator defines provider retention; the same per-site lock coordinates pre-publish, production publish and unregister. See the [specification](../specification.md#post-mvp-pre-publish-preview-contract) for precise boundaries and exceptions.

## Deferred

- Fork-origin PR previews need a separate approval and isolation model.
- Preview-only private access is not part of the initial access model; previews inherit the site's policy.
- Exact-time revocation is a separate future capability, not an accidental lifecycle promise.
