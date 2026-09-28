# T6 — Preview resources and navigation

- Status: Open
- Phase: Phase 1 local preview product; broader browser compatibility remains open

## Contract to prove

Changed HTML and Markdown documents render from their head snapshot with local dependencies. Links to changed documents stay in that revision; links to unchanged documents open production routes.

## Exit criteria

- [x] Exercise HTML and Markdown fixtures with relative CSS, JavaScript, images, and fonts.
- [x] Verify changed-document links, unchanged-document links, and parent-app navigation from an iframe.
- [x] Exercise explicit non-document resource includes and reject missing or out-of-tree paths.
- [x] Document and test the unsupported boundary for runtime-built and root-relative URLs.
- [x] Round-trip spaces, Unicode and reserved characters through the configured object-backed preview publisher, not only the directory store (completed ISSUE-015; evidence below).
- [ ] Exercise valid export strings, multiline imports, inline HTML modules, and sanitized Markdown raw-HTML images ([ISSUE-023](../issues/ISSUE-023-preview-module-dependency-parsing.md), [ISSUE-024](../issues/ISSUE-024-preview-inline-module-resources.md), [ISSUE-025](../issues/ISSUE-025-preview-markdown-html-resources.md)).
- [ ] Verify actual raw-resource link navigation and HTML fragment scrolling, including direct reload and cross-document links ([ISSUE-027](../issues/ISSUE-027-preview-resource-link-navigation.md), [ISSUE-028](../issues/ISSUE-028-preview-html-fragment-navigation.md)).
- [ ] Exercise the settled non-loopback delivery contract with module execution and frame isolation ([TD3](../technical-design/TD3-preview-origin-delivery.md), [ISSUE-026](../issues/ISSUE-026-preview-provider-module-loading.md)).

## Reopened scope

Reopened on 2026-09-28 after the full-codebase review exposed supported-resource and navigation gaps not covered by earlier fixtures. Checked items retain their narrower historical local evidence, not complete fragment or provider-reader compatibility. Port each issue's reproduction into committed regressions before closing this item again. Do not claim live provider evidence from local browser tests.

## Evidence

Go integration tests verify head-snapshot resource collection, explicit resource include rejection, root-relative resource errors, and omission of dynamically constructed resource paths. The ISSUE-015 Go regression publishes raw Unicode/reserved-name documents and resources through both `DirectoryStore` and `ObjectPreviewStore` backed by the configured local target, then requests their once-encoded URLs over HTTP and checks the manifest paths and physical keys. `scripts/test-registered-flow.mjs` repeats publication from a temporary registered Git repository and requests the returned document/resource keys through the Docker nginx edge; Playwright opens the returned logical route, verifies its relative stylesheet, and reloads it. An independent diff review found no actionable findings; its optional suggestion for more special-character cross-document link coverage remains outside ISSUE-015's key/URL acceptance criteria. This proves the local configured-target path only; no live AWS or Cloudflare request is claimed. The local E2E also covers preview Markdown and HTML, relative CSS/JavaScript/image/font assets, changed-document navigation with query/fragment preservation, unchanged production navigation, external HTTPS links, parent-app isolation, and the sandbox's blocked runtime-fetch path. The guide documents runtime-built URL limitations.

See [the local E2E fixture and tests](../../../e2e/local-serving.spec.ts) and the [preview selection and resource contract](../../specification.md#post-mvp-pre-publish-preview-contract).

## Implementation links

[IMP-02 source selection](../implementation/IMP-02-source-selection.md), [IMP-03 resource bundle](../implementation/IMP-03-resource-bundle.md), [IMP-07 local serving](../implementation/IMP-07-local-serving.md), [IMP-08 reader](../implementation/IMP-08-preview-reader.md), [IMP-10 PR return link](../implementation/IMP-10-pr-return-link.md), and [IMP-11 CLI](../implementation/IMP-11-cli.md) supply the preview-specific fixtures and paths to test.
