# IMP-33 — Cloudflare application and content deployment reference

- Status: Done
- Phase: Provider-backed deployment
- Depends on: settled delivery, route, cache, and retention mappings in [T12](../technical-design/T12-cloudflare-production-mapping.md); [IMP-31](IMP-31-app-distribution.md); [IMP-32](IMP-32-cloudflare-production-adapter.md). Viewer access, if desired, is configured independently by the operator at the edge.
- Proves: Terraform source/plan and provider deployment contract; deployed delivery is [T15](../verification/T15-provider-delivery.md), clean-room distribution is [T16](../verification/T16-external-adoption.md)

## Outcome

Provide and locally validate the Cloudflare delivery configuration for the application and content planes. The deployment must keep the published route, reserved-key, cache, and retention contracts, while satellites receive only the R2 credentials appropriate to their registered site.

## Acceptance criteria

- [x] Provide an operator guide and Cloudflare deployment config example that keep credential values outside source control and distinguish the Terraform API token, R2 S3 credentials, and runtime zone purge token.
- [x] Provide a Terraform reference for a custom R2 domain, disabled `r2.dev` domain, logical-route rewrites, reserved object paths, `/_control` denial, and origin-respecting cache rules.
- [x] Compose delivery and preview-retention modules against the same existing bucket; validate that the Terraform retention input is positive, integral, bounded, and independent of the publisher CLI config.
- [x] Support separate read-only R2 access to the deployed registry object and read/write access to the satellite's exact index, artifact, preview, and site-lock keys, without distributing the parent R2 secret.
- [x] Keep provider-specific object and purge behavior behind the existing adapter boundaries; no request-time backend was added to emulate S3.

## Local evidence

`docs/guides/cloudflare-deployment.md`, `examples/cloudflare/deployment.yaml.example`, and `examples/cloudflare/terraform/` show the admin/satellite command contract and provider delivery setup. `infra/cloudflare/delivery/` manages a new R2 custom domain (or leaves an existing connection to explicit operator management), disables `r2.dev`, rewrites logical routes, preserves reserved object paths, blocks the private `/_control` keyspace, and lets published `Cache-Control` values govern edge/browser caching. The example caller composes it with `infra/cloudflare/retention/` against the same bucket and configures the Terraform-only `preview_retention_days` input. The module docs state that it owns complete zone phase-root rulesets and warn operators to import and preserve existing rules before apply.

Cloudflare config accepts a separate `registryReader*` credential set. When configured, `cloudflareBackend.GetObject("_indexes/sites.json")` uses that identity while all writes and every other object request keep using the site/admin R2 identity. `TestCloudflareRegistryReadUsesSeparateReadOnlyIdentity` verifies the registry GET and a site-index GET use distinct SigV4 identities, and a registry PUT continues to use the writer. The example scopes the reader to the exact `_indexes/sites.json` object and the satellite writer to its site prefixes plus exact site lock; no parent credential is placed in the example.

Terraform 1.9.8 ran recursive formatting, `init -backend=false -input=false -lockfile=readonly`, `validate`, and `plan -refresh=false -input=false -var-file=terraform.tfvars.example` for the composed caller with sample IDs and an offline placeholder token. The no-refresh plan contained six additions, no changes, and no destructions; it did not refresh state or apply to an account. Separate no-refresh plans rejected `preview_retention_days=0` and `preview_retention_days=1.5`. Terraform warned that the managed-domain and lifecycle resources cannot be destroyed, which is documented by their modules. `npm run test:provider-delivery` passed 17 AWS/Cloudflare source tests, including seven Cloudflare checks for domain/r2.dev, decoded reserved routes, control denial, origin cache policy, ruleset preservation, retention composition, and credential-variable examples. `go test -race -count=1 ./internal/config`, `go test -race -count=1 ./internal/publisher -run '^TestCloudflareRegistryReadUsesSeparateReadOnlyIdentity$'`, and `go test -race -count=1 ./cmd/artifact-pages` passed.

`EDGE_PROFILE_STATE_ROOT=.local/edge-profiles-imp33-cloudflare-20260928 EDGE_PORT=8307 MINIO_PORT=19175 CF_API_PORT=18975 node scripts/run-edge-profile.mjs cloudflare` passed the Cloudflare local profile: app deployment, two-site publish, registry registration/unregister, exact purge paths, preserved neighboring-site data, and 55/55 Playwright browser cases. Site publish ran without `CF_API_TOKEN`. This is same-checkout MinIO/purge-mock conformance and does not establish real R2 or deployed-edge behavior. The Cloudflare modules and local profile have not been applied to or smoke-tested against a live account; external deployed routes, cache, control, retention, and purge evidence remain in T15, and clean external admin/satellite adoption remains in T16. Any operator-configured Access policy is verified separately by that operator.

## Verification handoff

- [T15](../verification/T15-provider-delivery.md) owns actual Cloudflare custom-domain routing, reserved-key 404s, edge/browser cache headers, `r2.dev` disablement, control-object isolation, retention timing, and purge propagation.
- [T16](../verification/T16-external-adoption.md) owns applying the reference from clean admin and satellite repositories with pinned published components and distinct least-privilege R2 credentials, plus app upgrade/rollback.
