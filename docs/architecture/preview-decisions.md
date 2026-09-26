# Preview decision register

Status: **post-MVP design tracking; no preview implementation is implied**

This page tracks what remains to decide or prove for pre-publish previews. The [specification](../specification.md#post-mvp-pre-publish-preview-contract) is authoritative for accepted product behavior; the [publishing contract](preview-publishing-contract.html) is a technical proposal. Keep this register short: move a resolved decision into the specification, record the outcome here, and do not turn each discussion point into a separate product issue. Use [`docs/issues/`](../issues/README.md) for independently actionable implementation defects.

## Status vocabulary

| Status | Meaning |
| --- | --- |
| **Open — product** | A data-model, access-policy, or reader-UX choice needs an explicit product decision. |
| **Proposed — technical** | A concrete implementation direction exists; it can be settled during design/implementation without another product decision unless it changes behavior. |
| **Verify** | The intended behavior is decided, but tests or provider measurements must establish that the design works. |
| **Accepted** | Decided and recorded in the specification. Do not reopen merely because the implementation is pending. |
| **Deferred** | Deliberately outside the initial preview release. |

## Open product decisions

| ID | Decision | Current recommendation | What changes with the choice |
| --- | --- | --- | --- |
| P4 | If a PR closes without a merge and no later main-branch production publish occurs, may its preview remain discoverable until provider removal? | Yes for the initial release; adding a workflow solely for retirement is worse for installation UX. The next ordinary production publish checks every catalog PR group and retires closed ones. | A closed-but-still-readable preview can remain on the list until another publish or provider removal. The alternative requires an extra event workflow or browser-side GitHub lookup. |
| P6 | If source-host PR status cannot be read during `site publish`, should production publication fail too? | [B: publish with warning](preview-publishing-contract.html#cli-experience). Retain unknown PR groups and report preview reconciliation as incomplete. | A strict preflight blocks production on a source-host outage; best-effort cleanup can leave stale discovery until a later publish. |

P4 and P6 are the remaining product-facing preview choices recorded here. Neither blocks continued technical exploration.

## Recently accepted

| ID | Status | Outcome |
| --- | --- | --- |
| P1 | Accepted | Site home provides a quiet link to the dedicated Previews list. It does not display an inline preview list or require a potentially stale count. |
| P2 | Accepted | The hosting provider exclusively owns preview lifetime. The application stores no expiry timestamp, runs no expiry timer, and does not promise exact-time removal. Catalog candidates are checked against provider manifest availability when read. |
| P3 | Accepted | Use [B: header context](../ui/ui-preview-identity-concepts.html#b). Keep the document H1 untouched. When PR provenance is unambiguous, its number is a subtle link to that PR; manual previews have no PR link. No app-managed expiry label or persistent reader strip. |
| P5 | Accepted | Do not require a PR-close or scheduled-cleanup workflow. `artifact-pages site publish` reconciles its site catalog in both local and CI runs: closed PR or missing provider manifest means removal. Commit one site-scoped catalog update after the production projection is committed at origin. GitHub Actions wraps the same CLI operation rather than owning its cleanup logic. Completed revision bytes and fixed URLs remain provider-owned. |

## Technical decisions to settle during implementation

| ID | Status | Item | Proposed direction / exit condition |
| --- | --- | --- | --- |
| T1 | Proposed — technical | Exact catalog and revision-manifest schema and storage keys. | Start from the [candidate projection](preview-publishing-contract.html#objects); freeze only after a local producer/reader round trip, including same-head retry and missing provider objects. Preserve PR provenance for a direct fixed URL without assuming one head SHA can belong to only one PR. |
| T2 | Proposed — technical | CLI flag names, resource-include syntax, Action inputs/outputs and production-publish retirement input. | Keep explicit site selection and the [input/output meanings](preview-publishing-contract.html#inputs); choose spellings with the actual CLI surface. Do not add a reusable workflow contract. |
| T3 | Proposed — technical | Administrator retention configuration and provider mapping. | One provider-owned policy for preview objects; no app cutoff or per-PR duration option. Verify the catalog also disappears after inactivity and no versioned object remains indefinitely. |
| T4 | Verify | Serving routes, caches and access control. | Prove raw misses do not get SPA fallback, direct URLs resolve without catalog membership, absent manifests are hidden on the list, and restricted sites authorize catalog, manifest and every resource before shared-cache delivery. |
| T5 | Verify | Concurrency, idempotency and crash recovery. | Run both unregister/pre-publish orderings, simultaneous group updates, partial uploads, manifest-before-catalog failure, same-head mismatch and retirement retry. See the [proof matrix](preview-publishing-contract.html#proof). |
| T6 | Verify | Snapshot-relative resources and document navigation. | Exercise HTML and Markdown with CSS, JS, images, fonts, changed-document links and unchanged-document links; establish the boundary for dynamic/root-relative URLs. |
| T7 | Verify | Lazy catalog and availability-check cost at multi-site scale. | Confirm opening one site's Previews does not download other sites' catalogs; measure transfer, manifest checks, parse, memory and input-to-paint with many sites. If checking every candidate is too costly, revise the discovery projection without adding app-managed expiry. |
| T8 | Proposed — technical | Retirement and stale references without another workflow. | The CLI's production publish reconciles its current site catalog using source-host PR state and provider-origin manifest availability. No commit-diff or Actions-event dependency is needed. Commit one conditional catalog update after the production projection under the site lock; other catalog writes also prune missing-manifest references. Browser availability checks hide missing candidates between writes. Prove local/CI parity, merged and closed-unmerged PRs, manual groups, and lock/CAS behavior. Source-host lookup failure behavior is tracked in P6. No app-managed expiry clock or standalone cleanup Action. |

## Accepted product contract

The following are not open decisions: a preview belongs to a registered site; automatic PR publication accepts same-repository heads but not forks; a revision is identified by full head SHA; only added/modified HTML or Markdown documents are previewed; deletions are not pages; local resources come from the head snapshot; the production index and normal search stay unchanged; discovery is a site-local mutable catalog with one latest revision per group; direct document links remain revision-specific; group retirement removes discovery rather than deleting old bytes; the administrator defines provider retention; the same per-site lock coordinates pre-publish, production publish and unregister. See the [specification](../specification.md#post-mvp-pre-publish-preview-contract) for precise boundaries and exceptions.

## Deferred

- Fork-origin PR previews need a separate approval and isolation model.
- Preview-only private access is not part of the initial access model; previews inherit the site's policy.
- Exact-time revocation is a separate future capability, not an accidental lifecycle promise.
