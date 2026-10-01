# Distribution preflight — October 1, 2026

This records agent-led preparation before public release approval. It is not a release announcement or a claim that Terraform Registry, hosted Actions, or independently downloaded release assets were exercised. [T15](verification/T15-provider-delivery.md) owns live Cloudflare evidence; [IMP-38](implementation/IMP-38-terraform-registry-publication.md) and [T16](verification/T16-external-adoption.md) retain their external acceptance gates.

## Fixed inputs

| Component | Tested selection | Boundary |
| --- | --- | --- |
| CLI, Actions and web source | `eba726a128bac0db98f1578e1c282ed1bbb8a3ff` in a clean local Git clone | Later concurrent UI fixes and uncommitted documentation/research are not included. This SHA is a test selection, not an approved release pin. |
| Web bundle | `preflight-20261001-01`, schema 1, `sourceDirty: false`, 100 files, 1,169,417 archive bytes | Local smoke label, not a public SemVer release. |
| Bundle SHA-256 | `a4bb75c6e8e3cf2872cbc44b5c1f89779150e19aeb03fc7277d3ea5b372ae8c5` | Matches archive, manifest and checksum sidecar. No signature/attestation claim. |
| Cloudflare module | `25b6e97031a6fe5202077fe781dc4f14617b0ceb` in a clean local Git clone | Independently pinned module source. Uncommitted registry-reader work in its shared checkout is excluded. No tag/push/Registry publication. |
| Terraform/providers | Terraform 1.9.8; root/contract and isolated caller Cloudflare 5.26.0; local example Cloudflare 5.24.0; external 2.4.2 in CLI contract tests | Recorded resolved versions, not a general compatibility matrix. |

Generated clones, consumer repositories and bundle files remain ignored under `.local/release-preflight.HSpSko/`. That location is an inspection artifact, not an adopter configuration default or a documentation dependency. Recreate the checks from the source pins rather than relying on this machine's ignored files.

## Completed local checks

- `go test ./... -count=1` passed in the fixed clean source clone.
- `go test -race ./cli/internal/publisher ./cli/internal/preview -count=1` passed. Live smoke tests remain opt-in; this run does not establish live-cloud failure recovery.
- `node scripts/test-clean-room-adoption.mjs` passed: independent temporary admin/satellite repositories, complete registry register, explicit-site publish/update, read-only dry-runs, stale-lock ETag rejection and guarded recovery, site-local unregister, preservation of neighbor content, and local Action-wrapper/CLI parity.
- `node scripts/test-app-deploy-rollback.mjs` passed: one warm Chromium context executed fixed-name app asset v1 → v2 → v1 with revalidation and byte-for-byte preservation of content planes. These are small synthetic app bundles against local nginx, not a real released web-app upgrade against Cloudflare.
- Four notice/packaging regression tests passed, including locked dependency license resolution and competing packaging attempts. Actual packaging produced `LICENSE` and notices for 232 production dependencies; no content/control plane was included.
- A separate temporary admin checkout dry-ran and deployed the actual 100-file Vite bundle with the CLI. Every deployed object's bytes matched the build, and its committed admin config remained unchanged.
- The Cloudflare module passed recursive formatting, root/example initialization and validation, three Terraform CLI-output contract tests, ten Node package/delivery/layout tests, and the synthetic `terraform_data` migration/state-move plan with no changes afterward. No real cloud apply was performed by these module checks.
- An independent consumer retrieved the module using `git::file://...?...ref=<full SHA>` and initialized/validated with Cloudflare 5.26.0, without sibling module paths. This proves local pinned Git retrieval and self-contained submodules, not remote GitHub availability or Registry retrieval.

The full browser regression suite passed 83/83 with one worker and retries disabled against the fixed source's local nginx server. The initial manually started test server was not ready for its first request (`ECONNREFUSED`); that first run had one retry. The separate ready-server run distinguishes startup orchestration from browser regressions. Its dedicated Compose project was removed after verification.

## Repair found during preflight

The Cloudflare module's CLI-output validator still imported the old `internal/config` location after the CLI moved beneath `cli/`. Its scratch helper also lived outside the Go internal-package boundary. The baseline independent validation failed at the first Terraform contract test. Module commit `25b6e97` updates the import, keeps helpers under ignored `cli/.local/`, checks that the selected CLI layout exists, and adds a layout regression. The full fixed-commit module validation passes; independent review found no actionable issues. Other in-flight module changes were preserved rather than committed with this repair.

## Remaining owner handoffs

1. **Delegated Cloudflare credential setup.** Only primary R2 credentials were present during this preflight; separate registry-reader/site-writer credentials were not provided. Native permission-denial proof needs operator-issued scoped credentials under the accepted T12 model. Do not issue new security-sensitive credentials or treat command eligibility as IAM proof without authorization. No secrets belong in Git, documentation, chat output or bundle assets.
2. **Provider lifecycle observation.** The earlier disposable preview was explicitly cleaned up. Its expiry metadata was observed, but actual automatic deletion was not. A retained, deliberately disposable lifecycle probe and later observation require an agreed test lifetime; no background workflow or application expiry is added implicitly.
3. **Release selections and publication.** After the remaining provider proof and concurrent repair review, approve exact web/module versions, reviewed source pins, pushes/tags/assets and Registry/GitHub connection. The example module version `0.1.0` remains a proposal, not evidence of publication. Repackage from the final selected clean SHA; do not relabel this smoke archive as an official release.
4. **Published-component adoption.** Run T16 with the actual Registry address/version and GitHub release assets, then verify remote/hosted Action use and released-app upgrade/rollback. Local mocks and file-URL Git retrieval cannot close this gate.

AWS still needs its independent live proof; GCP remains emulator-only. UI repair and owner-reviewed public documentation continue in their existing queues. This preflight creates no new product model, lifecycle scheduler, identity system, signing service or distribution surface.
