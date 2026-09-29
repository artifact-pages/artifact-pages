# T12 — Cloudflare production deployment mapping

- Status: Done
- Phase: Provider-backed deployment

## Design question

Which Cloudflare storage, conditional-write/lock, static delivery, cache, and deployment services satisfy the same production contract as the AWS adapter?

## Selected mapping

### Origin storage and coordination

- Use one private R2 bucket through its S3-compatible endpoint, `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, with region `auto`. The CLI uses R2 for origin reads, metadata reads, writes, conditional lock changes, complete `ListObjectsV2` pagination, and batched deletion. These operations remain behind the shared `DeploymentBackend` and `ConditionalObjectBackend`; site and registry reconciliation do not branch on the provider.
- R2 supports `PutObject` `If-None-Match` and `If-Match`, `HeadObject`, `GetObject`, and `ListObjectsV2` in its compatibility table. Treat this as API-surface support, not proof of race behavior. R2-specific conditional races are still a release gate.
- Cloudflare's Terraform provider cannot import an existing R2 custom-domain resource. The deployment module supports creating a new domain; when a hostname is already connected, Terraform manages the edge rules while the operator verifies the existing domain separately. The module leaves the alternate `r2.dev` setting unmanaged: Cloudflare keeps it disabled by default on a newly created private bucket, so the module does not create a non-destroyable managed-domain resource just to restate that default. For an adopted existing bucket, the operator must separately verify and disable `r2.dev`; otherwise it bypasses custom-host rewrite rules.
- Use the same R2 bucket for `_indexes`, `_artifacts`, `_previews`, and private `_control` coordination keys. Explicit app and content paths retain their origin behavior; every unmatched path, including `/_control/*`, rewrites to `/index.html`. That prevents the control object key from reaching the origin without a separate WAF/firewall block. Do not enable the alternate `r2.dev` development URL for production; it would provide another route to bucket contents.

### Public delivery, routes, and cache

- Connect the public hostname to the bucket as an R2 custom domain in the same Cloudflare zone. The custom domain is `publicBaseURL`; CLI origin operations continue to use the S3 endpoint directly.
- Add a Cloudflare URL Rewrite Rule for logical application routes so `/sre` and `/sre/...` fetch the origin object `/index.html` while the browser retains its logical URL. Preserve `/index.html`, `/preview-bridge.js`, `/assets/*`, `/_indexes/*`, `/_artifacts/*`, and `/_previews/*` as explicit application/content paths; every other path rewrites to `/index.html`. Missing objects under the explicit content paths return the origin's 404 response. This fallback also rewrites `/_control/*` to the app shell, so the private control object path is never requested from R2 and no WAF Custom Rule is required for that boundary. Normalize paths consistently for route and cache matching.
- R2 custom domains cache only selected file types by default. Configure a Cache Rule that makes the static projection eligible and respects the object's `Cache-Control` metadata. Preserve browser revalidation on mutable paths, no more than 60 seconds of shared-cache freshness for indexes and metadata, no more than 300 seconds for artifacts, and one year with `immutable` for content-hashed application assets. Do not override these origin bounds with a longer edge TTL.
- An operator may separately configure Cloudflare Access or another edge/network policy for the hostname or selected paths. This is customer-managed and outside the Artifact Pages application, registry, and publisher contract; this mapping does not provision identities or per-site permissions.

### Cache invalidation and credentials

- Use the zone cache purge API for exact public URLs and URL prefixes. Convert a logical path to the configured HTTPS origin; send exact resources in `files` and directory invalidations in `prefixes`. Batch at 100 entries per request. Cloudflare also limits URL-prefix depth and rate; internal unregister paths are shallow site prefixes, but the adapter must fail clearly if provider limits or rate limits reject a purge. Do not purge on every site publish: mutable content already has a bounded five-minute freshness limit.
- Keep the primary R2 credentials separate from the zone API token. A normal setup can start with `CF_R2_ACCESS_KEY_ID` and `CF_R2_SECRET_ACCESS_KEY`; neither `CF_API_TOKEN` nor registry-reader credentials are needed for site or preview publication. `app deploy` and registry changes require `CF_API_TOKEN` only when they will send a cache invalidation request; dry-runs and no-op operations do not. The CLI checks that the token is configured before changing application or registry objects.
- Registry-reader credentials are an optional delegated-publisher capability. For a satellite, use two short-lived R2 temporary credentials with different permissions: a read-only credential scoped only to the exact `/_indexes/sites.json` object, and a read/write credential scoped only to that site's `/_indexes/<site>/`, `/_artifacts/<site>/`, `/_previews/<site>/`, and exact `/_control/locks/sites/<site>.json` keys. Configure `registryReaderAccessKeyIdEnv`, `registryReaderSecretAccessKeyEnv`, and optional `registryReaderSessionTokenEnv` only in that publisher's deployment config; only its `site publish` and `preview publish` commands use and require those values. With no reader fields configured, these publishers read the registry using the primary credential. Admin registry operations always use the primary identity. Do not include the registry object in the satellite's writer credential. The CLI does not mint or renew either credential; a trusted operator or credential broker must issue them and keep the parent R2 secret out of satellite repositories and jobs. Command-level registry eligibility is not an IAM boundary.

### Relationship to T9 and proof boundary

T9 selects R2 and the shared object/conditional-write contract for `PreviewStore`. Production reuses that adapter boundary but adds normal site-prefix reconciliation, registry serialization, app-plane writes, unregister cleanup, and Cloudflare zone purging. Preview-only tests do not establish production publish or delivery behavior.

## Exit criteria

- [x] Select R2, the custom-domain edge, cache purge, and optional Cloudflare Access for the production mapping.
- [x] Identify the explicit application/content paths, catch-all app-shell rewrite (including `_control`), origin missing-object responses, cache bounds, and credential separation needed at deployment time.
- [x] Reuse T9's provider-neutral object and conditional-write boundary without treating preview-only evidence as production proof.
- [x] Keep optional viewer-access configuration customer-managed and separate from the static delivery and publisher contract.

Live evidence is tracked separately from this design decision: [T5](../verification/T5-concurrency-recovery.md) owns provider lock and immutable-write races; [T8](../verification/T8-stale-reference-cleanup.md) owns provider-origin preview cleanup; [T14](../verification/T14-production-reconciliation.md) owns production reconciliation and recovery; and [T15](../verification/T15-provider-delivery.md) owns deployed routes, cache, and purge propagation. Operator-managed Access configuration is outside the product verification contract.

## Evidence and limitations

`internal/publisher/cloudflare.go` delegates object operations to `s3CompatibleBackend` and keeps zone purge calls in the Cloudflare adapter. The optional R2 session-token fields support externally minted scoped credentials for the writer and registry reader. Focused adapter tests and the Cloudflare MinIO/purge-mock profile exercise the local request shape, compare-and-swap race, pagination, deletion, cache-path translation, and app/site/registry operations. They do not prove Cloudflare R2 concurrency behavior, public custom-domain routing/cache policy, or purge propagation; those checks remain in the linked verification items. This technical mapping is complete; deployed proof remains in T14/T15, and any Cloudflare Access policy remains operator-managed.

Official references: [R2 S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/), [R2 temporary credentials](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/), [R2 public buckets and custom domains](https://developers.cloudflare.com/r2/buckets/public-buckets/), [R2 custom-domain URL rewriting](https://developers.cloudflare.com/rules/origin-rules/tutorials/point-to-r2-bucket-with-custom-domain/), [Terraform custom-domain resource](https://registry.terraform.io/providers/cloudflare/cloudflare/5.24.0/docs/resources/r2_custom_domain), [Rules language `url_decode`](https://developers.cloudflare.com/ruleset-engine/rules-language/functions/), [URL normalization](https://developers.cloudflare.com/rules/normalization/how-it-works/), [Cloudflare purge limits](https://developers.cloudflare.com/cache/how-to/purge-cache/), [purge by URL prefix](https://developers.cloudflare.com/cache/how-to/purge-cache/purge_by_prefix/), and [Access authorization cookies](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/).
