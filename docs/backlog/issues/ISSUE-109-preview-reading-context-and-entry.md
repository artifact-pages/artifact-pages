# Preview reading loses the shared reader context and scatters review metadata

- Status: Open
- Priority: P2
- Area: Web / preview entry, reading and review context

## Problem and owner intent

Preview readers should enter through the Artifact Pages application and retain a coherent reading experience, with clear preview identity and access to its richer review metadata, including the GitHub PR link. The owner reports that opening a preview feels like following a direct document link outside the usual reader. Merely changing a URL is insufficient: redesign the preview entry, document reading and review context together.

The goal is to make application-mediated reading the normal path. Raw HTML/Markdown remains a deliberately labeled secondary action where appropriate; it must not be the default review entry.

## Evidence and limits

Source inspected on 2026-10-17 against the locally available product tree; recheck current main before design:

- `web/src/data/previews.ts` distinguishes logical application URLs (`/:site/_previews/:head/:path?group=...`) from raw files (`/_previews/:site/revisions/:head/files/...`).
- `PreviewListPage.tsx` already constructs document links with `previewRouteHref`. `App.tsx` handles preview-list and preview-document routes in separate components rather than the normal `SitePage`/`ArtifactWorkspace` path.
- `PreviewDocumentPage.tsx` has its own header and reader stage, with revision, path, preview-list navigation and a conditional PR link. Existing app routing therefore does not establish that every preview opens raw content. The exact owner-reported entry has not been reproduced in a fresh live preview during filing.
- The PR link is resolved only when a matching group and head are found in the current catalog. A fixed revision link may outlive the group's current head; the design must address this without falsely attributing an old revision to a new PR state.
- `actions/shared/preview-comment.mjs` renders `groupListUrl` and `documents[].url` supplied by the CLI result. Audit the generated URLs and current consumers before assuming an Action/CLI defect.

## Sequence and ownership

**After [ISSUE-108](ISSUE-108-reader-context-needs-responsive-right-sidebar.md)**: first establish the responsive Contents/Details design, then design preview reading around that shared pattern and its additional metadata. Coordinate [ISSUE-107](ISSUE-107-site-home-overview-files-preview-tabs.md)'s preview tab and retained preview deep links. Complete this experience work before final documentation screenshots and preview feature copy; docs IA discussion can continue.

Claude main should start with design and actual journey inspection, then write the exact implementation brief and use the normal directory delegation/fresh cross-review rules. This item is Open/unclaimed; it is not an instruction for standalone implementation or release.

## Design and investigation scope

1. Trace representative entry points end to end: PR comment, Action outputs/job summary, site preview list/tab, shared fixed-revision link, preview-to-preview internal link and return from PR. Record which already use the application and which bypass it or abandon shared reader context. Include manual previews, which have no PR.
2. Design the application preview reader using the shared shell and ISSUE-108 context pattern where appropriate. Identify the preview/site, offer navigation back to its group/list and the published site, and keep Contents/Details reachable at wide and narrow widths. Do not imply that all published-site pages belong to the preview snapshot.
3. Inventory available metadata and decide its hierarchy: PR number/link when verified, preview head revision, creation/update timestamp with clear meaning, document path/title, and changed-page versus resource-dependency reason. Manifest data also includes default head and merge base; assess whether these belong in expanded details rather than presenting all fields prominently.
4. Preserve the distinction between preview build time and a document's last modification time. Do not show a production document's author/date/source as preview provenance merely because the path matches. Missing metadata stays absent or explicitly unavailable; do not fabricate authorship, PR association or ownership.
5. Define primary PR/list/document links as logical reader routes, with ordinary anchor/new-tab/copy behavior, preserved heading hashes and group/revision identity. Raw access is explicitly differentiated. If a particular URL is already correct, preserve it and fix only the missing reading context.
6. Design manual, missing/expired, superseded revision, missing/moved group, catalog failure and unsupported-format states. A matching PR/catalog record must not be assumed forever, and lack of optional PR context need not prevent a still-available fixed revision from being read.
7. Preserve existing preview HTML isolation, resource resolution, bridge navigation, published-site fallback rules, same-repository PR trust verification and immutable revision semantics. Adding a production-content diff viewer, new editing/review service or runtime GitHub fetch is not implied by this request.

