# IMP-08 — Revision-specific preview reader

- Status: Open
- Phase: Post-MVP preview
- Depends on: [IMP-01](IMP-01-preview-records.md), [IMP-07](IMP-07-local-serving.md); can initially consume committed fixtures.
- Proves: [T4](../verification/T4-serving-boundary.md), [T6](../verification/T6-resources-navigation.md)

## Outcome

Resolve `/:site/_previews/<head SHA>/<artifact path>` through the revision manifest and render HTML in the iframe and Markdown in the native sanitized reader. Preview identity and short SHA appear in existing application header treatment, not in the document H1.

## Acceptance criteria

- Direct load/reload works without catalog membership while manifest and document exist; absent document/manifest shows “Preview unavailable” with a way back to the site.
- Changed-document links stay in the same revision; unchanged-document links go to production. HTML iframe links transition the parent app rather than nesting it.
- Preview bytes/resources respect the HTML executable-content versus sanitized Markdown trust boundary; production indexes and ordinary search are unchanged.
- E2E covers HTML, Markdown, relative resources, encoded paths and unavailable states.
