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

ISSUE-030's Markdown cross-document fragments passed the 63/63 local Playwright suite with one worker and was removed after verification. ISSUE-031's Unicode filename fallback passed the Go indexer tests and the 64/64 local Playwright suite with one worker, then was removed after verification. ISSUE-032's Git provenance fix passed `go test ./...` and was removed after verification. ISSUE-033's working-directory fix passed the indexer and full Go suites, then was removed after verification. ISSUE-034's remote locator fix passed the full Go suite and was removed after verification. ISSUE-035's malformed Vite URL returned 400 and passed the process-level server regression and production build, then was removed after verification. ISSUE-036's public packaging command passed the deterministic competing-build/archive regression and a real Vite/notices/tar smoke package, then was removed after verification. ISSUE-037's artifact CSP fix passed `npm run test:provider-delivery` (22/22), `CI=1 npm run test:e2e` (66 cases successful; two unrelated preview-navigation tests passed on retry), Terraform 1.9.8 format and isolated AWS/Cloudflare validation; it was removed after local acceptance was verified. Live provider headers remain in T15. ISSUE-029 Markdown heading ID parity passed the Go indexer and local browser suite. [TD3](../technical-design/TD3-preview-origin-delivery.md) is settled, and ISSUE-026's local same-origin HTML implementation and emulator regressions are complete. ISSUE-027's raw-resource navigation and ISSUE-028's HTML fragment synchronization passed the local stack and all three emulator profiles. The unconfirmed AWS absent-object 403/404 concern belongs to [T15](../verification/T15-provider-delivery.md), not to another confirmed issue.

ISSUE-038–047 come from the 2026-10-01 beginner UX review in the Codex in-app browser at `http://127.0.0.1:4179/`: one Guide site with four HTML documents, at normal width and 390×844. No implementation or design documents informed that review. Each issue preserves observable evidence, scope limitations, and acceptance criteria; discovery and reading improvements are explicitly distinguished from broken behavior. The review's search-entry observations F02/F07 are combined in ISSUE-039. Local screenshots and the full report remain ignored under `.local/ux-review-2026-10-01/`; issue reproduction does not depend on those files. Missing fixtures, real-device IME, and broader provider proofs are not new product issues.

