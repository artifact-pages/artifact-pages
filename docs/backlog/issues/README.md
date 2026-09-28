# Product issues

[Backlog overview and shared status legend](../README.md). This track is for independently actionable product problems; unresolved design questions and unrun contract proofs have their own backlog tracks. Remove completed issue files from this backlog after verifying their acceptance criteria; Git history retains the completed records.

Each issue file records one independently actionable problem. New issues start as `Open`; keep this index and the [parent backlog summary](../README.md) in sync. Use [_template.md](_template.md) for new issues.

## Status

| Value | Meaning |
| --- | --- |
| `Open` | Ready to investigate or implement. |
| `In progress` | Work is underway. |
| `Blocked` | Progress needs a decision or dependency. |
| `Done` | Acceptance criteria have been verified. |
| `Won't fix` | The team has decided not to pursue the issue; record why in the issue. |

## Priority

| Value | Meaning |
| --- | --- |
| `P0` | Blocks the core experience for most users; address immediately. |
| `P1` | Materially disrupts a core reading/publishing/deployment workflow or exposes private control state. |
| `P2` | A meaningful correctness, reliability, navigation, or usability problem outside P1's impact. |
| `P3` | Localized polish or a lower-impact improvement. |

Priority describes user impact, not implementation effort. Issues 001–012 are completed historical browser/interaction work. ISSUE-013 is a proposed site-description improvement. ISSUE-014–037 record the 24 confirmed findings from the full-codebase review on 2026-09-28 at `50c327d886c71fc5e0d086a5967b90cd9038e01e` (4 P1, 20 P2).

Each review issue contains its own reproduction and source pointers. Supplementary captures/scripts remain ignored in `.local/reviews/2026-09-28/`; they are not the only evidence or a dependency of this committed backlog. Local CLI/HTTP/browser reproductions and provider-source inconsistencies are labeled separately from live-provider proof. Existing passing suites did not cover these regressions.

The review adds 23 Open issues and one Blocked issue; with ISSUE-013 this track has 24 Open and 1 Blocked. [TD3](../technical-design/TD3-preview-origin-delivery.md) owns the unresolved preview-origin decision for ISSUE-026. The unconfirmed AWS absent-object 403/404 concern belongs to [T15](../verification/T15-provider-delivery.md), not to another confirmed issue.

## Repair order

Work one issue at a time: mark it In progress, reproduce it, add a regression, implement, verify its acceptance criteria, then commit that concern and move on. Keep the parent summary synchronized. Retain completed records in Git history under the existing removal policy; do not remove an issue before its criteria are verified.

| Order | Items, in order | Outcome |
| --- | --- | --- |
| 1 | ISSUE-014 → 015 → 016 → 017 | Close all four P1 exposure, key, deployment and discovery failures first. |
| 2 | ISSUE-018 → 020 → 019 → 021 | Empty-state convergence, unregister recovery, browser cache and bounded lock acquisition. |
| 3 | ISSUE-022 → 023 → 024 → 025 → 027 → 028 | Preview identity, rendering closure and navigation. |
| 4 | ISSUE-029 → 030 → 031 → 032 → 033 → 034 → 035 | Heading/link parity, Unicode/provenance, remote config and local development. |
| 5 | ISSUE-036 → 037 | Release-file integrity and reference artifact CSP. |
| Dependency | TD3 → ISSUE-026 | Settle delivery before fixing the provider-style module failure. Do not block independent repairs or silently relax isolation; resume this issue once the design is accepted. |
| Later product improvement | ISSUE-013 | Site-description schema/UI work is outside this repair pass and is not a current release gate. |

