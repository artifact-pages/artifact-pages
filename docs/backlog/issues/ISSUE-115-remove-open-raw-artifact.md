# "Open raw artifact" adds a toolbar button and menu items readers do not need

- Status: In progress
- Assignee: Claude
- Priority: P3
- Area: Reader toolbar, More menu, command palette, sidebar row actions, preview Details

## Problem

Every document offers "Open raw artifact" (a toolbar button beside Copy link, the narrow-screen More menu, the command palette and the sidebar row actions), and a preview document's Details end with "Open the raw file". They open the published file on its own in a new tab. The owner sees no reason for readers to go there (2026-10-19): the reader already shows the page, and Details now links to the source file on GitHub (ISSUE-114). The extra button crowds the toolbar.

## Evidence and reproduction

1. Open any document at 1280 px: the toolbar shows All sites, site home, Pin, Copy link and an external-link button titled "Open raw artifact" (owner screenshot, 2026-10-19).
2. The same action is in the More menu (≤620 px), the command palette and each sidebar row's actions menu; preview Details show "Open the raw file" with its caption.

## Expected outcome

The reader offers no action that opens the raw published or preview file. Reading, source and history links are unaffected.

## Acceptance criteria

- [ ] No "Open raw artifact" toolbar button, More menu item, command palette command or sidebar row action exists, on documents, directory pages and the not-found view.
- [ ] Preview Details no longer show "Open the raw file" or its caption; the rest of the preview Details order is unchanged.
- [ ] Raw file URLs that the reader itself needs (HTML frames, preview frames, Markdown fetches) keep working; only the user-facing actions go. Code that only served those actions is removed.
- [ ] `docs/specification.md` no longer lists the action (More menu list, sidebar row actions and the "raw/source/history actions" sentence, the directory-page sentence, preview Details); historical backlog items are left as they are.
- [ ] Unit, e2e and story coverage updated; verify and e2e pass.
