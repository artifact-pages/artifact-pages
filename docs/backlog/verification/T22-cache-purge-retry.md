# T22 — Registry / app deploy cache purge retry

- Status: Done
- Scope: `registry register`, `registry unregister`, `app deploy` cache invalidation recovery
- Baseline evidence: [T21](T21-command-cost-audit.md), source baseline `2f9e41cf68161c1e3aa6642f3e018da036418213`
- Implementation source: `0707f2915dc86f25583819b28e1f29fa6fca6d7c`
- Product contract: [Specification](../../specification.md)

## Result

The registry and application deploy flows now retain cache invalidation intent across failures. Registry operations store a private cleanup record before changing the catalog or deleting site objects. Its cleanup-site set and invalidation-path set are independent: re-registering a site cancels its pending origin deletion but preserves every old URL until invalidation succeeds. A pending record is cleared only after cleanup and the full invalidation request succeed.

App deploy takes the fixed application lock before reading retry state or object metadata. It checks every bundle object on every invocation to preserve drift repair, writes a private `/index.html` retry record before changed object writes, writes the shell last, invalidates after object writes, and clears the record only after success. A cache-only retry checks the bundle again but does not rewrite application objects. Dry-run reports pending invalidation without taking a lock, writing a record or bundle object, deleting, or purging. Both retry records use conditional writes and fail closed on malformed, oversized, blank-ETag, unknown-schema, or out-of-scope data.

If clearing the app retry record reports failure after deletion may have persisted, the command conditionally restores it while holding the application lock. A later run may therefore issue one duplicate `/index.html` invalidation on this error path. This keeps recovery durable without claiming exactly-once purge behavior. If a successful lock acquisition write returns no ETag, the command stops before app reads or mutations; the persisted lock remains inspectable and requires guarded recovery.

## Reproduction and measurements

The pre-fix table in [T21](T21-command-cost-audit.md) is unchanged and records the failure. The same tagged fake probe after source commit `0707f291` reported:

| Scenario | Attempt that encounters purge failure | Same-input retry |
| --- | --- | --- |
| Add-only registry registration | GET 5, conditional PUT 5, invalidation attempt 1, error | GET 4, conditional PUT 2, invalidation attempt 1; returns `registered`, clears the retry record |
| Two-file app bundle | HEAD 2, aggregate S3 PUT 6, invalidation attempt 1, error | HEAD 2, aggregate S3 PUT 2, total invalidations 2; returns `deployed` without application-object PUTs |

These counts come from provider-neutral fakes wrapping the current adapters. Registry conditional-PUT and app S3-PUT totals include control records and locks; they are logical SDK calls, not wire-page, provider billing, or latency measurements. The app’s second-attempt application-object write count is asserted separately as zero. Raw tagged output is ignored at `.local/t21-audit/phase1-after.log` and can be regenerated with the command below.

Regression tests cover add-only and metadata-only registry invalidation intent, unregister cleanup followed by purge failure and re-registration, preservation of old paths through another failure and cache-only retry, journal write failure before origin mutation, malformed/incomplete record rejection, neighboring-site isolation, and dry-run behavior. App tests cover purge failure and cache-only retry, ambiguous intent write, partial object write followed by changed desired bytes, `index.html` write order, failure to clear/restore the retry record, malformed record fail-closed behavior, dry-run zero side effects, lock ownership/recovery, and a blank ETag returned by a persisted successful lock write.

## Validation

- `cd cli && go test ./...` — passed.
- `cd cli && go test -race ./internal/publisher ./internal/preview` — passed.
- `cd cli && go test -tags t21audit ./internal/publisher -run '^TestT21' -count=1 -v` — passed; post-fix retry observations above.
- `cd terraform/modules/aws && node --test deployment.test.js` — 6/6 passed. The test checks the exact admin retry-object permission; no new `ListBucket` or satellite permission was added.
- Independent Luna max review passed the registry/app/lock recovery diff and the successful-lock-CAS blank-ETag fix. The reviewer also ran focused recovery tests, publisher/CLI package tests, AWS policy tests, and `git diff --check` successfully.

No AWS or Cloudflare live write was performed for this verification. Provider claims are limited to local SDK fakes, adapter tests, and the Terraform policy test; request billing, edge propagation, and native-provider behavior were not measured.

## Reproduction

From repository root:

```sh
(cd cli && go test -tags t21audit ./internal/publisher -run '^TestT21' -count=1 -v)
(cd cli && go test ./...)
(cd cli && go test -race ./internal/publisher ./internal/preview)
(cd terraform/modules/aws && node --test deployment.test.js)
```
