# Cloudflare publishers need three secrets for what is one token

- Status: In progress
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

- [ ] When both R2 credential values are absent, the CLI verifies the account API token and derives the R2 access key ID and secret. A config can name only the API token.
- [ ] An explicit R2 key pair takes precedence without verification; a partial pair is rejected. A session token requires the explicit pair, and registry-reader credentials remain separate.
- [ ] The Cloudflare deployment guide documents the single-token setup and its exact permissions.
