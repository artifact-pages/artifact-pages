# T12 — Cloudflare production deployment mapping

- Status: Open
- Phase: Provider-backed deployment

## Design question

Which Cloudflare storage, conditional-write/lock, static delivery, cache, access, and deployment services satisfy the same production contract as the AWS adapter?

## Selected mapping

- Use R2 through the S3-compatible endpoint and the same `DeploymentBackend` / `ConditionalObjectBackend` operations as local and AWS. R2 supplies origin reads, metadata reads, conditional writes for lock ETags, paginated `ListObjectsV2`, object metadata, and batched deletion. The adapter sets region `auto`; the existing reconcile algorithm does not know the provider.
- Publish static bytes through the configured HTTPS `publicBaseURL` backed by an R2 custom domain. The custom domain is the browser origin; CLI origin reads and writes use the R2 S3 API directly. Keep `/_control/*` inaccessible at the public edge and disable alternate public development URLs in the deployment module.
- Use Cloudflare's zone cache purge API for exact public URLs and URL prefixes. Map logical paths to the public host, split exact files from prefixes, and batch prefix requests at 100 entries. Provider errors fail the operation. Ordinary site publish continues to rely on the shared five-minute freshness bound and does not purge on every publish.
- R2 credentials are read from the configured environment-variable names; the Cloudflare API token is separate and used for cache purge. Scope the R2 token to the deployment bucket. R2 temporary credentials can narrow a satellite token to object prefixes, but this adapter does not yet mint them; command-level registration eligibility is not an IAM boundary.
- Cloudflare Access can protect the configured distribution as a deployment-level viewer policy. Per-site authorization remains outside this adapter and must be enforced before a shared-cache response is served.

Current official documentation lists conditional `If-Match`/`If-None-Match` for R2 object operations and `ListObjectsV2`; Cloudflare cache purge supports URL prefixes, with a maximum of 100 prefixes per request and a 31-separator limit. See [R2 S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/), [R2 temporary credentials](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/), [Cloudflare purge API](https://developers.cloudflare.com/api/resources/cache/methods/purge/), and [prefix purge limits](https://developers.cloudflare.com/cache/how-to/purge-cache/purge_by_prefix/).

## Exit criteria

- [x] Map registry reads, per-site complete listings, object writes/deletes, conditional lock updates, and invalidation/revalidation to concrete Cloudflare APIs.
- [x] Show application-plane and content-plane routing, cache freshness, optional viewer controls, and role/credential separation.
- [ ] Record limitations and a real-service smoke test for conditional writes before promising equivalent behavior.
- [ ] Reuse [T9](T9-cloudflare-store-mapping.md) where preview and production share a store, without silently extending preview-specific assumptions.

## Evidence

`internal/publisher/cloudflare.go` keeps R2 and Cloudflare cache calls behind the shared deployment backend. Conditional-write race and cache behavior still require adapter tests and real-service smoke; this design remains in progress until that proof is recorded.
