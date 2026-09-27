# IMP-04 — Explicit PR provenance and group identity

- Status: Done
- Phase: Phase 1 local preview contract
- Depends on: [IMP-01](IMP-01-preview-records.md); [T1](../technical-design/T1-preview-record-contract.md) defines group representation, [T2](../technical-design/T2-cli-action-interface.md) defines public input.
- Proves: [T5](../verification/T5-concurrency-recovery.md)

## Outcome

Normalize an explicitly supplied PR number or URL to a canonical source-repository PR reference and PR-scoped group. No PR input creates a manual head-SHA group. Never infer provenance from branch, commit or CI event.

## Evidence

Go integration cases accept an explicit same-repository PR only when the PR URL, source repository, head repository, and selected full head SHA match; they reject wrong-repository, fork-origin, and mismatched-head inputs. Catalog fixtures and Playwright show two PR groups and a manual group on one head SHA without cross-attribution.

## Acceptance criteria

- Reject wrong-repository, fork-origin, malformed and head-mismatched PR references before publication or provider credentials are used.
- Distinct PR groups may point to the same head SHA without cross-attribution; manual and PR group IDs cannot collide.
- Record the validated canonical PR link on the discovery group, not by mutating an existing immutable revision manifest.
- Tests cover explicit PR and manual inputs plus validation failures; exact CLI/Action spelling remains T2's decision.
