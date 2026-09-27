# IMP-10 — Contextual PR return link

- Status: Done
- Phase: Phase 1 local preview product
- Depends on: [IMP-04](IMP-04-pr-provenance.md), [IMP-08](IMP-08-preview-reader.md), [IMP-09](IMP-09-discovery.md)
- Proves: [T4](../verification/T4-serving-boundary.md), [T6](../verification/T6-resources-navigation.md)

## Outcome

Carry PR-group view context in every PR-associated revision-specific document URL and preserve it across changed-document navigation. Show a subtle PR-number link in the application header only after the site catalog confirms that the explicitly PR-associated group still points at the route's head SHA.

## Evidence

Playwright verifies contextual PR links through HTML and Markdown documents, query/fragment-preserving changed-document navigation, a manual group, and two PR groups sharing one head SHA. Direct bare URLs render without catalog membership. Browser coverage now confirms a group advance or removal hides its PR link while the fixed revision still renders, and a sibling PR group still links to its own PR.

## Acceptance criteria

- PR → preview artifact → PR works on every changed document and after intra-preview navigation; production navigation drops preview context.
- Bare fixed URL, manual preview, mismatched/missing group or unavailable catalog still renders from a valid revision manifest without a PR link.
- Two groups sharing one head cannot cause a wrong PR link; group context changes neither route identity nor artifact bytes.
- E2E covers direct load/reload, group advance and catalog removal; document H1 and iframe content remain untouched.
