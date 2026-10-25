# IMP-87 — Read folder introductions directly

- Status: Done
- Assignee: Codex
- Scope: UI/UX S5

## Accepted outcome

Non-root folders with an introduction use the normal HTML/Markdown reader with Contents and Details, without duplicate folder metadata/children. Folder URLs, links, search highlights, history and index identity are preserved. Site home and folders without introductions keep their existing purposes. No Read next is appended.

## Verification

Build and 276 web units passed. Full browser regression: 349/350; the single new pin assertion used the wrong role, corrected to its real button role and focused rerun passed 1/1. Previous folder/root subset passed 52 cases; final CI runs all browser cases again. Fresh Sonnet 5.5 medium independent review: no actionable P0–P2. Real IAB confirmed folder URL, native HTML reader and Contents fragment navigation (s5-folder-reader.png in workspace review evidence). No release/deploy.
