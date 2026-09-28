# T13 — Registered admin and satellite flow

- Status: Done
- Phase: Provider-backed deployment

## Proof needed

- [x] Validate strict YAML → sorted registry JSON, including malformed and empty registries.
- [x] In separate admin and satellite checkouts, apply, publish, browse, update, and unregister one site while another stays intact.
- [x] Confirm the satellite reads the configured backend registry after acquiring its site lock; no admin YAML checkout is needed.
- [x] Exercise dry-run with zero backend writes, plus registration mismatch and direct-link/reload behavior.

## Evidence

`internal/registry/registry_test.go` verifies sorted deterministic JSON, an empty projection, and malformed/duplicate YAML and JSON. `TestPublishSiteUsesOriginRegistryAfterSiteLockAndIgnoresBranch` verifies the publisher acquires the site lock before reading the configured registry; CLI tests cover an unregistered site and prove no artifact/index writes occur. `npm run test:registered-flow` passed on 2026-09-27: it created separate admin and satellite Git checkouts, verified read-only dry-runs, published two sites, updated and removed stale content, served deep links and relative HTML/Markdown assets through nginx, then unregistered one site while preserving the neighbor's artifacts, indexes, and preview revisions. The dedicated browser case passed 1/1. `go test -race -count=1 ./...` passed. These results prove the local configured-backend flow; real AWS/Cloudflare provider behavior remains tracked separately in [T14](T14-production-reconciliation.md) and [T15](T15-provider-delivery.md).

After ISSUE-017, `npm run test:registered-flow` passed again on 2026-09-28. Before publishing SRE, the runner serves the actual registry and the neighbor site's published projection, then verifies in a browser that SRE remains listed as registered but unpublished and that the neighbor remains searchable and usable. It publishes SRE, applies an update, and verifies discovery and navigation against the newly published metadata/index. This remains a local configured-backend proof; provider behavior is unchanged.
