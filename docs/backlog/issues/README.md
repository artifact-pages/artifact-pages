# Product issues

Statuses follow the [shared backlog legend](../../../AGENTS.md#backlog-and-issue-tracking). This track is for independently actionable product problems; unresolved design questions and unrun contract proofs have their own backlog tracks. Remove completed issue files from this backlog after verifying their acceptance criteria; Git history retains the completed records.

Each issue file records one independently actionable problem. New issues start as `Open`; keep this index in sync. Use [_template.md](_template.md) for new issues.

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

Priority describes user impact, not implementation effort. Issues 001–012 are completed historical browser/interaction work. ISSUE-013's site-description hierarchy was reviewed, implemented in the site picker and site search, and verified on narrow screens; its acceptance record was removed from the active backlog on 2026-09-29 under the completion policy. Git history retains the issue record. ISSUE-014–037 recorded the 24 confirmed findings from the full-codebase review on 2026-09-28 at `50c327d886c71fc5e0d086a5967b90cd9038e01e` (4 P1, 20 P2). ISSUE-014 through ISSUE-037 have verified acceptance criteria and were removed from the active backlog under the completion policy; their regression and verification records remain in T4, T6, T14, T15, IMP-21, IMP-25, T13, and Git history.

Each review issue contains its own reproduction and source pointers. Supplementary captures/scripts remain ignored in `.local/reviews/2026-09-28/`; they are not the only evidence or a dependency of this committed backlog. Local CLI/HTTP/browser reproductions and provider-source inconsistencies are labeled separately from live-provider proof. Existing passing suites did not cover these regressions.

ISSUE-030's Markdown cross-document fragments passed the 63/63 local Playwright suite with one worker and was removed after verification. ISSUE-031's Unicode filename fallback passed the Go indexer tests and the 64/64 local Playwright suite with one worker, then was removed after verification. ISSUE-032's Git provenance fix passed `go test ./...` and was removed after verification. ISSUE-033's working-directory fix passed the indexer and full Go suites, then was removed after verification. ISSUE-034's remote locator fix passed the full Go suite and was removed after verification. ISSUE-035's malformed Vite URL returned 400 and passed the process-level server regression and production build, then was removed after verification. ISSUE-036's public packaging command passed the deterministic competing-build/archive regression and a real Vite/notices/tar smoke package, then was removed after verification. ISSUE-037's artifact CSP fix passed `npm run test:provider-delivery` (22/22), `CI=1 npm run test:e2e` (66 cases successful; two unrelated preview-navigation tests passed on retry), Terraform 1.9.8 format and isolated AWS/Cloudflare validation; it was removed after local acceptance was verified. This track now has 1 Open, 0 In progress, 0 Blocked, and 0 Done issues. Live provider headers remain in T15. ISSUE-029 Markdown heading ID parity passed the Go indexer and local browser suite. [TD3](../technical-design/TD3-preview-origin-delivery.md) is settled, and ISSUE-026's local same-origin HTML implementation and emulator regressions are complete. ISSUE-027's raw-resource navigation and ISSUE-028's HTML fragment synchronization passed the local stack and all three emulator profiles. The unconfirmed AWS absent-object 403/404 concern belongs to [T15](../verification/T15-provider-delivery.md), not to another confirmed issue.

ISSUE-038–047 come from the 2026-10-01 beginner UX review in the Codex in-app browser at `http://127.0.0.1:4179/`: one Guide site with four HTML documents, at normal width and 390×844. No implementation or design documents informed that review. Each issue preserves observable evidence, scope limitations, and acceptance criteria; discovery and reading improvements are explicitly distinguished from broken behavior. The review's search-entry observations F02/F07 are combined in ISSUE-039. Local screenshots and the full report remain ignored under `.local/ux-review-2026-10-01/`; issue reproduction does not depend on those files. Missing fixtures, real-device IME, and broader provider proofs are not new product issues.

## Repair order

Work one issue at a time: mark it In progress, reproduce it, add a regression, implement, verify its acceptance criteria, then commit that concern and move on. Keep the parent summary synchronized. Retain completed records in Git history under the existing removal policy; do not remove an issue before its criteria are verified.

ISSUE-038–047 were repaired individually by Luna max agents and reviewed by separate Luna max agents. The final local e2e suite passed 77/77 on 2026-10-01. Their verified completion records were removed under the backlog policy and remain in Git history through `670dd87`. The initial UX review used the Codex in-app browser; final follow-up visual checks were limited to automated browser tests because the in-app browser was unavailable. ISSUE-048, the owner-selected document-first palette direction, was implemented and verified on 2026-10-07; its record stays in the issue file. ISSUE-049–058 record a second beginner review on 2026-10-01 in Chrome (Claude in Chrome) at about 1568×568 with one site and four HTML documents; narrow widths were not exercised. Four of them follow up on residual behavior after ISSUE-039, ISSUE-046, ISSUE-047, and ISSUE-042, and each names the related issue. Work ISSUE-049 and ISSUE-050 first because they share the search-entry concern.

This is the default repair queue, not authorization to operate cloud accounts or release publicly. Complete review defects before claiming readiness, or record an explicit approved deferral with impact. Actual provider and clean-consumer proofs remain separate gates in the [release execution order](../release-readiness.md).

## Issue index

| Issue | Status | Priority | Problem |
| --- | --- | --- | --- |
| [ISSUE-048](ISSUE-048-document-first-palette.md) | Done | P2 | Document discovery is obscured by mixed palette candidates. |
| [ISSUE-049](ISSUE-049-home-search-arrow-keys.md) | Done | P2 | The down arrow does not move from site-home search into its results. |
| [ISSUE-050](ISSUE-050-search-field-shortcut-badges.md) | Done | P2 | ⌘K badges on the search fields suggest shortcuts that open the palette instead. |
| [ISSUE-051](ISSUE-051-empty-preview-entry-control.md) | Done | P3 | The empty-preview entry looks clickable, does nothing, and previews are unexplained. |
| [ISSUE-052](ISSUE-052-site-switcher-count.md) | Done | P3 | The number beside the site switcher is unlabeled. |
| [ISSUE-053](ISSUE-053-breadcrumb-menus-duplicate.md) | Done | P3 | Folder and document breadcrumb menus show the same content. |
| [ISSUE-054](ISSUE-054-contents-keep-reading-label.md) | Done | P3 | The panels' "Keep reading" action is unclear. |
| [ISSUE-055](ISSUE-055-palette-missing-artifact-commands.md) | Done | P3 | Pin and Details are missing from palette commands. |
| [ISSUE-056](ISSUE-056-sidebar-filter-match-reason.md) | Done | P3 | Sidebar filter results matched only by path do not show why they matched. |
| [ISSUE-057](ISSUE-057-search-typo-tolerance.md) | Won't fix | P3 | Small typos such as swapped letters find no documents. |
| [ISSUE-058](ISSUE-058-library-palette-heading-hint.md) | Done | P3 | The site-list palette footer advertises heading search that is unavailable there. |
| [ISSUE-059](ISSUE-059-unregistered-preview-route.md) | Done | P2 | Unregistered preview routes look like registered sites with no previews. |
| [ISSUE-060](ISSUE-060-flaky-preview-navigation-tests.md) | Done | P2 | Preview-navigation e2e tests fail intermittently under parallel runs. |
| [ISSUE-061](ISSUE-061-early-preview-click-escapes-reader.md) | Open | P3 | A click right after a preview loads can open the raw file outside the reader. |
| [ISSUE-062](ISSUE-062-config-set-default-help-saved.md) | Done | P2 | `config set-default --help` saves "--help" as the user's default config instead of printing help. |
| [ISSUE-063](ISSUE-063-actions-missing-fulltext.md) | Done | P1 | The site-publish Action could not pass `--fulltext`, so publishing through it withdrew page text search. |
| [ISSUE-064](ISSUE-064-r2-uses-shared-aws-config.md) | Done | P2 | The Cloudflare R2 path loads the shared AWS configuration, so AWS profiles and environment variables can affect R2 publishing. |
| [ISSUE-065](ISSUE-065-registry-dry-run-says-unchanged.md) | Open | P3 | `registry register --dry-run` text says "unchanged" while planning to create the registry. |
| [ISSUE-067](ISSUE-067-single-cloudflare-publisher-token.md) | Open | P3 | Cloudflare publishing needs three secrets that one token can provide. |
| [ISSUE-068](ISSUE-068-bare-apply-commands-print-help.md) | Done | P1 | Bare `app deploy`, `registry register|unregister`, `site publish` and `preview publish` printed help and exited 0 instead of running. |
| [ISSUE-069](ISSUE-069-cloudflare-edge-rewrites-artifact-html.md) | Done | P1 | Cloudflare edge features (email obfuscation and similar) rewrite delivered artifact HTML; the module must disable them for the hostname. |
| [ISSUE-070](ISSUE-070-pr-dry-run-source-ref-noise.md) | Open | P3 | PR dry-run of site publish always reports index.json updates because `source.ref` follows the checkout branch. |
| [ISSUE-071](ISSUE-071-remote-config-auth-error-unclear.md) | Done | P2 | A private deployment config the token cannot read fails with an unactionable HTTP status. |
| [ISSUE-072](ISSUE-072-modified-click-tab-and-route-fetch-e2e-flaky.md) | In progress | P2 | Modified-click new-tab and route.fetch e2e tests fail intermittently under parallel load. |
| [ISSUE-073](ISSUE-073-palette-enter-uses-stale-selection.md) | Done | P2 | Pressing Enter right after typing in the command palette can do nothing or open the wrong page (regression from #34). |

ISSUE-013's verified completion record is retained in Git history.
