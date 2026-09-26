# Small sites repeat the same artifacts in several lists

- Status: Open
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

- [ ] Small-site layouts avoid repeating the full inventory in multiple adjacent sections without added context.
- [ ] Pinned artifacts are easy to find without visually dominating the sidebar through repeated copies.
- [ ] Larger sites still provide a usable recent-items view and complete browse path.
