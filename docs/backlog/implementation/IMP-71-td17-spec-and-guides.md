# IMP-71 — Specification, TD2/TD14 amendments and operator upgrade guide for TD17

- Status: In progress
- Assignee: Claude
- Lanes: Docs / spec
- Owner: Claude
- Depends on: [TD17](../technical-design/TD17-config-pinned-component-versions.md)
- Sequenced with: IMP-68, IMP-69, IMP-70 (each behavior change merges with or after its spec text)
- Blocks: IMP-72

## Goal

Move TD17 into accepted behavior: specification §19 ("Released CLI", "Action repositories") and §22 (config keys, `app deploy`, checks, `--accept-breaking`), amend TD2 and TD14 in place, and add an operator guide page for pinning and upgrading versions.

## Scope

- Spec and TD text land together with, or just before, the slices that change behavior (IMP-68 to IMP-70); remove the "pending amendment" pointers then.
- Guide (docs repository): config pins, how sites follow, override, breaking upgrade order.

## Acceptance criteria

- [x] Spec, TD2, TD14 describe the implemented behavior; no pending pointers left (IMP-67 to IMP-70).
- [ ] Guide page reviewed per the docs workflow.

## Progress

- 2026-10-08: the specification, TD2 and TD14 describe the merged behavior of IMP-67, IMP-68 and IMP-69, with one narrow pointer each for the IMP-70 parts.
- 2026-10-09: the specification (§5.3, §19, §22), TD2, TD14, TD17 and the monorepo guides describe the IMP-70 behavior (bootstrap CLI, `release.json` schemaVersion 2, `cli-version` override); no pending pointers remain. This text merges before IMP-70 (PR #58). Remaining: the operator guide page in the docs repository.
