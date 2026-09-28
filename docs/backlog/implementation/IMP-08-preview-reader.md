# IMP-08 — Revision-specific preview reader

- Status: Done
- Phase: Phase 1 local preview product
- Depends on: [IMP-01](IMP-01-preview-records.md), [IMP-07](IMP-07-local-serving.md); can initially consume committed fixtures.
- Proves: [T4](../verification/T4-serving-boundary.md), [T6](../verification/T6-resources-navigation.md)

## Outcome

Resolve `/:site/_previews/<head SHA>/<artifact path>` through the revision manifest and render HTML in the iframe and Markdown in the native sanitized reader. Preview identity and short SHA appear in existing application header treatment, not in the document H1.

## Evidence

Playwright covers Markdown and HTML readers, direct load/reload without catalog membership, missing manifest state, same-revision changed-document navigation, production navigation, reserved/Unicode path round trips, and the accepted trusted same-origin HTML model. The iframe contains CSS/layout while preview scripts retain ordinary same-origin parent-DOM and storage access. The local preview guide describes the trust and resource boundaries.

The September 2026 isolation checks were evidence for the former reader and are no longer HTML requirements. The owner accepted trusted same-origin execution in [TD3](../technical-design/TD3-preview-origin-delivery.md) on 2026-09-28. ISSUE-026 completed the reader/profile migration and regressions on 2026-09-29; live provider proof remains in [T15](../verification/T15-provider-delivery.md).

## Acceptance criteria

- Direct load/reload works without catalog membership while manifest and document exist; absent document/manifest shows “Preview unavailable” with a way back to the site.
- Changed-document links stay in the same revision; unchanged-document links go to production. HTML iframe links transition the parent app rather than nesting it.
- Preview bytes/resources respect the HTML executable-content versus sanitized Markdown trust boundary; production indexes and ordinary search are unchanged.
- E2E covers HTML, Markdown, relative resources, encoded paths and unavailable states.
