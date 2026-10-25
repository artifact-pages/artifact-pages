# IMP-86 — Compact reading context and on-demand Details

- Status: Done
- Assignee: Codex
- Scope: UI/UX S4

## Accepted outcome

The wide column shows compact Updated + Details above persistent Contents. Author/source details open on demand; Details works at every width with predictable open/close focus. Preview shows Built (with named zone/UTC metadata), never a production Updated/author. Narrow metadata stays in Details. No metadata is injected into HTML content.

## Verification

Production build, 276 web units, Storybook build and full 350/350 browser regression passed. Fresh Sonnet 5.5 medium cross review and final test re-review found no actionable P0–P2. Real IAB verified Details/Close/Escape focus and compact context. UI/UX review evidence: S4-IMPLEMENTATION.md and S4-REVIEW.md in the workspace review directory. No release/deploy.
