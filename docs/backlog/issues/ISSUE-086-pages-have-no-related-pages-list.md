# Pages have no list of related pages to read next

- Status: Open
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

- [ ] Selection rule: candidates are same-folder sibling pages plus pages whose title or headings (`toc`) are similar to the current page's. Siblings and similar pages are merged into one ranked list.
- [ ] Deterministic: the same index and page always give the same list in the same order (ties broken by path). The current page is never included.
- [ ] Capped count (the issue decides the number, about 5), with each entry showing the title and its folder when it differs from the current page's.
- [ ] Works with no siblings (a root page, or a one-page folder): similarity can still fill the list; with no candidates the section is not rendered.
- [ ] Translations kept in parallel folders (`en/`, `ja/`) do not dominate: prefer pages under the same top-level folder, and do not fill the list with the same page's counterpart in another folder. No language detection is added.
- [ ] Unit tests for the selector: sibling-only, similarity-only, mixed, no candidates, cap, tie-breaking, current page excluded, parallel `en/`/`ja/` folders.
- [ ] e2e: the list appears below an HTML artifact and a Markdown artifact, links navigate, it is reachable by keyboard, and it does not require scrolling inside the artifact iframe (the control lives in the shell).
- [ ] Specification updated with the selection rule.
- [ ] Narrow-screen layout checked at 390 px, no horizontal page scroll.