The owner has not selected the exact preview layout, metadata order or error copy. Present inspectable designs with realistic PR/manual/older-revision states before implementing. This issue describes desired experience rather than prescribing component reuse or a metadata schema change.

## Implementation boundaries

Starting points: `web/src/App.tsx`, `routing.ts`, `data/previews.ts`, `domain/preview.ts`, `components/PreviewListPage.tsx`, `PreviewDocumentPage.tsx`, `ArtifactWorkspace.tsx`, the resulting ISSUE-108 components and preview-related browser tests. Audit CLI review-URL generation and `actions/shared/preview-comment.mjs`/preview Action outputs as entry-point producers.

Only change CLI/Actions if investigation proves an affected entry needs it; split a precise producer brief with the assigned implementer and cross-review rather than broadening web work silently. Published generated Action repositories must not be edited directly. No change to preview schema, provider permissions, cloud resources or public documentation is authorized merely by this backlog item. Release and deploy remain separately gated.

## Entry audit (2026-10-17)

Traced in the code of the ISSUE-108 branch (`claude-issue-108`, which includes current main), not reproduced live. "Shared reader shell" means the left sidebar and context bar of `ArtifactWorkspace`. `previewRouteHref`/`DocumentRouteHref` build the logical route; `previewFileUrl` builds the raw-file URL.

