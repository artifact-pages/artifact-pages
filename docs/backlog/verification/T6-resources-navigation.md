# T6 — Preview resources and navigation

- Status: Done
- Phase: Phase 1 local preview product; broader browser compatibility remains open

## Contract to prove

Changed HTML and Markdown documents render from their head snapshot with local dependencies. Links to changed documents stay in that revision; links to unchanged documents open production routes.

## Exit criteria

- [x] Exercise HTML and Markdown fixtures with relative CSS, JavaScript, images, and fonts.
- [x] Verify changed-document links, unchanged-document links, and parent-app navigation from an iframe.
- [x] Exercise explicit non-document resource includes and reject missing or out-of-tree paths.
- [x] Document and test the unsupported boundary for runtime-built and root-relative URLs.

## Evidence

Go integration tests verify head-snapshot resource collection, explicit resource include rejection, root-relative resource errors, and omission of dynamically constructed resource paths. The local E2E covers preview Markdown and HTML, relative CSS/JavaScript/image/font assets, changed-document navigation with query/fragment preservation, unchanged production navigation, external HTTPS links, parent-app isolation, and the sandbox's blocked runtime-fetch path. The guide documents runtime-built URL limitations.

See [the local E2E fixture and tests](../../../e2e/local-serving.spec.ts) and the [preview selection and resource contract](../../specification.md#post-mvp-pre-publish-preview-contract).

## Implementation links

[IMP-02 source selection](../implementation/IMP-02-source-selection.md), [IMP-03 resource bundle](../implementation/IMP-03-resource-bundle.md), [IMP-07 local serving](../implementation/IMP-07-local-serving.md), [IMP-08 reader](../implementation/IMP-08-preview-reader.md), [IMP-10 PR return link](../implementation/IMP-10-pr-return-link.md), and [IMP-11 CLI](../implementation/IMP-11-cli.md) supply the preview-specific fixtures and paths to test.
