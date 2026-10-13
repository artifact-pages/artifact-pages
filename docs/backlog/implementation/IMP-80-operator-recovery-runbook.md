# IMP-80 — Operator recovery runbook

- Status: In review
- Assignee: Claude
- Lanes: Documentation (primary), CLI and operations (technical review)
- Owner: Claude (prose); Codex reviews technical accuracy
- Depends on: —
- Source: public-launch review 2026-10-13, section 5 (operations and recovery table)

## Goal

An operator who is not the author can recover a Cloudflare-first deployment from the common failures using only a published runbook. The public-launch review found strong recovery mechanisms (Git as source of truth, per-site locks, conditional writes, retry journal, publication order, `--reconcile`) but no operator-facing procedure that ties them together and no record that each was exercised.

## Scope

Add `docs/guides/operator-recovery.md` and link it from `docs/guides/cloudflare-deployment.md`. Cover these scenarios:

1. Web upgrade and rollback: warm browsers, lazy chunks requested by old tabs (old hashed assets are kept on purpose by `app deploy`), site bytes left untouched, the compatibility check.
2. Interrupted publish and failed cache purge: a retry converges; neighbouring sites and private control objects are not touched.
3. Source/projection drift: `--reconcile`, regeneration from Git, reproducibility of generated inputs, checking the target prefix.
4. A stale lock: telling a stale lock from a running operation, recovery with the observed ETag, avoiding a double operation.
5. Credential and GitHub App key rotation: which repositories and environments, the update order, revoking the old values, the smallest operation that verifies the new ones.
6. Terraform remote state restore, and importing or merging existing zone rules.
7. Detection: link to the production health check, which, together with ownership of CI, release and publish failure notifications, is tracked in the workspace ops item OPS-006.

## Acceptance criteria

- [x] `docs/guides/operator-recovery.md` exists, covers the seven scenarios, and is linked from `docs/guides/cloudflare-deployment.md`.
- [ ] Every command shown exists in the current CLI (verified with `--help` or the source), and Codex has reviewed the technical accuracy.
- [x] Each scenario is either exercised once on `artifact-pages.stream` with the result noted, or marked "not yet exercised".

## Progress

- 2026-10-14 (Claude): runbook drafted in `docs/guides/operator-recovery.md` and linked from the Cloudflare deployment guide and `docs/README.md`. All seven scenarios are marked "not yet exercised". Codex technical review (criterion 2) is pending.
