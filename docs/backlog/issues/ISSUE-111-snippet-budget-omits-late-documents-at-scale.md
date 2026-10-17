# At 50,000 pages, 38% of documents get no search snippet and later folders lose snippets first

- Status: Open
- Priority: P3
- Area: Search / snippet packs (writer budget and results page)
- Source: T25 extended local measurements 2026-10-17, build `c7d5d2b9`
- Related: [TD20](../technical-design/TD20-search-results-page-and-snippet-packs.md) (defines the 256 KiB per-document and 32 MiB per-site limits), [ISSUE-085](ISSUE-085-page-text-search-snippets.md) (snippets in results), [T25](../verification/T25-web-first-load-and-search-at-scale.md)

## Problem

TD20 caps the total raw size of snippet text packs per site at 32 MiB and records the documents it omits. On a 50,000-page site of ordinary pages (about 1.2 kB each, plus one 281 kB page) the budget runs out part-way through the site: later documents have no snippet, their results show the page without a match excerpt, and the omission is by path order, so the folders that sort last lose snippets first while earlier folders keep all of theirs. A reader sees an uneven result list with no indication of why.

## Evidence and reproduction

Measured (T25 extended local phase, [report](../../research/web-scale-benchmark.md#snippet-budget-at-50000-pages)):

1. Generate the 50,000-page benchmark site (`npm run benchmark:web-scale -- --counts 50000 --iterations 1 --profiles unthrottled --only first-load,search-cases --keep`), which publishes it with the CLI built from the checkout.
2. Read `_indexes/scale-50000/search/manifest.json`: `snippetLimits.maxSiteBytes` is 33,554,432, `maxDocumentBytes` 262,144, `truncatedDocuments` is empty and `omittedDocuments` lists 18,956 of the 50,308 documents (38%).
3. The list is in path order: the first omitted document is `area-13/section-040/note-023.md`, the last are the root `overview-*` pages.
4. The long-body probe page (`big-flat/page-000000.md`, 281,101 B, above the per-document cap) is in `omittedDocuments`: the site budget omits it before the per-document cap would truncate it. Its search result appears without a snippet.

Confirmed observations are limited to this synthetic site (English vocabulary plus two Japanese sentences per page). Real sites with larger or smaller pages cross the budget at different page counts; the page count at which omission starts was not measured (the manifests of the 1,000 to 10,000-page sites were not inspected for omissions).

## Options for the owner

These are alternatives; none is chosen here.

1. Raise the budget, or make it configurable per site or per deployment, with the cost in publish size and in search-data download documented.
2. Spread the budget across folders (for example a per-folder share, or the first N bytes of every document) so that omission does not follow path order.
3. Keep the limit and its path-order behaviour, and document it for large sites, including what readers see for omitted documents.

## Expected outcome

At the site sizes the launch advertises, a reader can tell why a result has no snippet, and the omission does not systematically favour documents that sort first.

## Acceptance criteria

- [ ] The owner chooses an option (or keeps the behaviour with documentation).
- [ ] For a 50,000-page benchmark site, the share of documents without a snippet and the order of omission match the chosen behaviour, checked in the manifest.
- [ ] The reader shows omitted results consistently (for example, a note or an excerpt-less layout) and this is covered by a test.
- [ ] The T25 report records the re-measurement.
