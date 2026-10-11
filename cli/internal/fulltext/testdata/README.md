# Full-text v1 golden fixtures

`manifest-v1.json` and its `root-*.gz` / `leaf-*.gz` objects capture the current v1 search blobs for the input set in `snippet_contract_test.go`. The Go test compares the current builder's compressed root and leaf bytes with these files so additive section support cannot silently change the legacy binary payloads. The manifest is also suitable for a legacy-reader fixture.

`manifest-snippets.json` is the same v1 projection with the optional `sections`, `texts`, and `snippetLimits` fields populated. Its root and leaf references and bytes are identical to the legacy fixture. The section table includes Japanese text and byte offsets, an anchored heading, a title-only document with no section row, and a document truncated at the 256 KiB cap. The two text packs demonstrate a pack closed before a document that would exceed the hard pack limit and a final pack at exactly 256 KiB.

The future Go writer tests should compare emitted section-table and text-pack bytes with these objects. The web reader tests should load the same additive manifest and object files; fixture changes should be coordinated between those consumers.
