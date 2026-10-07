# Cloudflare publishers need three secrets for what is one token

- Status: Done
- Assignee: Codex
- Priority: P3
- Area: CLI Cloudflare credentials, adoption

## Problem

A Cloudflare publisher currently configures an R2 access key ID, an R2 secret access key and a cache-purge API token. When one account API token carries both R2 bucket write and Cache Purge, the R2 pair is derived from that token: the access key ID is the token ID, and the secret is the SHA-256 of the token value. Operators still have to copy three values, keep them consistent and rotate them together. On 2026-10-03, while setting up the verification environment, this confusion caused two failed attempts.

## Evidence and reproduction

1. Verification token `artifact-pages-verify` (Cache Purge on `artifact-pages.stream`, Workers R2 Storage Bucket Item Write on `artifact-pages-verify`).
2. Checked locally: `CF_VERIFY_R2_ACCESS_KEY_ID` equals the token ID returned by `/accounts/{id}/tokens/verify`, and `CF_VERIFY_R2_SECRET_ACCESS_KEY` equals `sha256(CF_VERIFY_API_TOKEN)`.

## Expected outcome

An operator can configure one token environment name for Cloudflare publishing. The CLI derives the S3 credentials itself, and the existing three-name configuration keeps working.

## Acceptance criteria

- [x] When both environment variable values named by `accessKeyIdEnv` and `secretAccessKeyEnv` are absent or empty, the CLI verifies the account API token and derives the R2 access key ID and secret. A config can name only the API token.
- [x] An explicit R2 key pair takes precedence without verification; a partial pair is rejected. A session token requires the explicit pair, and registry-reader credentials remain separate.
- [x] The English and Japanese Cloudflare deployment guides document the single-token setup and its exact permissions.

## Resolution

When both R2 credential environment variable values are absent or empty, the CLI reads the token named by `apiTokenEnv`, verifies it through the account-token endpoint, and derives the R2 access key ID from the active token ID and the secret from the SHA-256 of the exact token bytes. The explicit R2 pair still takes precedence without a verification request or eager purge-token read. Partial pairs and session tokens without an explicit pair are rejected; registry-reader credentials remain separate. The guides explain the next-release availability, environment setup, verification behavior during dry runs and no-ops, and required bucket and zone permissions.

Verified with `cd cli && go test ./... -count=1`, `go vet ./...`, `gofmt -d` on the changed Go files, and `git diff --check`. The configuration-level regression test exercises named-token setup and an R2 request signed with the derived credentials. Independent review of commit `b370ccfe1dcb6867f2db83e8535b05a670139f3b` found no issues and independently reran the full Go tests, vet, and diff check.
