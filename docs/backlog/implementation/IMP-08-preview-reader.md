# IMP-08 — Revision-specific preview reader

- Status: Done
- Phase: Phase 1 local preview product
- Depends on: [IMP-01](IMP-01-preview-records.md), [IMP-07](IMP-07-local-serving.md); can initially consume committed fixtures.
- Proves: [T4](../verification/T4-serving-boundary.md), [T6](../verification/T6-resources-navigation.md)

## Outcome

Resolve `/:site/_previews/<head SHA>/<artifact path>` through the revision manifest and render HTML in the iframe and Markdown in the native sanitized reader. Preview identity and short SHA appear in existing application header treatment, not in the document H1.

## Evidence

Playwright covers Markdown and HTML readers, direct load/reload without catalog membership, missing manifest state, same-revision changed-document navigation, production navigation, iframe parent isolation, and reserved/Unicode path round trips. The local preview guide describes the trust and resource boundaries.

## Acceptance criteria

- Direct load/reload works without catalog membership while manifest and document exist; absent document/manifest shows “Preview unavailable” with a way back to the site.
- Changed-document links stay in the same revision; unchanged-document links go to production. HTML iframe links transition the parent app rather than nesting it.
- Preview bytes/resources respect the HTML executable-content versus sanitized Markdown trust boundary; production indexes and ordinary search are unchanged.
- E2E covers HTML, Markdown, relative resources, encoded paths and unavailable states.
