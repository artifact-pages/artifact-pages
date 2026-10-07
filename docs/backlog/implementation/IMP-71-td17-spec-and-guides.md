# IMP-71 — Specification, TD2/TD14 amendments and operator upgrade guide for TD17

- Status: Open
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

- [ ] Spec, TD2, TD14 describe the implemented behavior; no pending pointers left.
- [ ] Guide page reviewed per the docs workflow.
