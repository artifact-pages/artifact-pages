# The Cloudflare R2 path loads the shared AWS configuration

- Status: Done
- Priority: P2
- Area: CLI — Cloudflare R2 publishing (`cli/internal/publisher/cloudflare.go`)

## Problem

R2 credentials come from the environment variables named in the deployment config, but the R2 client is built with `config.LoadDefaultConfig`. That call also reads the shared AWS configuration of the machine: `~/.aws/config`, `~/.aws/credentials`, `AWS_PROFILE`, `AWS_CA_BUNDLE`, `AWS_ENDPOINT_URL*`, `AWS_RETRY_MODE` and similar. An unrelated or broken AWS profile can therefore change or fail a Cloudflare publish, and a CA bundle or endpoint override meant for AWS can redirect R2 traffic. The R2 provider should depend only on the settings in the deployment config.

## Evidence and reproduction

1. Source: `newCloudflareObjectBackend` in `cli/internal/publisher/cloudflare.go` calls `config.LoadDefaultConfig(ctx, config.WithRegion("auto"), config.WithCredentialsProvider(<static R2 keys>))`. Static credentials are explicit, but profile resolution, shared-config parsing and environment overrides still run.
2. Expected failure mode (from the SDK's documented behavior, not yet reproduced here): set `AWS_PROFILE` to a profile that does not exist, or point `AWS_CONFIG_FILE` at a malformed file, then run a Cloudflare `site publish`; `LoadDefaultConfig` returns an error and the publish fails with "load R2 client configuration".
3. A naive removal of the config load (`aws.Config{Region: "auto", Credentials: ...}` only) made one Cloudflare preview integration test fail. The test depends on defaults that `LoadDefaultConfig` supplies, such as the retryer and HTTP client.

## Expected outcome

R2 publishing behaves identically regardless of the user's AWS profiles and AWS environment variables, and keeps the retry and HTTP behavior the tests rely on.

## Acceptance criteria

- [x] The R2 `aws.Config` is built directly from the deployment config and the named credential variables (candidate: explicit static credentials, region `auto`, an explicit retryer and HTTP client), without `config.LoadDefaultConfig`.
- [x] A test sets a nonexistent `AWS_PROFILE` and a malformed `AWS_CONFIG_FILE` and shows an R2 publish still succeeds.
- [x] The Cloudflare preview integration test that failed under the naive removal passes, with the retry behavior it needs made explicit.
- [x] The AWS provider path is unchanged and still uses the shared AWS configuration.

## Resolution

`newCloudflareObjectBackend` now builds the `aws.Config` directly: region `auto`, the static R2 credentials, `awshttp.NewBuildableClient()` and an explicit standard retryer (3 attempts, package variable `cloudflareRetryMaxAttempts`). `config.LoadDefaultConfig` is no longer called on the R2 path, so `~/.aws/*`, `AWS_PROFILE`, `AWS_REGION`, `AWS_CA_BUNDLE`, `AWS_ENDPOINT_URL*` and `AWS_MAX_ATTEMPTS` have no effect. The AWS provider (`newAWSClients`) is unchanged.

The Cloudflare preview integration test previously forced a single attempt with `AWS_MAX_ATTEMPTS=1`; it now sets `cloudflareRetryMaxAttempts = 1` instead, which makes the retry behavior explicit.

Verified with `cd cli && go vet ./... && go test ./... -count=1` (all packages pass), including `TestCloudflareR2IgnoresSharedAWSConfiguration` (malformed `AWS_CONFIG_FILE` and credentials file, nonexistent `AWS_PROFILE`, AWS region, credentials, CA bundle and endpoint variables set; the R2 PutObject still succeeds, signed with the R2 key and region `auto`) and the unchanged Cloudflare preview integration tests.