ISSUE-075–086 come from the 2026-10-11 dogfooding of `https://artifact-pages.dev` (the guide and architecture sites: 26 published pages, all HTML artifacts under `en/` and `ja/`) and a competitive review of documentation readers. Findings were checked against the current source before filing; claims not reproduced are labeled as hypotheses. Caveats: narrow-screen behavior was exercised in a 390 px iframe embedding the real app, not on a device; heading-anchor jumps could not be verified because the test tab was in the background, so no issue is filed for them; competitor search dialogs could not be opened, so no competitor search behavior is claimed; Mermaid was not tested because the sampled sites contain no Markdown. Content findings (heading ids, the CLI version in Getting started, wide diagrams) belong to the `artifact-pages/docs` repository. The ordering and description questions were decided in [TD19](../technical-design/TD19-navigation-metadata-in-the-site-index.md) (follow GitHub's file browser; no new metadata). The reports are kept outside the repository; each issue records its own evidence.

ISSUE-089–098 come from the public-launch review of 2026-10-13 at `04783fb3`. It covered the monorepo source and tests, the GitHub settings of the nine organization repositories, and the production Guide in a desktop browser and at 390 px. The full local e2e suite was not rerun. Production HTTP fetches by a non-browser client were refused with Cloudflare error 1010, so CDN cache and CSP headers were not re-measured. Other findings went elsewhere: repository protection, Dependabot alerts and security updates, secret scanning, and the production health check and ownership of CI, release and publish failure notifications (OPS-006) are workspace ops items (OPS-005 and OPS-006). External adoption stays in [T16](../verification/T16-external-adoption.md) and the docs repository's DOC-14. Immutable releases and Marketplace stay in [IMP-46](../implementation/IMP-46-action-marketplace-release.md). Operator recovery is [IMP-80](../implementation/IMP-80-operator-recovery-runbook.md), and measurements are [T24](../verification/T24-pre-launch-browser-and-keyboard-matrix.md) to [T27](../verification/T27-launch-hosting-cost-model.md). The same-origin trusted-HTML model, the ISSUE-083 soft 404 and the accepted first-load wait are recorded boundaries and are not reopened. Operator-facing trust boundaries (a private repository is not a private site, source-directory hygiene, browser storage, preview withdrawal), the tested component version set, and the Cloudflare-first and AWS scope belong to the docs repository and are filed there in the docs phase. Signing and attestation are a later candidate after the first non-pre-release.

ISSUE-101–106 come from the hands-on project review of 2026-10-15 at `86841bb1` and production web 0.3.2. They cover bounded loading, retry, modal focus, accessible search selection, truthful freshness labels and known-HTML failure guidance. Each issue contains its reproduction, observed/source-only limits and acceptance criteria; supplementary workspace captures are not required to understand it. Existing scale/cache issues (093–095), verification work (T24–T27), and security/operations work (OPS-005/006) remain the owning items rather than being duplicated.

**Scope decision (owner, 2026-10-15):** public-facing documentation content, information architecture, provider/adoption prose and the review's A/B/C entry-page concepts are excluded from this triage. The owner will reconsider documentation from its structure together at the very end. Existing public-docs tickets are left unchanged. The product's technical backlog in this directory, reader accessibility, source metadata, measurements and operational items remain in scope.

## Repair order

Work one issue at a time: mark it In progress, reproduce it, add a regression, implement, verify its acceptance criteria, then commit that concern and move on. Keep the parent summary synchronized. Retain completed records in Git history under the existing removal policy; do not remove an issue before its criteria are verified.

ISSUE-038–047 were repaired individually by Luna max agents and reviewed by separate Luna max agents. The final local e2e suite passed 77/77 on 2026-10-01. Their verified completion records were removed under the backlog policy and remain in Git history through `670dd87`. The initial UX review used the Codex in-app browser; final follow-up visual checks were limited to automated browser tests because the in-app browser was unavailable. ISSUE-048, the owner-selected document-first palette direction, was implemented and verified on 2026-10-07; its record stays in the issue file. ISSUE-049–058 record a second beginner review on 2026-10-01 in Chrome (Claude in Chrome) at about 1568×568 with one site and four HTML documents; narrow widths were not exercised. Four of them follow up on residual behavior after ISSUE-039, ISSUE-046, ISSUE-047, and ISSUE-042, and each names the related issue. Work ISSUE-049 and ISSUE-050 first because they share the search-entry concern.

This is the default repair queue, not authorization to operate cloud accounts or release publicly. Complete review defects before claiming readiness, or record an explicit approved deferral with impact. Actual provider and clean-consumer proofs remain separate gates in the [release execution order](../release-readiness.md).

## Public launch order (2026-10-13)

1. Before anything else: OPS-005 (owner), [ISSUE-089](ISSUE-089-publisher-race-test-backend-and-race-ci.md), [ISSUE-090](ISSUE-090-npm-advisories-and-no-npm-monitoring.md), [ISSUE-096](ISSUE-096-no-security-policy-or-contributing.md).
2. Robustness: [ISSUE-091](ISSUE-091-malformed-index-rows-crash-render.md), [ISSUE-092](ISSUE-092-slow-site-metadata-blocks-site-list.md), then reader recovery [ISSUE-101](ISSUE-101-registry-and-site-index-loads-have-no-deadline.md)/[ISSUE-102](ISSUE-102-load-errors-offer-no-retry-action.md), accessibility [ISSUE-103](ISSUE-103-command-palette-modal-focus-escapes.md)/[ISSUE-104](ISSUE-104-search-selection-is-not-associated-with-input.md), and freshness [ISSUE-105](ISSUE-105-site-picker-updated-date-stays-stale.md).
3. First readers: [ISSUE-097](ISSUE-097-stale-first-reader-documents.md), [IMP-80](../implementation/IMP-80-operator-recovery-runbook.md), then the cold-start trial and [T16](../verification/T16-external-adoption.md). Public-facing docs work is excluded from this repair queue and deferred to the final structural rethink (owner, 2026-10-15).
   Owner decision (2026-10-14, given when the cold-start trial A triage was approved): Terraform Registry publication ([IMP-38](../implementation/IMP-38-terraform-registry-publication.md)) happens before the public launch, because the documented Registry address returns 404 until then.
4. Launch scope: [T24](../verification/T24-pre-launch-browser-and-keyboard-matrix.md) and [T25](../verification/T25-web-first-load-and-search-at-scale.md) decide the supported size. [ISSUE-093](ISSUE-093-directory-and-sidebar-render-every-row.md) and [ISSUE-094](ISSUE-094-site-index-cache-never-evicts.md) are required if the launch advertises large sites; otherwise the size limit is documented and they follow. OPS-006 comes before the announcement. T25's extended measurements (2026-10-17) raised two decisions that depend on the advertised size, both settled by the owner on 2026-10-18 as documented constraints with no code change: [ISSUE-110](ISSUE-110-site-index-deadline-covers-body-download.md) (large indexes on slow links) and [ISSUE-111](ISSUE-111-snippet-budget-omits-late-documents-at-scale.md) (snippet budget at 50,000 pages).
   Backend follow-up (owner decision 2026-10-18): [ISSUE-112](ISSUE-112-aws-large-generated-json-delivery.md) fixes AWS large generated JSON delivery before the next coordinated provider proof. Keep ISSUE-110's deadline decision; use the [backend next wave](../workstreams.md#backend-next-wave-2026-10-18) for order and approval gates.
5. After launch: [ISSUE-095](ISSUE-095-home-folder-counts-load-full-indexes.md), [ISSUE-098](ISSUE-098-spa-shell-metadata-for-sharing.md), [T26](../verification/T26-cli-publish-memory-vs-source-bytes.md), [T27](../verification/T27-launch-hosting-cost-model.md), and [ISSUE-106](ISSUE-106-known-html-failure-has-no-reader-guidance.md).

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
| [ISSUE-061](ISSUE-061-early-preview-click-escapes-reader.md) | Done | P3 | A click right after a preview loads can open the raw file outside the reader. |
| [ISSUE-062](ISSUE-062-config-set-default-help-saved.md) | Done | P2 | `config set-default --help` saves "--help" as the user's default config instead of printing help. |
| [ISSUE-063](ISSUE-063-actions-missing-fulltext.md) | Done | P1 | The site-publish Action could not pass `--fulltext`, so publishing through it withdrew page text search. |
| [ISSUE-064](ISSUE-064-r2-uses-shared-aws-config.md) | Done | P2 | The Cloudflare R2 path loads the shared AWS configuration, so AWS profiles and environment variables can affect R2 publishing. |
| [ISSUE-065](ISSUE-065-registry-dry-run-says-unchanged.md) | Done | P3 | `registry sync --dry-run` text says "unchanged" while planning to create the registry. |
| [ISSUE-067](ISSUE-067-single-cloudflare-publisher-token.md) | Done | P3 | Cloudflare publishing needs three secrets that one token can provide. |
| [ISSUE-068](ISSUE-068-bare-apply-commands-print-help.md) | Done | P1 | Bare `app deploy`, `registry register|unregister`, `site publish` and `preview publish` printed help and exited 0 instead of running. |
| [ISSUE-069](ISSUE-069-cloudflare-edge-rewrites-artifact-html.md) | Done | P1 | Cloudflare edge features (email obfuscation and similar) rewrite delivered artifact HTML; the module must disable them for the hostname. |
| [ISSUE-070](ISSUE-070-pr-dry-run-source-ref-noise.md) | Done | P3 | PR dry-runs can align `source.ref` with production through a metadata-ref override. |
| [ISSUE-071](ISSUE-071-remote-config-auth-error-unclear.md) | Done | P2 | A private deployment config the token cannot read fails with an unactionable HTTP status. |
| [ISSUE-072](ISSUE-072-modified-click-tab-and-route-fetch-e2e-flaky.md) | Done | P2 | Modified-click new-tab and route.fetch e2e tests fail intermittently under parallel load. |
| [ISSUE-073](ISSUE-073-palette-enter-uses-stale-selection.md) | Done | P2 | Pressing Enter right after typing in the command palette can do nothing or open the wrong page (regression from #34). |
| [ISSUE-074](ISSUE-074-shallow-clone-test-tempdir-cleanup-flaky.md) | Done | P3 | Shallow-clone Go test failed once on TempDir cleanup, likely a detached `git maintenance` gc after fetch. |
| [ISSUE-075](ISSUE-075-directory-routes-have-no-page.md) | Done | P1 | Directory routes have no page: folder URLs show "Page not found" and tree folders only toggle. |
| [ISSUE-076](ISSUE-076-pages-sorted-alphabetically-by-title.md) | Done | P1 | Navigation, site home and breadcrumb menus sort pages alphabetically by title, not like a file browser (decided in TD19: folders first, filename order; web only). |
| [ISSUE-077](ISSUE-077-fulltext-results-unranked.md) | Done | P1 | Page text search results are unranked, have no snippets, and mix languages. |
| [ISSUE-078](ISSUE-078-landing-page-has-no-orientation.md) | Done | P1 | The landing page offers only "Choose a site": no orientation, alphabetical cards, double-counted translations. |
| [ISSUE-079](ISSUE-079-palette-cannot-find-other-page-headings.md) | Done | P2 | The command palette cannot find headings of other pages. |
| [ISSUE-080](ISSUE-080-narrow-screen-chrome-and-scroll-cues.md) | Done | P2 | On narrow screens the permanent rail and two-row toolbar take reading space, and wide tables and code scroll without a cue. |
| [ISSUE-081](ISSUE-081-reader-shell-skip-link-and-document-language.md) | Done | P3 | The reader shell has no skip link and keeps `lang="en"` on Japanese documents. |
| [ISSUE-082](ISSUE-082-no-previous-next-navigation.md) | Won't fix | P3 | Pages have no previous/next navigation at the end (owner chose GitHub behavior in TD19; superseded by ISSUE-086). |
| [ISSUE-083](ISSUE-083-unknown-urls-return-http-200.md) | Won't fix | P3 | Unknown URLs return HTTP 200 with the app shell (soft 404); web part done, edge 404 declined (owner, 2026-10-12). |
| [ISSUE-084](ISSUE-084-previews-entry-and-timestamp-polish.md) | Done | P3 | "View previews" is a button, and preview times carry no timezone. |
| [ISSUE-085](ISSUE-085-page-text-search-snippets.md) | Done | P3 | Page text search results show no match snippet (split from ISSUE-077; reader side, the writer is IMP-77). |
| [ISSUE-086](ISSUE-086-pages-have-no-related-pages-list.md) | Done | P2 | Pages have no list of related pages to read next. |
| [ISSUE-087](ISSUE-087-page-text-search-results-page.md) | Done | P2 | Page text search needs a results page in the reading area (TD20 slice 1). |
| [ISSUE-088](ISSUE-088-indexer-rejects-reserved-first-segments.md) | Done | P2 | The indexer does not reject documents under reserved first path segments (`_previews`, `_search`). |
| [ISSUE-089](ISSUE-089-publisher-race-test-backend-and-race-ci.md) | Done | P2 | The publisher legacy-control test backend has a data race and CI never runs `-race`. |
| [ISSUE-090](ISSUE-090-npm-advisories-and-no-npm-monitoring.md) | Done | P2 | npm has known advisories (source-map-js, katex) and nothing monitors them continuously. |
| [ISSUE-091](ISSUE-091-malformed-index-rows-crash-render.md) | Done | P2 | Malformed artifact index rows pass loading and crash rendering; there is no error boundary. |
| [ISSUE-092](ISSUE-092-slow-site-metadata-blocks-site-list.md) | Done | P2 | One slow site metadata request holds the whole home page. |
| [ISSUE-093](ISSUE-093-directory-and-sidebar-render-every-row.md) | Done | P2 | Directory pages and the sidebar tree render every row. |
| [ISSUE-094](ISSUE-094-site-index-cache-never-evicts.md) | Done | P2 | Expired site-index cache entries stay in memory until the same site is read again. |
| [ISSUE-095](ISSUE-095-home-folder-counts-load-full-indexes.md) | Done | P3 | Home folder counts load the full index of up to eight sites. |
| [ISSUE-096](ISSUE-096-no-security-policy-or-contributing.md) | In progress | P2 | No security policy, contributing guide or issue templates. |
| [ISSUE-097](ISSUE-097-stale-first-reader-documents.md) | Done | P2 | README, release-readiness and the documentation track describe an outdated state. |
| [ISSUE-098](ISSUE-098-spa-shell-metadata-for-sharing.md) | Done | P3 | The SPA shell has generic metadata for search and share cards. |
| [ISSUE-099](ISSUE-099-version-command-prints-cli-version-as-web.md) | Done | P3 | The version command prints the CLI version as the web app version. |
| [ISSUE-100](ISSUE-100-app-deploy-summary-does-not-match-work.md) | Done | P3 | The app deploy change summary does not match the files written. |
| [ISSUE-101](ISSUE-101-registry-and-site-index-loads-have-no-deadline.md) | Done | P2 | Registry and active-site index reads have no application deadline. |
| [ISSUE-102](ISSUE-102-load-errors-offer-no-retry-action.md) | Done | P2 | Catalog, site-index and Markdown transport errors offer no retry action. |
| [ISSUE-103](ISSUE-103-command-palette-modal-focus-escapes.md) | Done | P2 | Keyboard focus escapes the command palette while its modal stays open. |
| [ISSUE-104](ISSUE-104-search-selection-is-not-associated-with-input.md) | In progress | P2 | Arrow-selected search results are not associated with the focused input. |
| [ISSUE-105](ISSUE-105-site-picker-updated-date-stays-stale.md) | Open | P2 | Site cards present metadata-generation time as content freshness. |
| [ISSUE-106](ISSUE-106-known-html-failure-has-no-reader-guidance.md) | Done | P3 | A missing indexed HTML body shows only the server error inside the reader. |
| [ISSUE-107](ISSUE-107-site-home-overview-files-preview-tabs.md) | Done | P2 | Site home mixes publisher introduction and tool navigation; owner selected compact overview/files/previews with persistent search. |
| [ISSUE-108](ISSUE-108-reader-context-needs-responsive-right-sidebar.md) | In progress | P2 | Contents and source details are hidden behind separate controls even on wide screens; design a responsive right sidebar before final docs work. |
| [ISSUE-109](ISSUE-109-preview-reading-context-and-entry.md) | Done | P2 | Preview reading needs shared app context, standard reader entry links and coherent PR/revision metadata; design after ISSUE-108. |
| [ISSUE-110](ISSUE-110-site-index-deadline-covers-body-download.md) | Done | P2 | The site index deadline covers the body download, so a large index on a slow link fails every time and Try again cannot recover. |
| [ISSUE-111](ISSUE-111-snippet-budget-omits-late-documents-at-scale.md) | Done | P3 | At 50,000 pages, 38% of documents get no search snippet because of the 32 MiB site budget, and later folders lose snippets first. |
| [ISSUE-112](ISSUE-112-aws-large-generated-json-delivery.md) | Done | P2 | AWS large generated JSON exceeds CloudFront's automatic-compression window; pre-encode site index and search manifest with a settled CLI 0.5.0 boundary. |
| [ISSUE-113](ISSUE-113-results-page-claims-no-search-while-discovery-loads.md) | Done | P2 | The full-text results page says the site was published without page text search while its discovery metadata is still loading. |

ISSUE-013's verified completion record is retained in Git history.

ISSUE-107 records the owner-selected site-home direction (2026-10-16), with a portable mock and explicit remaining behavior decisions. It is a reader product change; public documentation restructuring remains separate. Schedule it explicitly with the existing repair queue rather than treating it as a new release blocker.

ISSUE-108 is owner-requested design-first reader work (2026-10-17). Complete it before the final official documentation rewrite/screenshots; IA discussion may continue. Claude owns the design stage. It does not change the release authorization or reopen ISSUE-080.

ISSUE-109 follows ISSUE-108: Claude designs preview entry/reading and richer review metadata after the responsive context-sidebar work, before final preview documentation/screenshots. An existing logical SPA preview route is confirmed in source; the reported raw-link entry still needs reproduction.

ISSUE-110 and ISSUE-111 come from the T25 extended local measurements of 2026-10-17 at `c7d5d2b9` (see the [report](../../research/web-scale-benchmark.md)). The owner chose option 3 (keep the behaviour and document it as a constraint) for both on 2026-10-18.
