# IMP-03 — Snapshot resources and document link mapping

- Status: Done
- Phase: Phase 1 local preview contract
- Depends on: [IMP-02](IMP-02-source-selection.md); public include syntax remains in [T2](../technical-design/T2-cli-action-interface.md).
- Proves: [T6](../verification/T6-resources-navigation.md)

## Outcome

Build the preview bundle for changed documents with statically resolvable local CSS, JavaScript, images, fonts and other rendering resources from the head tree. Map statically resolvable document links to preview routes for changed documents and production routes for unchanged ones.

## Evidence

Go integration tests cover CSS imports/URLs, HTML resources, Markdown images, JavaScript imports, explicit resources, missing/out-of-tree/document-as-resource rejection, and omission of runtime-constructed resources. The local guide documents root-relative and runtime-built URL limits. Playwright verifies relative HTML/CSS/JS/image/font serving, query/fragment-preserving changed-document navigation, external HTTPS navigation, and the sandbox's runtime-fetch boundary.

## Acceptance criteria

- HTML and Markdown fixture pages render local relative resources from the head snapshot without copying every linked document.
- The local helper accepts repeated `--resource` paths; missing, out-of-tree and document-as-resource inputs fail. The eventual general CLI/Action input form remains T2 work.
- Link rewriting preserves query/fragment and source-relative intent, including spaces, Unicode and reserved characters; external HTTPS links remain external.
- Runtime-built and root-relative URLs are not silently promised to work; unsupported cases are documented and tested.
