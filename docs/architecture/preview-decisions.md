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
| P1 | Should the site home expose a compact Previews entry, in addition to the dedicated view and palette tab? | Yes: a quiet link/count, without placing previews in the production tree or search. | Discoverability and the amount of preview state shown during normal reading. The [specification](../specification.md#post-mvp-pre-publish-preview-contract) currently says the home *may* link to previews. |
| P2 | Is expiry a product-level cutoff with eventual raw-object deletion, or must every raw preview URL be denied at the exact cutoff instant? | Product cutoff plus eventual deletion. An exact raw cutoff requires a separate serving-boundary mechanism; storage lifecycle alone cannot promise it. | Access policy, infrastructure complexity, and what the retention setting promises. The [technical contract](preview-publishing-contract.html#expiry) currently proposes the former; it should not be presented as approved policy yet. |
| P3 | What minimal preview identity should the reader see on a preview page and in the list? | Show `Preview`, PR number or abbreviated head SHA, and expiry; use document H1 as the page title. Avoid a second mutable title field initially. | Reader orientation and whether the catalog needs extra display metadata. The [UI study](../ui/ui-preview-discovery-concepts.html) shows examples, but not a final reader state. |

These three can be answered together. None blocks continued technical exploration; P2 must be resolved before promising retention or access guarantees to users.

## Technical decisions to settle during implementation

| ID | Status | Item | Proposed direction / exit condition |
| --- | --- | --- | --- |
| T1 | Proposed — technical | Exact catalog and revision-manifest schema and storage keys. | Start from the [candidate projection](preview-publishing-contract.html#objects); freeze only after a local producer/reader round trip, including same-head retry and expired entries. |
| T2 | Proposed — technical | CLI flag names, resource-include syntax, Action inputs/outputs and group-retirement invocation. | Keep explicit site selection and the [input/output meanings](preview-publishing-contract.html#inputs); choose spellings with the actual CLI surface. Do not add a reusable workflow contract. |
| T3 | Proposed — technical | Administrator retention configuration and provider mapping. | One administrator-owned setting; prove its mapping to manifest cutoff, catalog lifecycle and provider object expiration without making it a per-PR publisher option. |
| T4 | Verify | Serving routes, caches and access control. | Prove raw misses do not get SPA fallback, direct URLs resolve without catalog membership, and restricted sites authorize catalog, manifest and every resource before shared-cache delivery. |
| T5 | Verify | Concurrency, idempotency and crash recovery. | Run both unregister/pre-publish orderings, simultaneous group updates, partial uploads, manifest-before-catalog failure, same-head mismatch and retirement retry. See the [proof matrix](preview-publishing-contract.html#proof). |
| T6 | Verify | Snapshot-relative resources and document navigation. | Exercise HTML and Markdown with CSS, JS, images, fonts, changed-document links and unchanged-document links; establish the boundary for dynamic/root-relative URLs. |
| T7 | Verify | Lazy catalog cost at multi-site scale. | Confirm opening one site's Previews does not download other sites' catalogs; measure transfer, parse, memory and input-to-paint with many sites. |

## Accepted product contract

The following are not open decisions: a preview belongs to a registered site; automatic PR publication accepts same-repository heads but not forks; a revision is identified by full head SHA; only added/modified HTML or Markdown documents are previewed; deletions are not pages; local resources come from the head snapshot; the production index and normal search stay unchanged; discovery is a site-local mutable catalog with one latest revision per group; direct document links remain revision-specific; group retirement removes discovery rather than deleting old bytes; the administrator defines retention; the same per-site lock coordinates pre-publish, production publish and unregister. See the [specification](../specification.md#post-mvp-pre-publish-preview-contract) for precise boundaries and exceptions.

## Deferred

- Fork-origin PR previews need a separate approval and isolation model.
- Preview-only private access is not part of the initial access model; previews inherit the site's policy.
- Exact-time revocation, if rejected under P2, would be a separate future capability rather than an accidental lifecycle promise.
