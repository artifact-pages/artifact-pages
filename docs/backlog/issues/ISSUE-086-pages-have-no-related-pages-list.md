# Pages have no list of related pages to read next

- Status: Done
- Assignee: Claude
- Priority: P2
- Area: Reader page footer (web reader; `web/src/components/ArtifactWorkspace.tsx`, a new pure selector under `web/src/domain/`)

## Problem

At the end of a page the reader has nowhere to go. They must return to the sidebar or the breadcrumb menu and guess what to read next. [ISSUE-082](ISSUE-082-no-previous-next-navigation.md) (previous/next) is Won't fix because the owner chose GitHub's file-browser behavior, which has no author-defined order and no pager ([TD19](../technical-design/TD19-navigation-metadata-in-the-site-index.md)). This issue covers the need differently, without any new metadata.

## Evidence and reproduction

From the 2026-10-11 dogfooding of `https://artifact-pages.dev` (the owner's notes) and the competitive review recorded in ISSUE-082.

1. Open `/guide/en/publishing.html` and read to the end.
2. Observed: the page ends; the shell offers no link to another page. Confirmed in code: no neighbour or related-page computation exists in `web/src`.

## Expected outcome

At the bottom of a page the reader sees a short list of pages they are likely to want next. The list is built in the browser from the data the site index already has (`title`, `path`, `toc`); the index, the CLI and the authored files do not change.

Relations based on the link graph (outgoing links and backlinks) would need an index extension. They are a possible later step and not part of this issue.

## Acceptance criteria

- [x] Selection rule: candidates are same-folder sibling pages plus pages whose title or headings (`toc`) are similar to the current page's. Siblings and similar pages are merged into one ranked list.
- [x] Deterministic: the same index and page always give the same list in the same order (ties broken by path). The current page is never included.
- [x] Capped count (the issue decides the number, about 5), with each entry showing the title and its folder when it differs from the current page's.
- [x] Works with no siblings (a root page, or a one-page folder): similarity can still fill the list; with no candidates the section is not rendered.
- [x] Translations kept in parallel folders (`en/`, `ja/`) do not dominate: prefer pages under the same top-level folder, and do not fill the list with the same page's counterpart in another folder. No language detection is added.
- [x] Unit tests for the selector: sibling-only, similarity-only, mixed, no candidates, cap, tie-breaking, current page excluded, parallel `en/`/`ja/` folders.
- [x] e2e: the list appears at the end of a Markdown page, links navigate, it is reachable by keyboard, and it is absent on an HTML artifact (revised by the owner decision below: HTML artifacts get no list).
- [x] Specification updated with the selection rule.
- [x] Narrow-screen layout checked at 390 px, no horizontal page scroll.

## Progress

- 2026-10-11 (Claude): the pure selector landed in `web/src/domain/related-pages.ts` with unit tests (sibling-only, similarity-only, mixed, no candidates, cap, tie-breaking, current page excluded, parallel `en/`/`ja/`). Score: +4 same folder, +2 same top-level folder, plus title/heading token overlap (CJK bigrams); a non-sibling needs overlap of at least 2; the same relative path under another top-level folder is dropped. Placement awaits the owner's choice among three concept stories (`Concepts/Reader UX 2026-10/ISSUE-086 related pages`); the reader is not wired yet. Finding for the owner: the HTML iframe fills the stage and scrolls inside itself, so an end-of-page block is not reachable without scrolling in the iframe unless the shell adds a strip under the frame or sizes the frame to its document; the Contents-panel placement is unaffected.

- 2026-10-12 (owner decision): placement A, a "Read next" list at the end of Markdown pages only. HTML artifacts get no related-pages UI at all: a shell strip under the frame was tried (concept #102) and rejected; variants B and C are rejected. This supersedes the acceptance criteria that asked for a list below HTML artifacts.
- 2026-10-12 (Claude): shipped in the PR for this issue. `web/src/components/ReadNext.tsx` renders the selector's result after the Markdown article (inside the scrolling region, via `MarkdownArtifact`'s `footer`), with title, folder label when it differs from the page's folder, and a reason chip (Same folder / Similar topic). Links are real `<a href>` with the in-app click convention (`followInApp`: modified clicks keep browser behavior). Not rendered when there are no related pages, on HTML artifacts, on a folder's README shown inside a directory page (the directory page is itself the list), or on the search results page. The UI is English-only, so the heading is "Read next". The selector now memoises per-entry profiles and documents that the en/ja counterpart rule is path-based and checks only the top-level folder; tests added for current-id exclusion, filler-only titles and missing `toc`. e2e covers Markdown, HTML and 390 px. The selection rule is recorded in `docs/specification.md`. Status stays In progress until verified in production after the next web release.

## Production check (2026-10-12)

web/v0.3.0 is deployed to https://artifact-pages.dev, whose sites contain HTML pages only, so the list correctly does not appear there. The Markdown behaviour was checked on the verification deployment (https://artifact-pages.stream/readme-demo, same reader code) and is covered by e2e. Done.
