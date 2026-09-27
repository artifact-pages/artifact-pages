# Small sites repeat the same artifacts in several lists

- Status: Done
- Priority: P3
- Area: Site home and sidebar information hierarchy

## Problem

For sites with only a few artifacts, most or all items appear in both “Recently updated” and “Browse.” Pinning a recent artifact adds a third copy in the sidebar. This lengthens navigation without adding much choice or context.

## Evidence and reproduction

1. Open `/sre`, which has six artifacts. The site home lists all six under “Recently updated” and again under “Browse.”
2. Pin “Latency Retrospective” from its sidebar actions.
3. The same item is visible under “Recently updated,” “Pinned,” and “Browse” in the sidebar.

## Expected outcome

Each section contributes a clear reason to exist, while a small site's entire inventory remains easy to scan.

## Acceptance criteria

- [x] Sites with six or fewer artifacts do not show a Recently updated list that repeats the full inventory.
- [x] On small sites, Pinned remains available while the redundant Recently updated section is absent.
- [x] Sites with seven or more artifacts keep a usable Recently updated view and a complete Browse path.

## Verification

- `npm run build`
- Playwright: small-site home and sidebar, larger-site Recent and Browse, and pinned-versus-Browse copies
- Full Playwright suite: 34 tests passed
- Visual check in the in-app browser at `/sre`
