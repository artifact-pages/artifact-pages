# IMP-30 — AWS reference deployment module

- Status: Open
- Phase: Provider-backed deployment
- Depends on: [IMP-29](IMP-29-aws-production-adapter.md), [IMP-31](IMP-31-app-distribution.md)
- Proves: deployed route/cache/access/OIDC smoke tests

## Outcome

Provide the documented, reusable AWS infrastructure to serve the versioned app and changing site projection.

## Acceptance criteria

- Terraform provisions private S3, CloudFront OAC, SPA fallback, separated application/content behaviors, correct cache bounds and no public control-object route.
- Separate admin and satellite GitHub OIDC roles allow only intended registry/app/site/control operations; site registration does not rewrite IAM.
- A deployed browser smoke covers deep links, relative assets, content types, 404s, mutable revalidation and optional viewer-access behavior.
- Preview retention/serving work in [IMP-14](IMP-14-provider-serving.md) and [IMP-15](IMP-15-provider-retention.md) composes with production without expanding the mandatory workflow count.
