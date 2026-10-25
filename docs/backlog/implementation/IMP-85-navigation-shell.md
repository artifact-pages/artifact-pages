# IMP-85 — Stable navigation shell

- Status: Done
- Assignee: Codex
- Scope: UI/UX S3

## Accepted outcome

One-row header with permanent Search and direct narrow Contents. Site home / Switch site… / All sites move into the current-site menu. Sidebar replaces its filter with the palette, folds Pinned above Browse, removes Index generated and retains theme. Narrow breadcrumbs prioritize the current page with a hierarchy menu. Wide breadcrumbs and folder-name/arrow separation remain.

## Verification

Node 24.18.0: build, 276 web units, Storybook build and full final-source nginx/Chromium E2E 348/348 pass. Focused keyboard/responsive/tree checks: 13/13. Manual 390px browser check confirms the one-row header and Page hierarchy menu. Tests cover 390/768/1280/1440px with long titles, keyboard site menu, folding pins, preserved tree alignment and direct Contents focus restore.

The obsolete tree-filter tests now exercise the palette hand-off without filtering Browse; section-search tests target the permanent header, and mobile breadcrumb tests cover hierarchy navigation. Ordinary file/folder links and modified clicks remain covered. Fresh independent Sonnet 5.5 medium review found two P2 issues (Search label-in-name and stale menu state after drawer/navigation changes). Both were fixed in d3a74020, covered by new href/keyboard/dismissal tests, and the same reviewer rechecked the fixes with no remaining actionable defects. S1 and S2 are merged; main was merged without any change to the tested web source. No release/deploy.