This is the default repair queue, not authorization to operate cloud accounts or release publicly. Complete review defects before claiming readiness, or record an explicit approved deferral with impact. Actual provider and clean-consumer proofs remain separate gates in the [release order](../README.md#first-public-release-order).

## Issue index

| Issue | Status | Priority | Area | Summary |
| --- | --- | --- | --- | --- |
| [ISSUE-013 — Site descriptions](ISSUE-013-site-description.md) | Open | P2 | Site discovery and site selection | Explain each site's purpose before visitors open it. |
| [ISSUE-014 — Reject overlapping local source and publish output](ISSUE-014-local-source-target-overlap.md) | Open | P1 | Site publish / local storage | Review 01: Confirmed defect; reproduction and acceptance criteria in the issue. |
| [ISSUE-015 — Preserve raw filenames in preview object keys](ISSUE-015-preview-raw-object-keys.md) | Open | P1 | Preview publish / storage codec | Review 02: Confirmed defect; reproduction and acceptance criteria in the issue. |
| [ISSUE-016 — Allow and serve the official web bundle's notice files on AWS](ISSUE-016-aws-web-bundle-notice-files.md) | Open | P1 | App deploy / AWS reference delivery | Review 03: Confirmed defect; reproduction and acceptance criteria in the issue. |
| [ISSUE-017 — Keep site discovery usable when one site's metadata is unavailable](ISSUE-017-site-discovery-failure-isolation.md) | Open | P1 | Site discovery / registered-site onboarding | Review 04: Confirmed defect; reproduction and acceptance criteria in the issue. |
| [ISSUE-018 — Publish an empty site after its last document is removed](ISSUE-018-empty-site-reconciliation.md) | Open | P2 | Site publish / desired-state reconciliation | Review 05: Confirmed defect; reproduction and acceptance criteria in the issue. |
| [ISSUE-019 — Revalidate fixed-name application assets on upgrade and rollback](ISSUE-019-unhashed-app-asset-cache.md) | Open | P2 | App deploy / browser and edge cache | Review 06: Confirmed defect; reproduction and acceptance criteria in the issue. |
| [ISSUE-020 — Retain catalog invalidation when retrying an unregister](ISSUE-020-unregister-invalidation-retry.md) | Open | P2 | Registry publish / unregister recovery | Review 07: Confirmed defect; reproduction and acceptance criteria in the issue. |
| [ISSUE-021 — Enforce the lock wait limit during conditional-write conflicts](ISSUE-021-lock-cas-wait-limit.md) | Open | P2 | Publisher coordination / locks | Review 08: Confirmed defect; reproduction and acceptance criteria in the issue. |
| [ISSUE-022 — Allow same-head preview retries when only the default branch advances](ISSUE-022-preview-default-head-retry.md) | Open | P2 | Preview revision identity / idempotency | Review 09: Confirmed defect; reproduction and acceptance criteria in the issue. |
| [ISSUE-023 — Recognize static JavaScript module dependencies without matching ordinary strings](ISSUE-023-preview-module-dependency-parsing.md) | Open | P2 | Preview resource closure / JavaScript | Review 10: Confirmed defect; reproduction and acceptance criteria in the issue. |
| [ISSUE-024 — Include static imports from inline HTML module scripts](ISSUE-024-preview-inline-module-resources.md) | Open | P2 | Preview resource closure / HTML | Review 11: Confirmed defect; reproduction and acceptance criteria in the issue. |
| [ISSUE-025 — Bundle local images rendered from Markdown raw HTML](ISSUE-025-preview-markdown-html-resources.md) | Open | P2 | Preview resource closure / Markdown | Review 12: Confirmed defect; reproduction and acceptance criteria in the issue. |
| [ISSUE-026 — Load preview modules without weakening the frame boundary](ISSUE-026-preview-provider-module-loading.md) | Blocked | P2 | Preview reader / provider delivery | Review 13: Blocked on TD3's preview-delivery decision. |
| [ISSUE-027 — Do not swallow links to raw resources in HTML previews](ISSUE-027-preview-resource-link-navigation.md) | Open | P2 | Preview reader / link navigation | Review 14: Confirmed defect; reproduction and acceptance criteria in the issue. |
| [ISSUE-028 — Apply HTML preview fragments to the rendered frame](ISSUE-028-preview-html-fragment-navigation.md) | Open | P2 | Preview reader / heading navigation | Review 15: Confirmed defect; reproduction and acceptance criteria in the issue. |
| [ISSUE-029 — Generate the same Markdown heading IDs in the builder and reader](ISSUE-029-markdown-heading-id-parity.md) | Open | P2 | Markdown index / Contents / heading search | Review 16: Confirmed defect; reproduction and acceptance criteria in the issue. |
| [ISSUE-030 — Resolve fragments when linking to another Markdown document](ISSUE-030-markdown-cross-document-fragments.md) | Open | P2 | Markdown reader / document navigation | Review 17: Confirmed defect; reproduction and acceptance criteria in the issue. |
| [ISSUE-031 — Keep Unicode filenames readable in fallback artifact titles](ISSUE-031-unicode-filename-title.md) | Open | P2 | Indexer / artifact display title | Review 18: Confirmed defect; reproduction and acceptance criteria in the issue. |
| [ISSUE-032 — Do not assign a resource committer to a document without Git history](ISSUE-032-untracked-document-committer.md) | Open | P2 | Indexer / Git provenance | Review 19: Confirmed defect; reproduction and acceptance criteria in the issue. |
| [ISSUE-033 — Keep Git metadata stable when building from a repository subdirectory](ISSUE-033-nested-cwd-git-metadata.md) | Open | P2 | Indexer / working-directory resolution | Review 20: Confirmed defect; reproduction and acceptance criteria in the issue. |
| [ISSUE-034 — Accept valid GitHub repository names in remote config locators](ISSUE-034-remote-config-repository-names.md) | Open | P2 | CLI / remote configuration | Review 21: Confirmed defect; reproduction and acceptance criteria in the issue. |
| [ISSUE-035 — Return a client error instead of crashing Vite on malformed URLs](ISSUE-035-vite-malformed-url.md) | Open | P2 | Local development / artifact middleware | Review 22: Confirmed defect; reproduction and acceptance criteria in the issue. |
| [ISSUE-036 — Keep concurrent packaging of one web version from mixing release files](ISSUE-036-concurrent-web-packaging.md) | Open | P2 | Web release / package publication | Review 23: Confirmed defect; reproduction and acceptance criteria in the issue. |
| [ISSUE-037 — Send the specified artifact CSP from reference provider delivery](ISSUE-037-provider-artifact-csp.md) | Open | P2 | HTML artifact / AWS and Cloudflare delivery | Review 24: Confirmed defect; reproduction and acceptance criteria in the issue. |
