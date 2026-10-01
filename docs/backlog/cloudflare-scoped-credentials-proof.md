# Cloudflare scoped-credential proof — October 2, 2026

This is live evidence for [T15](verification/T15-provider-delivery.md), not a release announcement or proof of GitHub OIDC. The owner approved 15-minute temporary credentials derived from the existing R2 identity. Parent credentials and permissions were not changed. No credential value was printed or written to a file.

## Fixed inputs and scope

- CLI source: clean preflight selection `eba726a128bac0db98f1578e1c282ed1bbb8a3ff`.
- Target: existing `artifact-pages` R2 bucket and `https://artifact-pages.dev`.
- Disposable site: `release-smoke`; the existing `guide` registration was retained.
- Synthetic source and commits: the same baseline/review fixture recorded in T15. This is not authentic PR or hosted-Action provenance.
- Two credentials were locally signed with HS256, with `exp = iat + 900`, following Cloudflare's [temporary-credential example](https://developers.cloudflare.com/r2/examples/authenticate-r2-temp-credentials/). The signing process kept the parent secret in its own memory; child publisher invocations received temporary R2 values instead of the parent R2 secret. This does not verify automatic expiry at minute 15 or provide an adopter credential issuer.

Reader scope: `object-read-only`, exact object `_indexes/sites.json`, no prefix grants.

Writer scope: `object-read-write`, prefixes `_indexes/release-smoke/`, `_artifacts/release-smoke/`, `_previews/release-smoke/`; exact objects `_control/locks/sites/release-smoke.json` and `_control/site-cache/release-smoke.json`. The last key is required by the current cache-retry implementation and is absent from the older T12 scope example; final adopter guidance must include it. No registry, app-plane or neighboring-site grant was included.

The temporary publisher config explicitly named `sessionTokenEnv`, `registryReaderAccessKeyIdEnv`, `registryReaderSecretAccessKeyEnv` and `registryReaderSessionTokenEnv`. These are environment-variable names, not secrets. An initial harness invocation omitted these fields and returned `SignatureDoesNotMatch`; it was cleaned up, corrected, and rerun successfully. Optional session/reader fields are not inferred merely because their conventional environment variables exist.

## Observations

| Probe | Actual result |
| --- | --- |
| Reader GET registry | 200 |
| Reader PUT exact registry with identical existing bytes | 403 `AccessDenied`; registry bytes unchanged |
| Writer GET registry | 403 `AccessDenied` |
| Writer PUT/GET unique disposable object in its artifact prefix | 200 / 200 |
| Reader GET that artifact | 403 `AccessDenied` |
| Writer GET Guide index | 403 `AccessDenied` |
| Writer PUT unique unused keys under Guide index, app assets and unrelated control prefix | All 403 `AccessDenied`; no existing object was targeted |
| Admin registry register | Dry-run then execution succeeded; only the disposable registration was added |
| Scoped `site publish` | Dry-run and publication succeeded; nine production projection changes |
| Scoped `preview publish` | Dry-run and publication succeeded |
| Same-head scoped preview retry | `no-op` |
| Admin unregister | Dry-run then execution succeeded; 26 reported changes, including registry/cache operations, not a claim of 26 deleted objects |
| Final registry | Restored byte-for-byte to the pre-test registry |
| Final origin listings | All three exact disposable index/artifact/preview prefixes were empty |

The native probes used independently signed S3 requests; publication used the Go CLI/S3 SDK. Temporary test objects were deleted, and the disposable site was unregistered. The site cache-retry record was separately checked at the origin and returned 404 after unregister. Retained free coordination locks are allowed; a residual cache-retry record would not be accepted cleanup. The test did not redeploy the app or publish Guide content.

## Limits and next gates

This establishes R2 reader/writer separation, sampled native denials and the CLI's delegated publisher wiring. Publisher subprocesses retained the configured zone-purge token (`CF_API_TOKEN`); R2 identities were separated, but process-wide least privilege and cache-token isolation were not proven. It does not establish every operation or encoded path, GitHub OIDC subject rejection, a fresh AWS policy, a credential-issuance UX, or prevention of deleting retained previews within the writer's own read/write prefix. In particular, do not equate a scoped read/write preview grant with the stronger AWS retained-history delete restriction.

T15 remains **In progress**. Remaining Cloudflare proofs include actual provider lifecycle removal, competing-new-group publication/interruption recovery and the HTTP-blocking negative case. A retained lifecycle probe needs an agreed lifetime because all currently approved disposable test content has been removed. Official component publication and external adoption still need separately approved pins/versions and publication.
