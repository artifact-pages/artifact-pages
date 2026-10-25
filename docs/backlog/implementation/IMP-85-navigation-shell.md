# IMP-85 — Stable navigation shell

- Status: In progress
- Assignee: Codex
- Scope: UI/UX S3

## Accepted outcome

One-row header with permanent Search and direct narrow Contents. Site home / Switch site… / All sites move into the current-site menu. Sidebar replaces its filter with the palette, folds Pinned above Browse, removes Index generated and retains theme. Narrow breadcrumbs prioritize the current page with a hierarchy menu. Wide breadcrumbs and folder-name/arrow separation remain.

## Verification

Node 24.18.0: build, 276 web units, Storybook build and full nginx/Chromium E2E 345/345 pass. Focused keyboard/responsive/tree checks: 13/13. Manual 390px browser check confirms the one-row header and Page hierarchy menu. Tests cover 390/768/1280/1440px with long titles, keyboard site menu, folding pins, preserved tree alignment and direct Contents focus restore.

The obsolete tree-filter tests now exercise the palette hand-off without filtering Browse; section-search tests target the permanent header, and mobile breadcrumb tests cover hierarchy navigation. Ordinary file/folder links and modified clicks remain covered. Independent Sonnet medium read-only review is running against the staged product diff. Stacked on S2. No release/deploy.
