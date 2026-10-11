# Full-text v1 golden fixtures

`manifest-v1.json` and its `root-*.gz` / `leaf-*.gz` objects capture the current v1 search blobs for the input set in `snippet_contract_test.go`. The Go test compares the current builder's compressed root and leaf bytes with these files so additive section support cannot silently change the legacy binary payloads. The manifest is also suitable for a legacy-reader fixture.

`manifest-snippets.json` is the same v1 projection with `sections`, `texts`, and `snippetLimits` populated. Its section table and packs cover Japanese byte offsets, a display-preserving mixed-case/full-width heading, an anchored heading, a title-only document with no section row, and a document truncated at the 256 KiB cap. The pack containing `Retry cache` preserves that display case; the v1 postings still index normalized text. The two packs demonstrate a pack closed before a document that would exceed the hard pack limit and a final pack at exactly 256 KiB.

`snippet-vectors.json` indexes standalone expected section tables and text packs used by `TestSnippetContractVectors`. Each table and pack is an independently referenced, canonical gzip object. The contract test validates only these expected tables, byte ranges, and pack contents; the source examples are fixtures for the writer work and are not parsed by this test.

- F1 stores `障害対応 𠮷 😀` under Japanese heading and anchor labels, checking byte offsets with non-BMP scalars.
- F2 stores `Artifact Pages ＡＢＣ` unchanged, checking that snippet bytes are not NFKC-normalized or lowercased.
- F3 stores the expected prefix after a 262,144-byte cut would split `界` or `😀`; the retained lengths are 262,142 and 262,141 bytes.
- F4a uses [f4a-headings.md](f4a-headings.md). Its h1, h2, and h3 start sections with generated `md-*` anchors; the h4 and h5 remain in the h3 section.
- F4b uses [f4b-headings.html](f4b-headings.html). The h1 and first h2 have IDs and start sections; the id-less h2 remains in the current h2 section.
- F5 uses [f5-empty-content.md](f5-empty-content.md). The expected table drops the empty and whitespace-only heading sections and keeps only the retained section, with no zero-length range.
- F6 packs two documents together at the 16,384-byte soft minimum, then closes the pack on the second path's hash. `sha256("f6-a.md")[0]` is `0x93` (not a boundary); `sha256("f6-b.md")[0]` is `0x30` (boundary).
- F7 checks Go JSON escaping for a heading containing `<`, `>`, `&`, U+2028, and U+2029.

The source vectors describe expected output only; the writer PR must reproduce F4's table and pack from the source. Fixture changes should be coordinated with future writer and web-reader consumers.
