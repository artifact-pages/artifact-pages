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

Priority describes user impact, not implementation effort. Issues 001–012 are completed historical browser/interaction work. ISSUE-013 is a proposed site-description improvement. ISSUE-014–037 recorded the 24 confirmed findings from the full-codebase review on 2026-09-28 at `50c327d886c71fc5e0d086a5967b90cd9038e01e` (4 P1, 20 P2). ISSUE-014 through ISSUE-030 have verified acceptance criteria and were removed from the active backlog under the completion policy; their regression and verification records remain in T4, T6, T14, T15, IMP-21, IMP-25, T13, and Git history.

Each review issue contains its own reproduction and source pointers. Supplementary captures/scripts remain ignored in `.local/reviews/2026-09-28/`; they are not the only evidence or a dependency of this committed backlog. Local CLI/HTTP/browser reproductions and provider-source inconsistencies are labeled separately from live-provider proof. Existing passing suites did not cover these regressions.

ISSUE-030's Markdown cross-document fragments passed the 63/63 local Playwright suite with one worker and was removed after verification. ISSUE-031's Unicode filename fallback passed the Go indexer tests and the 64/64 local Playwright suite with one worker, then was removed after verification. ISSUE-032's Git provenance fix passed `go test ./...` and was removed after verification. ISSUE-033's working-directory fix passed the indexer and full Go suites, then was removed after verification. ISSUE-034's remote locator fix passed the full Go suite and was removed after verification. ISSUE-035's malformed Vite URL returned 400 and passed the process-level server regression and production build, then was removed after verification. ISSUE-036's public packaging command passed the deterministic competing-build/archive regression and a real Vite/notices/tar smoke package, then was removed after verification. One review issue remains Open; with ISSUE-013 this track has two Open, zero In progress, and zero Blocked. ISSUE-029 Markdown heading ID parity passed the Go indexer and local browser suite. [TD3](../technical-design/TD3-preview-origin-delivery.md) is settled, and ISSUE-026's local same-origin HTML implementation and emulator regressions are complete. ISSUE-027's raw-resource navigation and ISSUE-028's HTML fragment synchronization passed the local stack and all three emulator profiles. The unconfirmed AWS absent-object 403/404 concern belongs to [T15](../verification/T15-provider-delivery.md), not to another confirmed issue.

## Repair order

Work one issue at a time: mark it In progress, reproduce it, add a regression, implement, verify its acceptance criteria, then commit that concern and move on. Keep the parent summary synchronized. Retain completed records in Git history under the existing removal policy; do not remove an issue before its criteria are verified.

| Order | Items, in order | Outcome |
| --- | --- | --- |
| 1 | ISSUE-037 | Reference delivery headers. |
| Later product improvement | ISSUE-013 | Site-description schema/UI work is outside this repair pass and is not a current release gate. |

This is the default repair queue, not authorization to operate cloud accounts or release publicly. Complete review defects before claiming readiness, or record an explicit approved deferral with impact. Actual provider and clean-consumer proofs remain separate gates in the [release order](../README.md#first-public-release-order).

## Issue index

| Issue | Status | Priority | Area | Summary |
| --- | --- | --- | --- | --- |
| [ISSUE-013 — Site descriptions](ISSUE-013-site-description.md) | Open | P2 | Site discovery and site selection | Explain each site's purpose before visitors open it. |
| [ISSUE-037 — Send the specified artifact CSP from reference provider delivery](ISSUE-037-provider-artifact-csp.md) | Open | P2 | HTML artifact / AWS and Cloudflare delivery | Review 24: Confirmed defect; reproduction and acceptance criteria in the issue. |
