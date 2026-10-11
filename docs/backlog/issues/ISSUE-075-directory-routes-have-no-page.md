# Directory routes have no page: folder URLs show "Page not found" and tree folders only toggle

- Status: Open
- Priority: P1
- Area: Reader routing, sidebar tree, breadcrumbs, command palette (`web/src/components/ArtifactWorkspace.tsx`, `ArtifactTree.tsx`, `ArtifactBreadcrumbs.tsx`, `web/src/domain/tree.ts`)

## Problem

This is a proposed product change to documented behavior, not a defect: the specification says a folder-like path is not turned into a listing (`docs/specification.md:122`) and that index files do not alias their parent directories (`docs/specification.md:314`).

The reader builds a folder tree from `artifact.path`, but a folder is not a destination. A reader cannot link to, bookmark or share "the English guide", and cannot reach a section's table of contents without expanding the sidebar. The breadcrumb already presents folders as path segments, so a reader who trims the URL to a folder gets a dead end.

## Evidence and reproduction

From the 2026-10-11 dogfooding of `https://artifact-pages.dev` (guide: 14 artifacts, architecture: 12; all HTML artifacts under top-level `en/` and `ja/` folders) and confirmed against this tree.

1. Open `/guide/en/publishing.html`. The breadcrumb reads `en ⌄ / Publishing`.
2. Open `/guide/en` (the folder). The workspace shows "Page not found / The page you requested does not exist or is no longer available." with the tree still visible. `/guide/en/nope.html` shows the same text. Source: any non-matching `route.artifactPath` falls to the not-found block (`ArtifactWorkspace.tsx:797-807`).
3. In the sidebar the `en` row only toggles (`ArtifactTree.tsx:122`, `:164-171`, `aria-expanded` button).
4. The breadcrumb folder segment is a menu button (`ArtifactBreadcrumbs.tsx:205-212`); its menu is an unlinkable, unshareable sibling listing (`getNearbyArtifacts`, `:299-315`).
5. `buildArtifactTree` nodes carry `name`, `path`, `directories` and `artifacts` only (`tree.ts:3-8`); a node has no page of its own.

The Reading page of the Guide states that a folder URL does not open anything automatically, so this is current, documented behavior, not an accident. The finding is that it is a dead end for the reader.

Competitor patterns (observed in the 2026-10-11 review; hands-on DOM and screenshot checks, no search behavior): Docusaurus generated-index pages (card per child with title, description, and "N items" for subfolders) with label navigating and chevron toggling; MkDocs Material `navigation.indexes` (the section label links to the section's index page, the chevron toggles); GitHub folder view (clickable path segments, a listing, README rendered below); GitBook group pages and Outline parent documents (a page plus a child list). Starlight and Obsidian Publish give a group no page, which the review judged the weakest wayfinding.

## Expected outcome

Every directory in a site is a routable page with a stable URL, reachable from the tree, the breadcrumb and the command palette, and usable on a narrow screen.

## Owner decision (2026-10-11)

Chosen from the Storybook `Concepts/Reader UX 2026-10`/ISSUE-075 stories:

- Layout: variant A (list rows: icon, title, updated date and committer, H2 headings as chips, subfolders first with "N pages"). A folder that contains `README.md` or `index.md` uses variant C: that page's body first, then the compact child list.
- The README/index page is not listed again among the children.
- A folder with one page keeps its own folder URL (no redirect).
- Sidebar: the folder label navigates to the folder page; the chevron only toggles. Breadcrumb folder segments are links; the sibling menu stays on a small chevron.
- Palette: folders are listed below page matches.
- Folder title is the raw folder name until TD19 provides metadata. Order stays alphabetical until ISSUE-076/TD19.

## Acceptance criteria

- [ ] `/<site>/<dir>` for any directory that contains at least one artifact (at any depth) renders a directory page instead of "Page not found". A path that is neither an artifact nor a directory keeps the existing not-found view.
- [ ] In the sidebar tree the folder label navigates to the directory page and the chevron alone toggles; keyboard: Enter on the label navigates, Right and Left expand and collapse. Existing `aria-expanded` semantics are kept on the toggle.
- [ ] Resolution order: if the directory has a `README.md` or `index.md` (artifact `format` Markdown) it renders as the page body with the child listing appended below it; otherwise the reader generates a page. Option to decide in this issue: also treat a sibling `foo.md` as the index of `foo/` (the Nextra and Outline model), and define the collision rule when both an artifact and a directory have the same name. Record the decision in the issue before implementing. A `README.md` or `index.md` is itself an indexed page: decide whether it also appears as a child in the listing or only as the directory body (listing it twice is the default to avoid).
- [ ] The generated page has a title (the directory name, prettified), a breadcrumb whose segments are links, and a child list with subfolders first. Each artifact child shows its title and updated date, and its H2 headings are available from the index `toc` (for example as an expandable outline). Each subfolder child shows its page count.
- [ ] The first version needs no index schema change: it uses only fields `index.json` already carries. Per-child descriptions arrive later with [TD19](../technical-design/TD19-navigation-metadata-in-the-site-index.md).
- [ ] Breadcrumb folder segments become links to the directory page. The existing sibling menu may stay as a secondary affordance (for example on the chevron); decide the split in the issue.
- [ ] Directories appear in the command palette as results (a "Section" or similar group with counts) and open the directory page.
- [ ] Listing order follows the rule introduced by [ISSUE-076](ISSUE-076-pages-sorted-alphabetically-by-title.md) and TD19. Until then the page uses the current (title) order, and that dependency is noted in the page's tests.
- [ ] The directory page, its breadcrumb and the folder-row split work at 390 px width and in the drawer sidebar; no horizontal page scroll.
- [ ] Edge cases covered by tests: a directory with one child, a directory whose only artifacts sit in nested folders, and a path that percent-encodes characters.
- [ ] Specification updated: the not-found sentence (`docs/specification.md:151`), the folder-path rule (`:122`), the index-file rule (`:314`), and the tree and breadcrumb sections.

## Notes

- Web only (Claude-owned). Do not build it for a single-level site with very few pages; the site home already serves that case, so the generated page may link to it or collapse to it.
- Dependencies: ordering from ISSUE-076 and descriptions from TD19. Neither blocks the first version.
