# IMP-79 — Legacy site control records rebuild automatically

- Status: In progress
- Assignee: Codex
- Priority: P1

## Goal

`site sync` must recover safely when a site's private publish-state or cache-retry record uses one of the known older prerelease shapes, without asking the operator to delete control records manually.

## Evidence

- On 2026-10-12, the verification bucket's `verify-scale-100`, `verify-scale-1000`, `verify-scale-5000`, and `verify-scale-10000` publish-state records lacked the committed generation and blocked both `site sync` and `app deploy`.
- The owner requires the CLI to lead the recovery instead of asking for a manual workaround.

## Scope

- Classify only the existing known legacy publish-state and cache-retry shapes, preserving fail-closed behavior for all other invalid records.
- Rebuild legacy publish-state from a locked origin inventory, save its exact bytes under the site's `legacy/` prefix, and commit the new state with the original ETag condition.
- Adopt valid legacy cache-retry paths, save the exact record, and use the existing retry-record compare-and-swap flow.
- Report recovery in text and JSON output, return recovery guidance for unfinished retries, treat legacy state as unavailable to the prior-state loader, and update the `app deploy` republish hints.

## Acceptance criteria

- [ ] Known legacy shapes wrap `errSiteControlLegacyFormat` and retain the record and detail; other validation failures remain fail-closed.
- [ ] Legacy publish-state rebuilds from a full origin inventory, never uses the fast path, uses a deterministic legacy generation, backs up exact bytes and metadata before origin writes, and replaces state with an `If-Match` on the legacy ETag.
- [ ] Identical pre-existing backups are accepted; conflicting backup bytes fail before origin writes. Active retry transactions return the specified unfinished-cache-retry error.
- [ ] A valid legacy cache-retry record without a site field is adopted with its paths revalidated, backed up, and updated through the existing ETag condition. Invalid paths return the specified unfinished-cache-retry error.
- [ ] Dry runs write nothing and report planned legacy recovery. Text output includes the specified publish-state and cache-retry lines; JSON includes optional `legacyControl` details.
- [ ] The prior-state loader returns `(nil, nil)` for legacy state, and `app deploy` uses the specified per-site republish hints while leaving registry failures unchanged.
- [ ] Corrupt, oversized, unsupported-schema, and otherwise invalid records still fail closed; tests cover reconciliation, backup conflicts, CAS races, retry handling, and output.

## Verification

- `gofmt -l cli` printed nothing.
- `GOCACHE=$PWD/.local/go-cache go vet ./cli/...` passed.
- Focused publisher tests covering legacy publish-state rebuilds, GET-only mode, dry-run reporting, CAS races, backup conflicts, unfinished retries, cache-retry adoption, prior-state loading, strict state validation, and compatibility hints passed.
- Focused `cli/cmd/artifact-pages` tests covering the legacy text lines and optional JSON result field passed.
- `GOCACHE=$PWD/.local/go-cache go test ./cli/...` could not complete in this sandbox: existing tests using `httptest` panic because listening on `[::1]:0` is denied (`operation not permitted`). The observed cases were `TestNewDeploymentBackendWiresCloudflareRegistryReaderEnvironment`, `TestBootstrapRemoteUsesPrivateConfigTokenForConfigOnly`, `TestPullRequestResolverAcceptsExplicitNumberOrCanonicalURL`, and `TestDeployAppDownloadsPublishedVersionOverHTTPS`.
