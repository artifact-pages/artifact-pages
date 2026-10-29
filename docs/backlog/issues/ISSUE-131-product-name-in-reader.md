# The reader still calls the product "Git Artifact Pages"

- Status: In progress
- Assignee: Claude
- Priority: P3
- Area: Web / branding

## Problem

The product is named Artifact Pages, but the reader app shows the old name: the browser tab title of the site list and of pages outside a site ("Git Artifact Pages"), the Open Graph `og:site_name`/`og:title`, the brand label with the mark "G" on the site list, error, 404 and crash screens, and messages such as "a format this version of Git Artifact Pages cannot read". Found in the ja docs review of 2026-10-29 (B3).

## Expected outcome

Everything a reader sees or a link preview shows says "Artifact Pages", with a matching mark.

## Acceptance criteria

- [x] `web/index.html` title and Open Graph tags, `APP_NAME`, every brand label and every user-visible message say "Artifact Pages"; the brand mark letter is "A".
- [x] localStorage keys (`git-artifact-pages:*`, `git-artifact-pages-theme`) are unchanged, so readers keep their pins, recent reads and theme.
- [x] Stories and tests updated; no user-visible "Git Artifact Pages" remains in `web/` outside storage keys and historical notes.
