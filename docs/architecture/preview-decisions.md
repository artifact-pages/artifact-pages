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
| P3 | How should a reader recognize which preview revision a page and list entry belong to? | Compare [A: list only, B: header context, C: reader strip](../ui/ui-preview-identity-concepts.html). Keep the document H1 as its title and show no application-managed expiry label. | Prevents confusion between a preview and its published page. This is about provenance in the UI, not renaming the document. Await visual review before accepting a placement. |
| P4 | If the caller's PR-close event is missed while the preview bundle still exists, may the PR stay in discovery until the provider removes it? | Yes for the initial release. Recommend the close-event retirement Action and permit retries; do not make the core query GitHub PR state. | Avoids another GitHub-coupled control plane, at the cost of a temporarily stale but still readable preview after a missed event. Provider-missing revisions are a separate case handled by catalog reconciliation. |

P3 and P4 are the remaining product-facing preview choices recorded here. Neither blocks continued technical exploration.

## Recently accepted

| ID | Status | Outcome |
| --- | --- | --- |
| P1 | Accepted | Site home provides a quiet link to the dedicated Previews list. It does not display an inline preview list or require a potentially stale count. |
| P2 | Accepted | The hosting provider exclusively owns preview lifetime. The application stores no expiry timestamp, runs no expiry timer, and does not promise exact-time removal. Catalog candidates are checked against provider manifest availability when read. |

## Technical decisions to settle during implementation

| ID | Status | Item | Proposed direction / exit condition |
| --- | --- | --- | --- |
| T1 | Proposed — technical | Exact catalog and revision-manifest schema and storage keys. | Start from the [candidate projection](preview-publishing-contract.html#objects); freeze only after a local producer/reader round trip, including same-head retry and missing provider objects. |
| T2 | Proposed — technical | CLI flag names, resource-include syntax, Action inputs/outputs and group-retirement invocation. | Keep explicit site selection and the [input/output meanings](preview-publishing-contract.html#inputs); choose spellings with the actual CLI surface. Do not add a reusable workflow contract. |
| T3 | Proposed — technical | Administrator retention configuration and provider mapping. | One provider-owned policy for preview objects; no app cutoff or per-PR duration option. Verify the catalog also disappears after inactivity and no versioned object remains indefinitely. |
| T4 | Verify | Serving routes, caches and access control. | Prove raw misses do not get SPA fallback, direct URLs resolve without catalog membership, absent manifests are hidden on the list, and restricted sites authorize catalog, manifest and every resource before shared-cache delivery. |
| T5 | Verify | Concurrency, idempotency and crash recovery. | Run both unregister/pre-publish orderings, simultaneous group updates, partial uploads, manifest-before-catalog failure, same-head mismatch and retirement retry. See the [proof matrix](preview-publishing-contract.html#proof). |
| T6 | Verify | Snapshot-relative resources and document navigation. | Exercise HTML and Markdown with CSS, JS, images, fonts, changed-document links and unchanged-document links; establish the boundary for dynamic/root-relative URLs. |
| T7 | Verify | Lazy catalog and availability-check cost at multi-site scale. | Confirm opening one site's Previews does not download other sites' catalogs; measure transfer, manifest checks, parse, memory and input-to-paint with many sites. If checking every candidate is too costly, revise the discovery projection without adding app-managed expiry. |
| T8 | Proposed — technical | Stale catalog references after provider removal. | Retire a PR group on close/merge, reconcile missing-manifest references on every catalog write, and provide a standalone site-scoped cleanup Action for user-scheduled or manual runs. Browser availability checks hide stale links between runs. The caller chooses cleanup timing; the core never computes expiry dates. Verify lock/CAS behavior and catalog cleanup after an open PR or manual preview disappears at the provider. |

## Accepted product contract

The following are not open decisions: a preview belongs to a registered site; automatic PR publication accepts same-repository heads but not forks; a revision is identified by full head SHA; only added/modified HTML or Markdown documents are previewed; deletions are not pages; local resources come from the head snapshot; the production index and normal search stay unchanged; discovery is a site-local mutable catalog with one latest revision per group; direct document links remain revision-specific; group retirement removes discovery rather than deleting old bytes; the administrator defines provider retention; the same per-site lock coordinates pre-publish, production publish and unregister. See the [specification](../specification.md#post-mvp-pre-publish-preview-contract) for precise boundaries and exceptions.

## Deferred

- Fork-origin PR previews need a separate approval and isolation model.
- Preview-only private access is not part of the initial access model; previews inherit the site's policy.
- Exact-time revocation is a separate future capability, not an accidental lifecycle promise.
