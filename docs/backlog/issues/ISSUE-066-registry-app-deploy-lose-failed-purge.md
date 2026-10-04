# Registry register and app deploy forget a failed cache purge

- Status: Open
- Priority: P2
- Area: CLI registry register, app deploy

## Problem

When the cache purge fails after the origin write, `registry register` and `app deploy` report `failed`, but nothing records the pending invalidation. Rerunning the same command returns `no-op` and never purges. The edge may keep serving the previous `sites.json` or application shell until the cache expires. `site publish` already records a cache retry and converges on the next run, as the specification requires.

## Evidence and reproduction

Verification environment, 2026-10-03:

1. The CLI token lacked Cache Purge. `registry register` returned `registry updated; cache revalidation failed … HTTP 401`. `app deploy` and `site publish --fulltext` failed the same way after writing.
2. After the permission was fixed, `registry register` returned `no-op` with no changes, and `app deploy` returned `no-op` with no changes. Neither issued an invalidation.
3. `site publish` returned `published` with zero object changes. It completed its recorded cache retry.

Code: in `cli/internal/publisher/registry_apply.go`, `catalogInvalidationPending` comes only from `registryChanged` or a cleanup record. An add-only change writes no record before `backend.Invalidate`, so a failed purge leaves nothing to retry.

Additional reproducible local fake evidence is recorded in [T21](../verification/T21-command-cost-audit.md); the audit does not change this issue's status or acceptance criteria.

## Expected outcome

A failed purge after a successful origin write is retried on the next run of the same command, as `site publish` does.

## Acceptance criteria

- [ ] `registry register`, `registry unregister` and `app deploy` persist a cache retry record before purging, retry it on the next run and clear it after success. Dry-run plans the retry.
- [ ] Regression tests inject a purge failure, rerun, and assert the retried invalidation and the cleared record.
