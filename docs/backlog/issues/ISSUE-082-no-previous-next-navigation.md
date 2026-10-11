# Pages have no previous/next navigation at the end

- Status: Blocked
- Priority: P3
- Area: Reader page footer (`web/src/components/ArtifactWorkspace.tsx`)

## Blocker

Blocked on [ISSUE-076](ISSUE-076-pages-sorted-alphabetically-by-title.md) and [TD19](../technical-design/TD19-navigation-metadata-in-the-site-index.md): a pager needs an author-defined order, which the index does not carry. Unblock when ISSUE-076 lands.

## Problem

A reader who finishes a page has no "next" action; they must return to the sidebar or the breadcrumb menu and find the next page. Guided sequences (a quickstart, the numbered Architecture pages) lose their flow.

## Evidence and reproduction

From the 2026-10-11 competitive review (hands-on DOM and screenshot checks of live documentation sites, not a usability study): Docusaurus, MkDocs Material, Starlight and VitePress all render a previous/next pager with page titles at the end of the page; GitBook and Obsidian Publish did not show one in the checks made. Only structure was observed, not usage data.

Confirmed in code: the reader renders no such control; the neighbours of a page are not computed anywhere in `web/src`. The only sibling listing is the breadcrumb menu (`ArtifactBreadcrumbs.tsx:299-315`).

Dependency: the sequence is meaningless until pages have an author-defined order. With the current title order (see [ISSUE-076](ISSUE-076-pages-sorted-alphabetically-by-title.md)) a pager would send readers through an arbitrary sequence. Do not ship before ISSUE-076 and [TD19](../technical-design/TD19-navigation-metadata-in-the-site-index.md).

## Expected outcome

At the end of a page the reader can continue to the previous or next page in the site's tree order, with titles shown.

## Acceptance criteria

- [ ] After the order from TD19 exists, each page offers previous and next links following the sidebar tree order within the site (depth-first, skipping directory pages), with titles; the first and last pages show only one.
- [ ] It is reachable by keyboard and works for HTML artifacts, whose content sits in an iframe (the control lives in the shell, outside the frame; placement is decided in the issue so it does not require scrolling inside the frame).
- [ ] No pager for a site with a single page or when the order is the unspecified fallback, if the issue decides that.
- [ ] Narrow-screen layout checked at 390 px.
