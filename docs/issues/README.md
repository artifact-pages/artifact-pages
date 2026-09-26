# Product issues

Each file records one independently actionable problem. New issues start as `Open`; update the issue file and this index when the status or priority changes. Use [_template.md](_template.md) for new issues.

## Status

| Value | Meaning |
| --- | --- |
| `Open` | Ready to investigate or implement. |
| `In progress` | Work is underway. |
| `Blocked` | Progress needs a decision or dependency. |
| `Done` | Acceptance criteria have been verified. |
| `Won't fix` | The team has decided not to pursue the issue; record why in the issue. |

## Priority

| Value | Meaning |
| --- | --- |
| `P0` | Blocks the core experience for most users; address immediately. |
| `P1` | Materially disrupts a core workflow or breaks navigation. |
| `P2` | Causes repeated confusion or a meaningful usability problem. |
| `P3` | Localized polish or a lower-impact improvement. |

Priority describes user impact, not implementation effort. Issues 001–011 came from a desktop and 390 px mobile review of the local browser product; issue 012 captures a proposed interaction from user-supplied screenshots. Reconfirm visual findings after design changes.

## Issue index

| Issue | Status | Priority |
| --- | --- | --- |
| [001 — Mobile navigation covers content after reload](001-mobile-navigation-on-reload.md) | Done | P1 |
| [002 — HTML heading navigation creates inconsistent back history](002-iframe-heading-history.md) | Done | P1 |
| [003 — Independent searches leave contradictory result states](003-search-state-confusion.md) | Done | P1 |
| [004 — Secondary text and controls lack contrast](004-secondary-contrast.md) | Done | P2 |
| [005 — Artifact title and route to site home are hard to find](005-artifact-orientation.md) | Done | P2 |
| [006 — Unknown-site error exposes an internal storage path](006-unknown-site-error.md) | Done | P2 |
| [007 — Site switcher initially selects another site](007-site-switcher-default.md) | Done | P2 |
| [008 — Small sites repeat the same artifacts in several lists](008-duplicate-artifact-listing.md) | Done | P3 |
| [009 — Index date appears older than artifact update dates](009-index-date-meaning.md) | Done | P3 |
| [010 — Mobile search advertises a desktop shortcut](010-mobile-search-hint.md) | Done | P3 |
| [011 — Wide Markdown tables need an overflow cue](011-markdown-table-overflow.md) | Open | P3 |
| [012 — Browse sibling artifacts from path breadcrumbs](012-breadcrumb-sibling-navigation.md) | Done | P2 |
