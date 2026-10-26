# AWS ordered cache behaviors invoke the route function without changing requests

- Status: In progress
- Assignee: Codex
- Priority: P3
- Area: AWS CloudFront delivery cost

## Problem

The CloudFront route function is associated with all five ordered cache behaviors. For canonical raw URLs, `routes.js` passes their request URIs through unchanged, so these requests incur a no-op invocation. Non-canonical paths that CloudFront normalizes into an ordered behavior can have a different origin response after the function association is removed.

Canonical raw URLs retain their existing routing. Non-canonical paths that CloudFront normalizes into an ordered behavior no longer receive the route function’s SPA fallback. Their origin response may differ; live AWS behavior remains unverified. This change does not add URL normalization or guarantee SPA fallback for those paths.

## Evidence and reproduction

`terraform/modules/aws/main.tf` associates `aws_cloudfront_function.routes` with both the default behavior and every generated ordered behavior. `terraform/modules/aws/routes.js` explicitly returns requests unchanged for `/_indexes/*`, `/_artifacts/*`, `/_previews/*`, `/assets/*`, and `/_errors/*`.

This issue is related to [ISSUE-126](ISSUE-126-published-aws-module-cache-policy-drift.md), which covers correcting the published AWS module source.

## Expected outcome

Only requests handled by the default behavior invoke the route function; ordered behaviors continue to serve their configured origin paths directly.

## Acceptance criteria

- [ ] The default behavior has exactly one viewer-request association to the route function, and all ordered behaviors have none.
- [ ] Regression checks preserve raw-path pass-through, fixed application files, logical route rewrites, and existing cache, CSP, and error handling.
- [ ] README and module changelog describe the behavior change, and the generated package includes the changelog.
- [ ] Canonical raw URLs retain their existing routing. Non-canonical paths that CloudFront normalizes into an ordered behavior no longer receive the route function’s SPA fallback. Their origin response may differ; live AWS behavior remains unverified. This change does not add URL normalization or guarantee SPA fallback for those paths.