| Entry path | URL it produces | Kind | What the reader sees |
| --- | --- | --- | --- |
| PR comment, list link (`preview-comment.mjs`, `groupListUrl` from `previewGroupURL` in `cli/cmd/artifact-pages/preview.go`) | `<origin>/<site>/_previews?group=pr%3A<n>` | Logical SPA route, app page without the shared reader shell | `PreviewListPage`: its own `preview-page` layout, back link to the site, one group with its documents and an "Open PR" link. Mutable: always resolves through the current catalog. |
| PR comment, document rows (`documents[].url` from `previewDocumentRoute` and `preview.DocumentRouteHref`) | `<origin>/<site>/_previews/<headSha>/<path>?group=pr%3A<n>` | Logical SPA route, app page without the shared reader shell | `PreviewDocumentPage` (`preview-reader`): own header with "← Previews", `Preview · <12-char sha>`, a PR link only if the catalog still has this group at this exact head, the title and path; the document below; a floating "Back to <site>" link. No sidebar, no context bar, no ISSUE-108 column, no command palette. Fixed revision: it does not change when the PR gets a new push. |
| Action outputs (`group-list-url`, `documents`) and job summary (`summary.mjs`: "Preview list", document table) | The same two URL kinds as above (the Action passes the CLI result through; `summary.mjs` prints `groupListUrl` and each `document.url`) | Logical SPA routes, app pages without the shared reader shell | Same as the two rows above. The Action output description says "fixed revision URLs", which matches the document URLs. |
| Site preview list from the site (`SiteHome.tsx` previews link, command palette "Open previews") | `/<site>/_previews` (no group) | Logical SPA route, app page without the shared reader shell | `PreviewListPage` listing every available group, newest first. The ISSUE-107 Overview / Files / Previews tab is not built yet; this link is the only site entry today. Document rows link to `previewRouteHref(..., group.id)` with the group id, for manual groups too (`?group=head%3A<sha>`). |
| Shared fixed-revision link (a document link copied from a comment, the list or the address bar) | `/<site>/_previews/<headSha>/<path>` with or without `?group=` | Logical SPA route, app page without the shared reader shell | `PreviewDocumentPage` as above. The manifest decides whether it renders. After a newer push the revision still renders (it is immutable) but the page shows no PR link, because the catalog head no longer matches, and nothing says it is not the group's current head. If the revision is gone: `PreviewUnavailable` with "Preview unavailable", also without the shell. |
| Preview-to-preview link, Markdown (`resolveHref` of `PreviewDocumentPage`) | A raw-file URL inside the document is rewritten to `previewRouteHref(site, head, path, groupId)`; a path found only in the published index goes to `artifactRouteHref` (the published site's page) | Logical SPA route; the published fallback leaves the preview for the normal reader | Next preview document in the same preview page; the group is kept. A link to a path in neither place is left as the author wrote it. |
| Preview-to-preview link, HTML (`preview-bridge.js` message, or the `onLoad` safety net) | The frame's raw-file destination `/_previews/<site>/revisions/<head>/files/<path>` is mapped by `resolveLogicalDocumentLink` to the same logical routes as above | Raw-file URL inside the frame, converted to a logical route by the reader | Reader navigation (one history step). A destination that is neither a changed document nor a published document is not converted, so the frame itself shows the raw file: no reader context at all. Not reproduced. |
| Manual preview, no PR (CLI emits `?group` only for PR groups, see `makePreviewPublishOutput`) | Document: `/<site>/_previews/<headSha>/<path>`; list: `/<site>/_previews?group=head%3A<sha>`; a PR comment is never posted | Logical SPA routes, app pages without the shared reader shell | Document page with no PR link and the back link going to the unfiltered `/_previews`, not to the manual group. The same document reached from the list carries `?group=head%3A<sha>` and goes back to the filtered list. |
| Raw file (`previewFileUrl`) | `/_previews/<site>/revisions/<head>/files/<path>` | Raw-file URL | Only reachable by editing a URL by hand or through an author's own absolute links. No audited producer emits it as an entry. |

Findings:

1. Every audited producer (CLI result, Action outputs, job summary, PR comment) already emits logical SPA routes. The owner-reported "direct link" feel is not explained by a raw URL in the comment. No CLI or Action change is indicated; the symptom is that both preview pages lack the shared reader shell (sidebar, context bar, the ISSUE-108 column, palette), so the page looks like a different application from the site.
2. The PR comment's document links are fixed to a revision. After the next push the comment is updated in place, but copies, notifications and bookmarks keep pointing to the older revision. The reader renders it without saying it is not the group's current head (superseded state is a normal case, not an edge case).
3. `PreviewDocumentPage` builds the document's `ArtifactIndexEntry` with `updatedAt: manifest.createdAt`. The page does not display it today, but reusing `ArtifactDetails` (ISSUE-108) unchanged would label the preview build time "Updated", which is wrong. A preview needs its own Details content and must not show source repository or last committer from a production entry with the same path.
4. The PR link needs both `?group=pr:<n>` in the URL and a catalog group with the same id and head. Without the query (manual, or a hand-copied URL) there is no PR context even when the catalog knows one, and a catalog load failure silently removes the link instead of saying the PR could not be checked.
5. A fixed link opened after the manifest was removed shows "Preview unavailable" with no revision, no link to the published site, and only a back link to the preview list.
6. The preview list's rows pass the group id for manual groups while the CLI-produced manual URLs have no group; the two entry routes therefore return to different lists.
7. HTML previews convert in-frame navigation only for a changed or published document; other destinations stay raw inside the frame (see the HTML row).

## Acceptance criteria

- [ ] Record the audited entry paths and observed behavior, explicitly distinguishing already logical SPA URLs, raw-file URLs and an application preview page that lacks the shared reader shell.
- [ ] Claude presents and records a selected preview design after ISSUE-108, including metadata hierarchy, wide/narrow context access and PR/manual/old-revision examples.
- [ ] Standard review entries lead into the application reader, retain explicit preview identity and provide shared reading/context affordances. Raw opening, where retained, is a distinct secondary action.
- [ ] Available PR, revision, path, time and change-reason information is accurate and accessible; manual previews do not invent a PR, and stale catalog associations never mislabel a revision.
- [ ] Preview-list/group/revision deep links, heading links, shared URLs, refresh, browser history and modified-click/new-tab behavior work without silently switching review scope to production or another revision.
- [ ] Expired/missing content, optional/missing PR context, catalog failure and incompatible-format states have useful navigation/recovery; existing immutable content and trust/isolation boundaries are preserved.
- [ ] Applicable browser regressions cover HTML and Markdown, PR and manual previews, current and older revision entries, and the identified producer path if changed. Relevant checks and fresh cross-review pass before documentation screenshots/copy are finalized.

No fresh live preview reproduction or product test run is claimed by filing this issue. The user-reported direct-link symptom remains an investigation input, not an established universal raw-link bug.
