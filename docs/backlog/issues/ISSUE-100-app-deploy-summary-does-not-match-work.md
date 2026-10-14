# The app deploy change summary does not match the files written

- Status: Done
- Assignee: Codex
- Priority: P3
- Area: CLI
- Implementer: Codex
- Source: cold-start trial A, 2026-10-14

## Problem

A real `app deploy` prints a change summary that disagrees with the work it reports. An operator cannot tell from the text what the deploy changed.

## Evidence and reproduction

1. Run a real `app deploy` of web 0.3.2 on a new bucket. Observed: the summary says "+0 create ..." while the command reports "Deployed 102 files".
2. Redeploy. Observed: the same "+0 create ..." with "Deployed 22 files".
3. Roll back from web 0.3.2 to 0.3.1. Observed: "0 remove", although 80 hashed assets differ between the two bundles. Old assets are kept on purpose, so "0 remove" may be correct. The create count is the wrong part.

## Expected outcome

The text summary of a real deploy matches the files written: the create count reflects the files created, and the remove count reflects what is removed (zero is acceptable when old assets are kept by design).

## Acceptance criteria

- [x] After a real `app deploy`, the create count in the summary matches the files newly written.
- [x] The remove count is documented or explained in the output when old assets are kept.
- [x] A test covers the summary for a first deploy, a redeploy and a version change.

## Resolution

Successful real deploys now report the same create and update entries as dry runs; unchanged redeploys keep an empty change list, and error results do not receive the plan. App deploy never deletes application objects; old hashed assets are retained on purpose, so `0 remove` is correct.
