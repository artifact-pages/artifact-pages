# IMP-03 — Snapshot resources and document link mapping

- Status: Open
- Phase: Post-MVP preview
- Depends on: [IMP-02](IMP-02-source-selection.md); public include syntax remains in [T2](../technical-design/T2-cli-action-interface.md).
- Proves: [T6](../verification/T6-resources-navigation.md)

## Outcome

Build the preview bundle for changed documents with statically resolvable local CSS, JavaScript, images, fonts and other rendering resources from the head tree. Map statically resolvable document links to preview routes for changed documents and production routes for unchanged ones.

## Acceptance criteria

- HTML and Markdown fixture pages render local relative resources from the head snapshot without copying every linked document.
- Explicit extra non-document resources can be included; missing, out-of-tree and document-as-resource inputs fail. The public input form is settled in T2.
- Link rewriting preserves query/fragment and source-relative intent, including spaces, Unicode and reserved characters; external HTTPS links remain external.
- Runtime-built and root-relative URLs are not silently promised to work; unsupported cases are documented and tested.
