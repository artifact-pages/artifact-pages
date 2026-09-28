# IMP-29 — AWS production store and cache adapter

- Status: Done
- Phase: Provider-backed deployment
- Depends on: [IMP-22](IMP-22-site-locks.md), [IMP-25](IMP-25-production-reconciler.md)
- Proves: [T14](../verification/T14-production-reconciliation.md), [T15](../verification/T15-provider-delivery.md)

## Outcome

Implement provider APIs behind the common registry, content, conditional-lock and cache interfaces for private S3 plus CloudFront.

## Acceptance criteria

- Read the deployed registry directly from S3; conditional writes satisfy lock CAS; listings consume every continuation page; delete batches inspect per-object errors.
- Object bytes, keys and MIME metadata preserve the provider-neutral projection; when a CloudFront distribution is configured, invalidation handles unregister paths and reports request failure. Omitting the optional distribution ID selects storage-only/no-CDN behavior.
- Deterministic adapter tests cover pagination, more than one delete batch, conditional-write races, neighboring-prefix isolation, and invalidation request handling. Opt-in AWS harnesses are supplied for isolated S3 conditional operations, metadata, listing, preview publication, and optional CloudFront invalidation; actual AWS/CDN behavior belongs to [T14](../verification/T14-production-reconciliation.md) and [T15](../verification/T15-provider-delivery.md).
- No AWS API type leaks into product domain models or the browser contract.

## Source review note

The shared S3-compatible adapter maps 404 to confirmed absence only when the service error code is `NoSuchKey`. AWS `HeadObject` can return an ambiguous 404, so the shared adapter confirms absence with an exact-key `ListObjectsV2` query and preserves the read error if that confirmation fails or still lists the key. `go test ./internal/publisher -run '^TestS3CompatibleHeadObjectConfirmsAmbiguous404ByExactKey$' -count=1` covers `NoSuchKey`, `NoSuchBucket`, generic 404s, exact-key matching, and failed confirmations. Live S3/CloudFront outcomes remain separate verification evidence in T14/T15.

`internal/publisher/aws_invalidation_test.go` verifies the CloudFront invalidation request's distribution ID, complete path batch and quantity, non-empty caller reference, returned invalidation ID, empty ID when the response omits it, and wrapped API failure with no returned ID. `go test ./internal/publisher -run '^TestAWSInvalidate' -count=1` passed. This fake-client adapter test does not replace live CloudFront invalidation and cache-revalidation evidence.

`internal/publisher/aws_invalidation_configuration_test.go` verifies the optional no-CDN contract: empty path lists and blank distribution IDs remain no-ops, while a configured distribution with a missing CloudFront client returns an error. `go test ./internal/publisher -run '^TestAWSInvalidate' -count=1` passed. With no distribution configured there is no CloudFront cache target to invalidate; deployed CloudFront targets must include the distribution ID.

`internal/publisher/aws_live_smoke_test.go` adds an opt-in real-service smoke for create-if-absent, rejected duplicate create, stale-ETag rejection, successful compare-and-swap, competing conditional writers, registry reads, exact-prefix listing, uploaded bytes and MIME/cache/user metadata. It uses a random, unindexed key under an explicitly selected registered site's artifact prefix and deletes every version and delete marker beneath that exact random prefix during cleanup. Set `ARTIFACT_PAGES_AWS_SMOKE_RUN=1`, `ARTIFACT_PAGES_AWS_SMOKE_REGION`, `ARTIFACT_PAGES_AWS_SMOKE_BUCKET`, and `ARTIFACT_PAGES_AWS_SMOKE_SITE`; write access also requires `ARTIFACT_PAGES_AWS_SMOKE_CONFIRM="WRITE AND DELETE TEMPORARY OBJECT VERSIONS AND DELETE MARKERS IN S3 BUCKET <bucket> FOR SITE <site>"`. Its role needs `s3:ListBucketVersions` with `s3:prefix` limited to `_artifacts/<site>/.artifact-pages-aws-smoke-*` where supported and `s3:DeleteObjectVersion` only on `_artifacts/<site>/.artifact-pages-aws-smoke-*/*`. Set `ARTIFACT_PAGES_AWS_SMOKE_DISTRIBUTION_ID` to additionally request and verify a live CloudFront invalidation response. `internal/publisher/preview_flow_live_smoke_test.go` adds an isolated preview-publication path smoke. Set `ARTIFACT_PAGES_AWS_PREVIEW_FLOW_SMOKE_RUN=1`, `ARTIFACT_PAGES_AWS_PREVIEW_FLOW_SMOKE_REGION`, `ARTIFACT_PAGES_AWS_PREVIEW_FLOW_SMOKE_DISPOSABLE_BUCKET`, and `ARTIFACT_PAGES_AWS_PREVIEW_FLOW_SMOKE_DISPOSABLE_SITE`; its separate confirmation string is `ARTIFACT_PAGES_AWS_PREVIEW_FLOW_SMOKE_CONFIRM="WRITE AND DELETE RANDOM PREVIEW DATA AND ALL VERSIONS/DELETE MARKERS IN DISPOSABLE S3 BUCKET <bucket> FOR REGISTERED SMOKE SITE <site>"`. It needs the corresponding version-list and version-delete permissions limited to `_previews/<site>/.artifact-pages-preview-flow-smoke-*`. The smoke harness and fake-backed adapters are covered by local tests; live smoke execution was skipped because no AWS credentials or explicit target were provided. No real S3 or CloudFront behavior is claimed verified; that evidence remains in T14/T15.
