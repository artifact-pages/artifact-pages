# IMP-25 — Reconcile a site's production projection

- Status: Open
- Phase: Provider-backed deployment
- Depends on: [IMP-22](IMP-22-site-locks.md), [IMP-24](IMP-24-publisher-eligibility.md)
- Proves: failure/retry, pagination and content-type tests; [T5](../verification/T5-concurrency-recovery.md)

## Outcome

Synchronize the selected source tree and generated index/meta into only that site's content prefixes, converging on retry.

## Acceptance criteria

- Accept only regular files/directories inside `sourcePath`; fail on symlinks or special entries; omit `.git`; preserve bytes and relative names without bundling or rewriting.
- Complete all required prefix listings before deletion; handle continuation pages, bounded delete batches and per-object failures.
- Upload new/changed artifact bytes first, then `index.json`, then `meta.json`, then remove stale artifact objects; never touch the registry, app plane, control objects or other sites.
- Assign browser-correct MIME/disposition/encoding metadata; interrupted runs and partial deletes fail visibly and converge on retry.
