# Changelog

## Unreleased

Remove redundant viewer-request route-function associations from all five ordered cache behaviors; retain routing on the default behavior. Canonical raw URLs retain their existing routing. Non-canonical paths that CloudFront normalizes into an ordered behavior no longer receive the route function’s SPA fallback. Their origin response may differ; live AWS behavior remains unverified. This change does not add URL normalization or guarantee SPA fallback for those paths.
