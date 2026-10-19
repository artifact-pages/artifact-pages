# Coordinated provider proof and hosted fixture approval plan — October 18, 2026

Prepared by Codex Sol for [Backend next wave items 2 and 4](../workstreams.md#backend-next-wave-2026-10-18). Owner decisions and their scope are recorded below; this plan authorizes no work beyond those decisions. No cloud commands, account reads, applies, deployment, identity, fixture or settings changes were performed to prepare it. A1–A3 were approved on 2026-10-18. Ticket status changes are recorded in their source items. The [hosted fixture preparation](hosted-fixture-preparation-2026-10-18.md) supplies item 2's exact repository delta.

## Scope and decisions

One evidence ledger serves T4/T5/T8/T14/T15 and IMP-73's custom-prefix runtime gate; each uncovered criterion appears once below. An execution can attach evidence to several tickets without repeating a test. Proof is per provider, version and egress, never a worldwide propagation or availability promise. GCP remains emulator-only; IMP-44/WAF, T16 adoption, release/Registry/Marketplace publication and production rollout are excluded. The accepted trusted same-origin HTML contract does not promise hostile-script or parent/storage isolation.

Use a **new disposable AWS stack** in account `231136241959` to prove actual new-bucket bootstrap and custom-prefix setup together. Do not empty or alter the current AWS verification stack. Use the **existing Cloudflare verification deployment** in the separate account, with a coordinated app-deployment freeze, rather than attach a second module/state to its zone-root rulesets. Do not repurpose production for provider experiments. Lifecycle observation has a finite observation window, not a promise that the provider expires on schedule.

### Superseding execution decision — October 20, 2026

The owner accepted Sol’s simplified execution recommendation on 2026-10-20. **Claude main executes the one-off proof directly**, using unmodified released tools and the retained [standalone policy documents](../../../scripts/provider-proof/policies/). Retire the Node harness, commands.sh, trust anchor, signatures/chained seals, invocation registry, credential-verification records, supervisor/transport gates and fake Go coordinator. Do not complete their outstanding adapters or replace them with another approval framework. Git retains the retired implementation and its local evidence; it establishes no live-provider proof.

Review concrete commands, rendered policies, identities, target bindings, immutable pins, output paths, saved-plan hashes, caps and cleanup branches in chat before the applicable **OK A4–A9**. Record the owner’s chat approval and UTC time with the reviewed inputs. There must be no unresolved value needed by the next step. Changes to scope, identity, pins, resource list, limits or cleanup boundaries require renewed review. Identity/policy readback, P1 positive/negative probes and actual preservation comparisons remain evidence requirements, without a bespoke verification-record gate.

Owner decisions: unsupported P4–P7 fault cells remain **open / not-run**, never passed by approximate timing or fake tests; Cloudflare full Terraform refresh waits for owner-confirmed read-only permission groups/IDs in the dashboard, while content/metadata inventory may proceed; hosted OIDC fixture jobs remain required. The owner supplies production evidence for retained experiments; this run carries no production credentials and makes no production requests. A4 stops before exceeding 30 minutes or usage allowances and requests an extension with size/request/time/cost estimates rather than reducing inventory coverage.

Future recurring regression uses dedicated sites/run IDs and exclusive windows on the existing verification stacks, with **explicit future authorization**. A4 preservation-only AWS reads authorize no regression writes. Regression runs **after verified publication and before rollout**; [IMP-81](../implementation/IMP-81-provider-release-regression-workflow.md) implements it and [T28](T28-provider-release-regression.md) records its proof.

## Approval record and A8-short

Owner decisions recorded on 2026-10-18 remain valid: A1–A9, A8 in the shortened form below, A9 conditional on released CLI v0.5.0 and all four Actions v0.3.0 with reviewed immutable pins. The October 20 decision changes execution method, not these scopes or combined caps. Release publication is outside these approvals. Keep concrete command/plan review, credential scope evidence, owner chat OK and obtained provider proof distinct; approval alone does not establish proof.

Before a transition, present the expanded command list, identities/policies, exact targets, inputs and artifact/plan hashes, output locations, expected deltas, expiry/deadline, remaining usage allowance and cleanup. Obtain the corresponding chat OK against those concrete inputs. No SSH signing, seal attachment or invocation registration is required. The owner still operates interactive SSO/deployment approvals and reviews actual Terraform create/destroy/lifecycle plans and A9 released pins.

**A8-short —** One-day natural-expiry experiment, life-site cleanup, restoration of the temporary Cloudflare lifecycle addition, and immediate AWS proof-stack destruction at the sequencing gates below. Maximum observation: 48 hours after the latest applicable eligibility time, additionally bounded by 108 hours from first AWS resource creation. Maximum retained infrastructure lifetime: **120 hours / five days**, replacing nine days. Retain the existing A8 ceilings of one operator hour, up to 60 minutes final teardown and $1; all overall usage and spend caps remain unchanged.

Only disposable proof data may receive shortened retention. A8-short permits the exact life-prefix Cloudflare lifecycle addition and its restoration described below; A6 continues to prohibit lifecycle changes. No production policy, existing AWS verification stack, older retained experiment or unrelated Cloudflare prefix may change. Actual Terraform applies and final destruction retain the plan’s owner review of exact addresses and saved-plan hashes.

## Credited evidence (do not rerun without a coverage/version reason)

| Existing sample | Credit / precise limit |
| --- | --- |
| [T4 local proof](T4-serving-boundary.md#evidence), [T6](T6-resources-navigation.md), [T17](T17-local-preview-retirement-e2e.md) | TD3 iframe/resources, sanitized Markdown, raw misses, local withdrawal and Actions parity. Emulator proof is complete at its boundary. |
| [Cloudflare recovery](../cloudflare-preview-recovery-proof.md) October 2 | Distinct-new-head two-CLI race; SIGKILL after partial upload; observed-ETag recovery; stale-owner rejection; complete manifests/hashes; preserved original groups/neighbors. Also one runtime HTTP-fetch CSP refusal. |
| [Cloudflare scoped credentials](../cloudflare-scoped-credentials-proof.md) | Registry reader/site writer separation and named native read/write denials; temporary 15-minute credentials, not all current scopes or token expiry. |
| [Cloudflare lifecycle/reconciliation](../cloudflare-preview-lifecycle-proof.md) October 1–2 | Explicit manifest deletion, ordinary main publish prunes only missing revision, retained revision unchanged, warm list/direct-link revalidation. Natural expiry is **not** established. |
| [T15 AWS October 13–14](T15-provider-delivery.md#aws-github-oidc-runs--october-14-2026-jst), #133/#137/#143 | Default CloudFront TLS, notices, configured OIDC admin/satellite success, negative subjects and write/delete boundaries, bootstrap on an **emptied** bucket. Update 14 s/unregister 10 s were SSO samples, not reference-role bounds. |
| [T22](T22-cache-purge-retry.md) | Completed local/fake invalidation-only retry convergence. Deployed cache request/propagation remains below. |
| [IMP-64](../implementation/IMP-64-generate-sync-terraform-packages.md), [IMP-73](../implementation/IMP-73-registry-setup-command.md) | Actual module sync/Registry delivery, generator/local tests; Stage D public no-write run `38114003134` and caller branch denial; default-prefix OIDC. Hosted guards and uncovered fixture cases only are in F64/F73. |

Do not repeat historical Cloudflare production samples merely to obtain a newer date. New rows exercise missing scenarios or the isolated verify deployment. Current version records are inspected, not inferred from earlier prose.

## Pin sheet and review rules

| Component | Selected immutable baseline |
| --- | --- |
| Historical plan/source starting point | monorepo `b0d314e590cbb19aa563d56882527b47d5c44eb3` |
| Released writer and registry-setup generator | CLI `v0.4.4`, source `060f28883abb25442f3cb1e9108f0de4570362fa`; verify release asset checksum and version/revision |
| Web B / web A for warm upgrade/rollback | `web/v0.3.2` → `5e046db3a92ecdd90dde5b6eb9dc867c067dd1a1`; `web/v0.3.1` → `04783fb399c877dbe456f3355c2484348e174e88`; obtain archives/manifests/checksums and record SHA-256 |
| Official Actions v0.2.0 | publish `8d66d7a606fc047715d25e8acdb8f09309ad4991`; preview `d4d96885d0d430bbe1591d3cc11207d92e680339`; registry `47ff737c5751748608afc3a1cd4763696f319f45`; app-deploy `8ee0d56d20bc46e2ee555b73f4cc402852f158f5` |
| AWS OIDC Action | `aws-actions/configure-aws-credentials@e1253824e5c10ff9df46874f81ed3ec929e19cfd` (v6.3.0) |
| Reference modules | Registry `artifact-pages/artifact-pages/aws` and `artifact-pages/artifact-pages/cloudflare`, exact `0.1.1`, monorepo source tags both peel to `f7096315531d2c124f9b2f64ff5f2393ff63ea7b`; resolve package commits and release.json through approved reads, compare generated payload |
| Terraform / provider binaries | Terraform **1.16.4** (live verify tooling recorded by ops); AWS **6.66.0**, Cloudflare **5.26.0**, copy committed lockfiles and use `-lockfile=readonly`; no upgrade; Terraform 1.9.8 local CI is credited separately |
| Browser and tools | Playwright and Chromium from baseline `package-lock.json` via `npm ci`; Go 1.26.0; Node 24; AWS CLI 2.27.41. AWS CLI, Terraform and provider-facing tools run in Linux containers under Docker Desktop on the owner’s Mac; evidence records host macOS, container image digest, guest architecture and exact tool versions in the evidence manifest. Hosted GitHub jobs are recorded separately as hosted-runner evidence. |
| Future gzip lane only | CLI **0.5.0**, four Actions **v0.3.0**, bootstrap 0.5.0 / range `>=0.5.0 <0.6.0`; **not published at planning time**. A9 blocked until ISSUE-112 ships and exact released CLI source/asset SHA and all four Action SHAs/release.json are added to a reviewed pin-sheet amendment. Never use `main`, `latest` or invented release hashes. |

Resolve all v0.2.0 published Action release.json ranges under A4; expected bootstrap 0.4.0/range `>=0.4.0 <0.5.0`. Full SHA pins in generated workflows are package-repository SHAs, not the monorepo's Action tag objects. Failure to match is a stop. Record the source config and synthetic Git fixture commit SHAs, web digest, execution-source commit/digest, generated workflow SHA, provider locks, root config hash, approved plan hash, account/zone/bucket/distribution/role IDs and timestamp in `manifest.json`. An artifact's release tag alone is insufficient.

## Account and resource inventory (A4 before all provider work)

Read-only workspace sources: workspace `STATUS.md` **In flight / infra lane and October 17–18 log**, `ops/README.md`, `ops/aws-guide-facts.md`, `ops/OPS-007-retire-stream-verification-environment.md`. Earlier Snapshot/Next paragraphs still say AWS was destroyed or Registry unpublished; later records supersede them. This is planning context, not a fresh cloud inventory.

| Scope | Known context / guard |
| --- | --- |
| Production, forbidden target | Cloudflare account `9ac354c8aa31d424224d8c4f3aa8ba2a`, `artifact-pages.dev`, bucket `artifact-pages`, state `admin-production`; no publish, registry, token or Terraform mutations here |
| Cloudflare verify, allowed after approval | Account `21a0acb78621cc00cfa655a276d77b74`, zone name `artifact-pages.stream`, rebuilt after OPS-007; verify-only state/secrets under `~/.config/artifact-pages-verify/`. Zone ID, bucket and active domain must be discovered/checked under A4, not copied from retired production-account verify. |
| Existing AWS verify, preserve | Account `231136241959`, us-east-1, bucket `artifact-pages-231136241959-us-east-1`, distribution `ECFTIR5GVPQDF`, `https://d3qg4cc5j20soe.cloudfront.net`, prefix `artifact-pages-aws-verify`; 25 state resources and state key `aws-verify/terraform.tfstate` after October 17 move. Read inventory only; no state relocation, apply, app deployment or cleanup. |
| New AWS proof, A5 | Bucket `ap-proof-231136241959-20261018`, prefix `ap-proof-20261018`, default CloudFront hostname, no alias/ACM/DNS/WAF; fresh local Terraform state under protected evidence `aws-proof/terraform.tfstate` (never production/verify state). Existing OIDC provider ARN `arn:aws:iam::231136241959:oidc-provider/token.actions.githubusercontent.com` is read/reused, not created/deleted. |
| GitHub provider fixture, A5 | New public `artifact-pages/provider-proof-20261018`, exact environments `proof-admin` / `proof-site-a` / `proof-site-b` / `proof-neighbor`, branch `main` only and owner required reviewer with `prevent_self_review: false` (owner dispatches and manually approves); no production secrets. Separate reviewed branch `codex-provider-proof-20261018` preparation PR; merge fixture-only content after review. |
| Sites, both proofs | `proof-a-20261018`, `proof-b-20261018`, `proof-neighbor-20261018`, `proof-life-20261018`; fixture repo above, source directories `sites/a`, `sites/b`, `sites/neighbor`, `sites/life`. No pre-existing registration may use these names. |

AWS Terraform: `preview_retention_days=1`, `price_class=PriceClass_100`, `viewer_protocol_policy=redirect-to-https`, no WAF. Admin trust is the exact GitHub subject for `proof-admin`; satellite map a/b/neighbor gets its matching exact environment subject (life runs under admin). Read the new repo's numeric owner/repo IDs and OIDC `sub_claim_prefix`; freeze concrete immutable subjects before plan. No wildcards, no branch subject fallback, no trust changes on existing roles. Roles: `ap-proof-20261018-admin-publisher` and `ap-proof-20261018-<site>-publisher` using the module's hash rule if necessary. In addition, A5 creates one test-only operator role `ap-proof-20261018-test-operator` and its policy outside the reference module, with trust limited to the exact inventoried SSO role ARN; no changes to that existing SSO role or the reference OIDC role trust. Only these new roles/policies can be created/deleted. Use the owner’s `artifact-pages-verify` SSO login only to assume the dedicated inventory/provisioner roles; A4 reads use the inventory role and A5/A8 Terraform uses the provisioner. Test identities and isolation are specified below. Sessions <=1 hour, no long-lived AWS key creation. Cloudflare uses verify-only parent credentials; mint 15-minute scoped children with current `_control/sites/<site>/` grants plus read-only `_control/versions/app.json` and separate registry reader. No production token, parent permission expansion or token logging.

Before the owner says **OK A4**, show the rendered policies, credential identities, complete expanded command list, output locations, expected targets and caps. Creating a missing role/token is a separately confirmed administrative prerequisite, not an A4 read.

Use `umask 077` and a new mode-0700 evidence directory. Save raw responses privately; retain command, UTC times, exit status, stderr and request IDs without authorization headers or credential material.

### AWS role policy: exact deltas

Starting from [`aws-inventory-role-policy.json`](../../../scripts/provider-proof/policies/aws-inventory-role-policy.json):

1. Bind the preserved bucket/distribution to the values above. For A4, remove the nonexistent proof-distribution binding. Permit the proposed proof bucket only for name/availability checks; never adopt an occupied bucket.
2. Correct action spellings throughout the document:
   - `s3:GetBucketLifecycleConfiguration` → `s3:GetLifecycleConfiguration`.
   - `s3:GetBucketReplication` → `s3:GetReplicationConfiguration`.

   These IAM spelling corrections require provider validation during the approved run; this text records no such validation.
3. Bind the state object to:
   `arn:aws:s3:::artifact-pages-verify-tfstate-231136241959/aws-verify/terraform.tfstate`.
   Add `s3:ListBucket` on that state bucket conditioned to the exact state-key prefix for backend access. Add that bucket to the corresponding S3 `NotResource` exception. Grant no `.tflock` writes.
4. Extend IAM read resources from future proof roles/policies to the **exact inventoried existing verification roles/policies and inventory role**. Retain only the existing explicit IAM read actions; no account-wide role enumeration.
5. For full AWS refresh, add these reads on exact IDs referenced by the preserved distribution/state:
   - `cloudfront:GetOriginAccessControl`
   - `cloudfront:GetCachePolicy`
   - `cloudfront:GetResponseHeadersPolicy`
   - `cloudfront:DescribeFunction`
   - `cloudfront:GetFunction`
   - `cloudfront:ListTagsForResource` where applicable.

   Expand `DenyAllOtherDistributions`’ resource exceptions to include those exact associated resource ARNs, or its `cloudfront:*` deny will block them.
6. Add an unconditional deny:

   ```json
   {
     "Sid": "DenyOutsideEnumeratedInventoryReads",
     "Effect": "Deny",
     "NotAction": ["<the exact union of all amended Allow Action values>"],
     "Resource": "*"
   }
   ```

   Generate that array from the explicit allow statements, with no wildcards. This specifies the exact delta without maintaining a second, divergent action list. Existing scoped allows still determine where those reads are permitted.

The standalone template must include this unconditional deny before use; implicit denial alone does not satisfy this plan. A deny does not grant anything.

Trust remains the exact owner SSO role ARN from [`aws-trust-documents.json`](../../../scripts/provider-proof/policies/aws-trust-documents.json), with `MaxSessionDuration=3600`; assume for at most 3,600 seconds. No IAM users, access keys, attached broad read policy or SSO source credentials in test children. Missing SSO permission to assume the role is an owner prerequisite.

### AWS command/evidence list

All commands use the inventory-role profile, `--output json` where supported, and normal complete pagination. Each invocation gets its own result/error file.

| Commands | Evidence saved |
|---|---|
| `aws sts get-caller-identity` | Account and effective assumed-role ARN. |
| `aws s3api list-buckets`; `head-bucket --bucket <proposed-proof-bucket>` | Account-owned names and proposed-name response. A 403 is inconclusive, not availability. |
| `s3api get-bucket-location`, `get-bucket-versioning`, `get-bucket-lifecycle-configuration`, `get-public-access-block`, `get-bucket-ownership-controls`, `get-bucket-encryption`, `get-bucket-tagging`, `get-bucket-policy`, `get-bucket-policy-status` | Preserved bucket configuration. |
| `s3api get-bucket-cors`, `get-bucket-website`, `get-bucket-accelerate-configuration`, `get-bucket-request-payment`, `get-bucket-logging`, `get-bucket-replication`, `get-object-lock-configuration` | Remaining configuration; distinguish documented “not configured” errors from denied/failed reads. |
| `s3api list-objects-v2 --bucket <preserved>`; `list-object-versions --bucket <preserved>` | Complete key inventory, versions and delete markers. |
| `s3api head-object`, `get-object`, `get-object-tagging`, adding `--version-id` for retained versions | Object metadata, raw bytes, tags and SHA-256; save registry/version records and private control data privately. |
| `cloudfront get-distribution --id ECFTIR5GVPQDF`; `get-distribution-config`; `list-tags-for-resource --resource <ARN>` | Delivery configuration, ETags, references and tags. |
| `cloudfront get-origin-access-control`, `get-cache-policy`, `get-response-headers-policy`, `describe-function`, `get-function` for referenced IDs/names | Associated policy/function configuration and function bytes. |
| `iam get-open-id-connect-provider --open-id-connect-provider-arn arn:aws:iam::231136241959:oidc-provider/token.actions.githubusercontent.com` | Existing OIDC configuration. |
| `iam get-role`, `list-role-policies`, `get-role-policy`, `list-attached-role-policies`; `get-policy`, `list-policy-versions`, `get-policy-version` for exact bound roles/policies | Trust, permissions boundaries and actual inline/managed policy documents. |
| `s3api head-object/get-object` on the exact backend state key, before and after | Raw state, ETag, hash, lineage and serial. |

Expand resource-dependent commands after reading the distribution/state, then show the concrete second batch in chat. Do not use wildcard discovery permissions to avoid that step.

### Cloudflare credentials and reads

The checked-in [credential scopes](../../../scripts/provider-proof/policies/cloudflare-credential-scopes.json) settle these groups:

| Credential | Exact group and scope |
|---|---|
| A4 content snapshot | `Workers R2 Storage Bucket Item Read`, verification content bucket only. |
| A4 R2 configuration | `Workers R2 Storage Read`, account `21a0acb78621cc00cfa655a276d77b74` only. |
| A4 backend read | `Workers R2 Storage Bucket Item Read`, verification `tfstate` bucket only; use for state GET/list, never the existing read/write backend credential. |
| Later site credential issuer | `Workers R2 Storage Bucket Item Write`, verification content bucket only; issue 900-second operation/path-restricted children. |
| Later cache purge | `Cache Purge`, exact verification zone only. It remains zone-wide authority. |
| A8 lifecycle administrator | `Workers R2 Storage Write`, verification account only, supplied only for the confirmed lifecycle transaction. |

For A4, also require `Zone Read` on the exact verification zone.

**Owner-confirmed prerequisite:** the repo documents Terraform’s **edit** groups—Transform Rules, Cache Rules, Config Rules and Zone WAF—but does not establish the complete read-only group set for refreshing all deployed rulesets. Do not substitute edit permissions or guess group IDs. The owner must confirm the read-only groups/IDs in the dashboard before full Cloudflare refresh. Content/metadata inventory may proceed separately; do not claim a completed full refresh. DNS permissions are unnecessary for the checked-in root unless the actual owning state contains DNS resources.

Cloudflare API reads, under `/client/v4`:

| GET endpoint | Evidence |
|---|---|
| `/zones?name=artifact-pages.stream&account.id=<verify-account>`; `/zones/<zone-id>` | Exact account/zone binding. |
| `/accounts/<account>/r2/buckets`; `/accounts/<account>/r2/buckets/<bucket>` | Complete bucket inventory and bucket configuration. |
| `/accounts/<account>/r2/buckets/<bucket>/lifecycle` | Authoritative complete lifecycle rules. |
| `/accounts/<account>/r2/buckets/<bucket>/domains/custom`; `/domains/managed` | Custom-domain connection and managed-domain status. |
| `/zones/<zone>/rulesets`; `/zones/<zone>/rulesets/<id>` | Complete deployed rulesets. |
| `/zones/<zone>/rulesets/phases/<phase>/entrypoint` | Transform, cache, response-header and configuration roots; WAF root only if already managed. |

Use R2’s S3 endpoint with `aws s3api list-objects-v2`, `head-object` and `get-object` for content/state snapshots. Complete every pagination mechanism. Keep bearer tokens out of command arguments and logs.

### Terraform procedure

Use isolated copies of the **actual owning roots**, their recorded inputs and committed lockfiles. The checked-in backend anchors are:

| Root | Existing backend |
|---|---|
| [`terraform/deployments/aws/versions.tf`](../../../terraform/deployments/aws/versions.tf) | Bucket `artifact-pages-verify-tfstate-231136241959`, key `aws-verify/terraform.tfstate`. |
| [`terraform/deployments/cloudflare-verify/versions.tf`](../../../terraform/deployments/cloudflare-verify/versions.tf) | R2 bucket `tfstate`, key `cloudflare-verify`, verification-account endpoint. |

For each root, after its permission prerequisites are satisfied (Cloudflare full refresh remains stopped until the owner confirms read-only groups/IDs):

```sh
terraform init -input=false -lockfile=readonly -backend-config="$E/<provider>-backend-readonly.hcl"
terraform state pull
terraform plan -refresh-only -lock=false -input=false -detailed-exitcode -out="$E/<provider>-refresh.tfplan"
terraform show -json "$E/<provider>-refresh.tfplan"
terraform state pull
```

Redirect each output separately under `$E`; also save a human-readable plan. Backend overrides must select the read-only identity, not the profiles embedded in the roots. No `-migrate-state`, upgrade, apply or remote-state creation.

Record actual tool versions; the plan selects Terraform 1.16.4, AWS provider 6.66.0, Cloudflare 5.26.0 and AWS CLI 2.27.41. Missing lock/pin agreement stops for review.

A refresh-only plan **does not prove configuration has no proposed changes**. It records refresh drift. Exit 2 requires review; exit 1 fails. Compare backend raw hashes, serial and lineage before/after; any concurrent change invalidates the snapshot.

### Baseline comparison

Retain raw files plus a sorted comparison manifest: key/version, size, ETag, LastModified, stored-byte SHA-256, HTTP/user metadata, tags, configuration hashes, registry membership and version records.

At scenario boundaries and final cleanup:

- Require unrelated objects/configuration to match exactly.
- Compare shared app/registry changes against the approved delta; require restored app bytes/configuration and original registrations afterward.
- Require the complete Cloudflare lifecycle policy to match its baseline after removing only the temporary rule.
- Require preserved AWS objects, versions and state to remain unchanged.
- Record expected operational differences separately; do not broadly ignore timestamps or version changes.

Before this inventory would exceed A4’s 30-minute/usage allowance, stop and request an extension with size, request, time and cost estimates. Do not silently reduce coverage.

Preserve older `release-smoke` and T18/T19/T25 retained experiments without rewriting, age-resetting or deleting them. The owner supplies any production evidence; no production credentials or requests enter this run. Never recursively empty a shared bucket. A6 requires an agreed freeze; unexpected writers, held locks, pending retries, incompatible records, retention conflicts or baseline drift stop the phase.

## One uncovered-criterion ledger

Each row is the sole definition of that outstanding proof; instructions below execute these IDs. Record provider-specific pass/fail/not-run, commands, identity, request IDs, origin and browser timestamps, and preservation/cleanup verdict. Attach one sanitized evidence record to every linked ticket. A checked parent requires all its relevant cells, not merely an experiment finishing.

| ID | Uncovered criterion and expected result | Tickets / approval |
| --- | --- | --- |
| P1 | AWS **existing-neighbor** index/artifact/preview/control GET denied under satellite a, paired with admin-confirmed existing objects and allowed own-site GET. No absent-key 403 inference. Native R2 current scoped child equivalents pair with own reads; reuse older sampled denials where unchanged. | [T15](T15-provider-delivery.md#proof-needed); A5/A6 |
| P2 | AWS fresh bucket absent registry/site/lock reads: save actual S3 error/status/request ID and exact-prefix listing under reference admin/satellite; bootstrap app→registry→site using unchanged policies. Generated setup derives custom-prefix satellite ARN, OIDC assumes it, released Action executes CLI 0.4.4. No privilege widening. | [T15](T15-provider-delivery.md#proof-needed), [IMP-73](../implementation/IMP-73-registry-setup-command.md#acceptance-criteria); A5 |
| P3 | Both providers' uncovered production/preview logical direct/reload and nested HTML/Markdown/CSS/image/font/transitive-module matrix; raw missing resources 404; JSON/HTML/Markdown MIME, inline disposition, index/catalog/manifest/artifact cache, hashed assets and fixed files correct; control never returns private bytes; anonymous direct origin denied. Enforced production/preview CSP allows same-origin modules and intended HTTPS resources, refuses runtime HTTP and opaque/null/wildcard CORS access; Markdown scripts do not execute. Trusted HTML parent access remains allowed. | [T4](T4-serving-boundary.md#exit-criteria), [T15](T15-provider-delivery.md#proof-needed); A5/A6 |
| P4 | AWS live If-None-Match/If-Match races, same-site different-new-head two-process CLI preview publication, killed partial-upload recovery and stale-owner rejection, plus **both providers'** remaining after-manifest/before-catalog interruption and catalog-write failure/retry. Complete immutable manifests/file hashes, both groups retained; stale process fails before catalog replacement. Cloudflare completed race/partial/stale-owner rows are credited above, not repeated. | [T5](T5-concurrency-recovery.md#exit-criteria), [T14](T14-production-reconciliation.md#proof-needed), [T15](T15-provider-delivery.md); A7 |
| P5 | Both providers: separate production `site sync` processes for a/b overlap in the actual publish critical section, update both outputs, preserve registry/app/neighbor. Production failure matrix: artifact PUT, index replacement, meta upload before stale deletion, partial stale delete, either initial prefix listing failure and continuation-page failure, lock loss before preview reconciliation. Each aborts at contract boundary and retry converges without stale-owner catalog write or unrelated deletion. | [T14](T14-production-reconciliation.md#proof-needed), [T5](T5-concurrency-recovery.md); A7 |
| P6 | AWS origin missing-manifest cleanup and both providers' deployed origin-read-error, failed production switch, and post-switch catalog-write-failure retries. Confirmed missing revision alone is pruned by ordinary main sync; retained open/merged/closed/manual-labeled groups survive; 403/503/timeout keeps unknown candidates and fails cleanup. Warm browser hides confirmed-missing manifest before pruning. Cloudflare successful simulated cleanup is credited, not rerun alone. | [T8](T8-stale-reference-cleanup.md#exit-criteria), [T14](T14-production-reconciliation.md), [T15](T15-provider-delivery.md); A7 |
| P7 | Both providers: reference-identity update/unregister, mutable site/catalog/manifest and removed HTML/Markdown/resource requests at canonical warm URLs; record origin commit, invalidation request/acceptance/completion and edge visibility. Registry/app/site/unregister **invalidation-only** failure retains retry record; identical retry still issues invalidation after origin converged, then clears record. No unexplained cache-busting, stale retry loss or neighbor invalidation. | [T4](T4-serving-boundary.md#exit-criteria), [T14](T14-production-reconciliation.md), [T15](T15-provider-delivery.md#proof-needed); A7 |
| P8 | Both providers: same browser/profile already warm on web A, deploy B then roll back A; reload canonical routes and verify actual fixed-name index.html/preview-bridge.js/notices and hashed asset references execute/render the selected version without mixed-generation failures. Restore original deployed version/config. Origin byte checks alone do not pass. | [T4](T4-serving-boundary.md#exit-criteria), [T15](T15-provider-delivery.md); A5/A6 |
| P9 | Both providers: observe **natural** lifecycle deletion, complete HEAD+listing agreement, interval from last-present to first-absent and requested eligibility separately; ordinary publish reconciles any surviving catalog. Catalog expiry itself is recorded, no false pruning claim. No rewrite or manual delete before observation ends. | [T8](T8-stale-reference-cleanup.md), [T15](T15-provider-delivery.md); A8 |
| P10 | After ISSUE-112 ships only: AWS small and >10,000,000-byte decoded index/search manifest at same keys store deterministic gzip/metadata; raw S3 gzip hashes decode to builder JSON; CDN cold/warm `gzip` requests and browser JSON/full-text reads decode correctly, same-URL update/revalidation/invalidation works. Synthetic large manifest labeled synthetic. Plain→gzip unchanged-source migration, next no-op, metadata repair/recovery and released 0.4.4 pre-write rejection preserve neighbors. No claim that 1.6 Mbps always transfers a 2.63 MB object within 20 s; record live timing and retain the local controlled acceptance as a separate gate. | [ISSUE-112](../issues/ISSUE-112-aws-large-generated-json-delivery.md#acceptance-criteria), [T15](T15-provider-delivery.md); A9 |

## Execution sequence and exact command contract

### Local preparation and evidence

Use `umask 077` and a new mode-0700 `$E` outside Git (for example `.local/provider-proof-20261018/<run-id>/`). Record immutable pins and reviewed bindings in ordinary JSON/text plus SHA-256 digests. Keep credentials, raw state/control data and raw logs private; publish sanitized evidence only. Claude main reviews and runs exact commands directly. Check identity/policies, expected positive/negative reads, actual baseline comparisons, remaining credential lifetime, phase/combined caps and teardown reserve before proceeding. No signature, seal, registry entry or machine verification record is an execution prerequisite.

Maintain a plain usage ledger with conservative bounds for commands and opaque SDK retries. Include preliminary identity/policy/probe reads in the phase and combined allowances. Stop on target mismatch, collision, drift, unexpected authorization success, expired credentials or insufficient allowance.

#### Retired PR #179 / #178 history

Historical [PR #179](https://github.com/artifact-pages/artifact-pages/pull/179) local gate hardening on `codex-proof-gate-hardening` and [PR #178](https://github.com/artifact-pages/artifact-pages/pull/178) harness work are **retired by the October 20 decision**. The following results record fake-backed implementation history only; they are not current execution gates or live evidence.

- [x] The standalone credential-verification path and direct credential verification require a valid sealed preservation checkpoint before credential loading, inspection, or probes.
- [x] Policy review counts only unconditional Deny statements for required preserved-resource and proof-boundary evidence, and rejects unreviewed Allow wildcards, including `NotAction`; array forms are covered.
- [x] Capture redaction covers UTF-8 hex and JSON escaped secret forms for multiple overlapping secrets in stdout and stderr, including split chunks.
- [x] Fake-child coverage verifies TERM/KILL escalation, first-cause error precedence, grace-timer cleanup, overflow close timeout, close tracking, both 4 MiB capture limits, and usage reservations through launch failure and timeout.

Local results: Node 24.18.0 passed all 40 tests; Go 1.26.7 passed `go test ./scripts/provider-proof-go` (1.26.0 is not installed in the local mise toolset); the final `git diff --check` passed. The capture limit is not evidence of a provider transfer-byte cap.

Owner key enrollment occurred on 2026-10-19 in PR #183 (SSH fingerprint `SHA256:Lw4hldSCL16q1Xjx9E6Mm2eTjloWf7KBDpjcuVKN6Sw`). That signing mechanism is retired with the harness. No T4/T5/T8/T14/T15 or A4–A9 provider-proof status changed through these local results.

The retained phase boundaries are:

| Phase/context | Preserved AWS | Shared Cloudflare verify | New AWS proof |
| --- | --- | --- | --- |
| Offline preparation | No requests | No requests | No requests |
| A4 discovery/inventory | Enumerated inventory reads | Metadata discovery first; content/lifecycle reads only after reviewed binding | Name-availability reads only |
| A5 provisioning | Separate preservation reads; no mutations | Preservation reads; no A5 mutations | Reviewed create plan and exact dependency reads |
| A5/A6 delivery | No proof requests | Proof-site writes, reviewed shared registry/app deltas and exact cache paths | Authorized bootstrap, delivery and cache operations |
| A7 proof | No proof requests | Proof-site operations; life frozen; separate preservation snapshots | Proof operations; life frozen |
| A8 setup | Preservation reads only | Dedicated lifecycle-owner context may add the exact reviewed life rule; separate proof identity seeds life | Life setup under A8; one-day module lifecycle established by A5 |
| A8 observation | Preservation reads only | Life-prefix HEAD/list and lifecycle reads only | Life HEAD/list/version reads only |
| A8 reconcile/cleanup | Preservation reads only | Gated life cleanup and exact lifecycle restoration | Gated reconcile, life cleanup and separately reviewed destroy |
| A9 | Preservation reads only | Preservation reads only | Released-pin-gated gzip proof |
| Final preservation | Bound read-only snapshots | Bound read-only snapshots | Absence/residue reads |

Proof runners cannot inherit inventory or preservation capabilities. Production, unrelated resources and unbound identifiers remain denied in every context. Preservation snapshots are separate read-only operations and remain available at scenario/cleanup checkpoints inside the active phase caps. Cloudflare lifecycle addition/restoration is authorized only by A8-short, even when setup is scheduled during A6.

Claude main prepares a concrete command sheet for each phase: Terraform plan/show/apply and output readback; hosted fixture dispatch/review; released CLI app/registry/site/preview commands and dry-runs; authenticated origin/CDN/browser reads; supported recovery; and exact cleanup. Use the inventory procedure above and case requirements below. Obtain chat OK before the corresponding transition; no launcher or fixed invocation ID is used.

Cleanup remains staged: after A7 remove only completed a/b/neighbor registrations as allowed by the readiness branch; preserve AWS A9 inputs and all unfinished life experiments. Final life cleanup follows a recorded completion/censor timestamp. Final AWS destruction follows A9 completed/not-run status and fresh exact-address/hash review; restore Cloudflare lifecycle before closing cleanup. A5 alone does not authorize early destruction. Both A5 and A8 decisions are required before provisioning this coordinated run. No approval grants broad cleanup.

### AWS provisioning / hosted runtime (P1/P2/P3/P8; A5)

Create only the named repo/environments after A4 has established name availability. Capture public repo IDs/OIDC prefix, create exact subjects and freeze the module root with source/version above, lockfile and variables. Generated setup uses non-default `aws.namePrefix: ap-proof-20261018`; configure helper's selected ARN and compare to Terraform output before allowing STS. The fixture workflows checkout source, use generated publish/preview workflow/composite (full reviewed SHA) and official Action pins; admin uses app-deploy/registry Actions. Record the job summary executed version and STS ARN; do not rely on bootstrap version. Required owner review of each environment dispatch precedes credentials.

Run Terraform directly under the dedicated provisioner identity; display the fresh saved plan, exact addresses and SHA-256 for owner chat OK before apply. Review output readback and fixture dispatch commands as part of that transition. After creation, review concrete resource IDs and narrowed policies before proof writes.

Expected resource list consists solely of one new S3 bucket/configuration/lifecycle/error object, one CloudFront distribution/OAC/function/cache/header policies, one admin and three satellite roles/policies and module guards, plus the test-only operator role/policy specified above. No replacements/changes of existing resources, no OIDC provider management, backend changes, DNS/ACM/WAF or unexpected costs. Full concrete addresses/count are reviewed from this fresh plan, not guessed from the older 22/25-resource deployments. A failure leaves state/logs protected; re-plan remaining delta and obtain approval before a recovery apply.

Before first writer, under admin and satellite credentials run `s3api head-object` and `get-object` on absent `_indexes/sites.json`, `_control/sites/proof-a-20261018/lock.json`, `_indexes/proof-a-20261018/index.json`, and complete allowed-prefix `list-objects-v2`; record errors separately without `|| true` hiding them. Admin bootstraps app and registry; satellite then publishes a. Denied and confirmed-absent reads must not be conflated. Never widen IAM for a passing bootstrap. Seed known neighbor index/artifact/manifest/control marker under admin, confirm SHA and exact existence, then run a's native GET probes and own-prefix positives; no destructive negative probe targets an existing neighbor key. P1 reads must fail AccessDenied while own reads succeed. Preserve prior default-prefix evidence; this is the generated custom-prefix case.

### Publication and browser matrix (A5/A6)

Synthetic fixture includes `nested/index.html`, `nested/readme.md` with inert script payload, CSS importing CSS, ESM importing a nested module, image/font/data files and a runtime-generated HTTP fetch that cannot be rewritten during build; known allowed HTTPS resource must be on an explicitly approved controlled public endpoint (use the same verify endpoint) with no external telemetry. Use real source changes and full fetch history to build preview heads; record main/head/merge-base. Direct logical and raw preview URLs are read before catalog selection and on reload. Include spaces, Unicode and reserved URL characters using existing fixture resource cases. CSP tests inspect enforced header, `securitypolicyviolation` and actual loaded modules/resource values; report-only CSP is a failure. Check raw missing document/resource 404 and `/_control/` **marker bytes absent**, allowing the accepted SPA fallback. Never put a real secret into that marker.

Review exact released CLI dry-run/write commands, preview source, browser fetches, hosted workflow dispatch and output paths in chat. For Cloudflare site sync, supply both the scoped R2 child and separate zone purge token; keep lifecycle administration in its separate A8 transaction.

Preview source is the reviewed non-main branch/commit with explicit registered repository identity. Set `PREVIEW_HEAD_SHA` to the full reviewed head SHA and `PREVIEW_DEFAULT_REF=refs/heads/main` in the synthetic repository, pin its resolved main SHA in the manifest, and verify both plus merge-base before every invocation; do not rely on nonexistent `origin/HEAD`. The preview is manual unless a hosted PR is explicitly in the fixture manifest. Authentic PR return-link provenance is not claimed from a synthetic local Git fixture. Use a fresh Playwright Chromium profile for initial matrix, a retained profile for mutable/removed/warm app cases, at the existing approved egress only. Record browser version/egress; real-device or alternate-egress checks require separate owner participation and approval and are not authorized by A1–A9. Before each write save/approve dry-run changes; **all** registry configs retain every pre-existing site. A6 proof capabilities cannot mutate lifecycle. The exact temporary Cloudflare life-prefix rule is a separate A8-short lifecycle-owner transaction, even when it is scheduled during A6; if ownership, current state or preservation-safe plans cannot be established, stop for a new review.

P8 commands (same on each target): deploy verified web A from `web-a.yaml`, warm the browser and fixed names, deploy B from `web-b.yaml`, reload and assert B, then deploy A and assert rollback. Each config differs only in `web.version`; both pin CLI 0.4.4. Use `app deploy --config FILE --dry-run --format json`, then the same without dry-run. Finally deploy the originally inventoried version (normally 0.3.2) and re-check its exact bundle hashes/browser. Do not use `--accept-breaking`, remove control/version records, or manually delete/retain hashed assets to mask the publisher's actual deployment behavior; record any failure of the warm session. Save screenshots/HAR with auth headers stripped, actual fixed-file bytes/digests and resource execution assertions. A fixed file identical in A/B proves revalidation only; require a changed fixed file (index.html) to establish the selected generation. Rollback is an actual deploy needing A5/A6, not implicit permission to touch production.

### Identity and request containment (mandatory before A7)

**Choice:** use hosted OIDC for reference-role claims and an SSO-derived, proof-only assumed operator session for local fault/CAS/recovery work. Never pass the unrestricted `artifact-pages-verify` SSO credentials to a local test process. Record STS ARN, credential source and effective session-policy digest per case; SSO-derived evidence must not be labeled reference-role/OIDC evidence.

| Case | Identity |
| --- | --- |
| A4 inventory; A5 create; A8 final destroy | SSO-assumed dedicated inventory role for A4; dedicated provisioner for A5 create/A8 destroy. Inventory may read the explicitly preserved stack; mutation plans contain only new proof resources. |
| P1/P2 AWS access boundaries/bootstrap; P3/P8 AWS publication; P7 successful reference-role update/unregister/invalidation | Hosted job assumes the exact new admin/satellite OIDC role appropriate to that operation; no SSO fallback. |
| P4/P5/P6 and P7 local injected-failure runs, `go test`, `TestAWSProductionBackendSmoke`, local `lock inspect/recover` and retry commands | SSO-derived, proof-only test-operator sessions with mandatory per-phase session policies. These local results are operator-session evidence. P7 additionally repeats the converged success path in hosted OIDC jobs for its reference-role claim. |
| P9 AWS HEAD/list observations and final reconciliation | Proof-only operator session for observations, hosted admin OIDC for ordinary reconciliation while fixture remains public/active; final infrastructure teardown uses the separate SSO Terraform identity. |
| P10 future local AWS gzip reads/writes | Same proof-only operator session, regenerated against the approved recreated stack if needed; any hosted Action claim uses its pinned new OIDC workflow. |
| Cloudflare cases | Inventoried verify-only scoped R2 children/registry reader and verify-zone purge token, as specified above; no AWS SSO/OIDC credentials. |

Create these AWS identities: `ap-proof-20261018-inventory` for A4 inventory/preservation snapshots only; `ap-proof-20261018-provisioner` for owner-supervised proof Terraform plan/apply/destroy; `ap-proof-20261018-test-operator` for local proof operations with mandatory phase/session restriction; `ap-proof-20261018-admin-publisher` for the exact hosted admin OIDC subject; three generated satellite roles for exact hosted a/b/neighbor OIDC subjects and their own site; and a separately renewed, read-only life-site observation session. No test, publisher, observer, browser or Go-test process receives SSO source credentials or provisioner credentials. AWS sessions last at most one hour and are renewed through owner-supervised assumption. No IAM users or access keys are created.

The inventory role trusts only the exact inventoried owner SSO role, with `MaxSessionDuration=3600` and assumptions ≤3,600 seconds. Use the corrected enumerated reads, exact backend/state and associated-resource bindings, prefix-limited state listing and unconditional `NotAction` deny described in A4 and the standalone policy. Do not bind a nonexistent proof distribution during A4. Later preservation snapshots may add only reviewed exact proof resources. Snapshot processes receive this identity separately from proof runners.

The test-operator role policy defines the maximum proof envelope; every assumption also supplies a narrower phase session policy. It permits only proof-prefix object GET/PUT/DELETE, conditioned prefix listing, necessary proof-bucket location/lifecycle/versioning reads, invalidation create/read on the bound proof distribution, and caller identity. Normal proof sessions do not receive `DeleteObjectVersion`, bucket configuration writes, IAM, role assumption, or infrastructure create/delete permissions. Version deletion belongs only to the separately approved final-cleanup session. A7 excludes life-site writes; A8 observation allows life-prefix GET/HEAD/list only, including AWS version listing where required; A9 allows only approved a/b and necessary control scopes.

Hosted roles retain the reference module allow statements and exact OIDC audience/subject matching. Admin operations use the admin role; site publication uses the matching satellite. Satellites can GET the exact registry and application-version keys, GET/PUT/DELETE and conditioned-list only their own `_indexes`, `_artifacts`, `_previews` and `_control/sites/<site>/` namespaces, and invalidate the proof distribution. They receive no bucket configuration or IAM rights. Proof-only permission boundaries are narrowing overlays around those reference allow policies; evidence must label them as overlays.

Every AWS mutating identity has explicit denies for S3 outside `ap-proof-231136241959-20261018`, CloudFront outside the concrete bound proof resources, the preserved bucket `artifact-pages-231136241959-us-east-1` and distribution `ECFTIR5GVPQDF`, IAM/STS privilege escalation, all other buckets/distributions and production targets. The inventory identity is the read-only preserved-resource exception. IAM cannot prevent anonymous reads of public production websites; Claude main restricts browser targets to the reviewed verification URLs.

The owner creates the inventory role, provisioner role, immutable proof permissions boundary and initially inert test-operator role using existing SSO credentials. This separately chat-approved bootstrap transaction is owner supervised; SSO credentials are never given to agent/test subprocesses. Review exact trust documents, policies, role names, boundary, commands and cleanup ownership before execution; capture policy readback and audit/request IDs. The provisioner cannot modify itself, its trust, the inventory role, test operator or owner boundary; cannot create users, keys, OIDC providers, instance profiles or attach arbitrary managed policies; and cannot pass or assume roles. It may manage only exact new admin/satellite roles, with `CreateRole` requiring the fixed proof boundary. Reviewed Terraform inputs and owner plan acceptance constrain policy/trust documents because IAM does not generally validate their contents against the saved plan.

The separate owner-supervised CloudFront creation session may use only named create actions on `"*"`, fixed request tags where supported and explicit denies for every inventoried resource. It can create more resources than intended if misused, so it is a documented bootstrap exception and never a test credential. After creation, capture IDs/state/configuration and review concrete bindings, then replace creation authority with exact-resource policy. Unbound IDs never authorize ordinary proof access.

The provisioner action matrix is enumerated in the checked-in IAM templates: exact proof bucket create/delete/list/location/tagging; bucket public-access, ownership, encryption, versioning, lifecycle and policy reads/writes/deletes; Terraform refresh reads for ACL, CORS, website, acceleration, request-payment, logging, replication and object-lock; object GET/PUT/DELETE/tagging only on the exact Terraform error object; role management only for exact new publisher roles; `iam:GetOpenIDConnectProvider` on the existing GitHub provider; exact proof distribution GET/config/update/delete/tagging; exact OAC GET/update/delete; four exact cache policies GET/update/delete; exact response-header policy and function management; and `sts:GetCallerIdentity`. Final JSON enumerates actions individually and splits creation/runtime/destroy permissions. Missing actions stop review; no `s3:*`, `iam:*` or `cloudfront:*` allow repairs a failure. S3 lifecycle IAM names are `s3:GetLifecycleConfiguration` and `s3:PutLifecycleConfiguration`, not SDK operation spellings.

Cloudflare credential classes remain separate: A4 bucket-scoped Object Read snapshots, separate verify-account R2 configuration reads, and zone reads as needed; 15-minute site-writer R2 children bound to the selected site prefixes; a separate read-only registry reader for `_indexes/sites.json` and `_control/versions/app.json`; app/registry transaction children restricted to reviewed shared keys and locks; A7 children excluding life and unrelated site writes; A8 observer HEAD/GET/list only with renewal per window; reconciliation writer issued only after completion/censoring; a separate zone-scoped `Cache Purge` token for `artifact-pages.stream`; and an owner-only account-wide R2 lifecycle administrator used only for the reviewed A8 add/restore transaction. Parents remain private with Claude main; only temporary children reach runners. Production account `9ac354c8aa31d424224d8c4f3aa8ba2a` is excluded from every token policy.

Keep the existing Cloudflare verify deployment and shared bucket. A permanent Object Read/Write token scoped to that bucket can reach other keys and is not a site-runner credential. App/registry children may affect shared keys and inventoried original-site locks in their exact scope. Cache Purge is zone-wide and may purge other `artifact-pages.stream` URLs. R2 lifecycle administration can alter other buckets/configuration in the verify account, and lifecycle PUT replaces the bucket's complete rule set. Use the existing owning state, review complete before/after rules, then revoke that token. These are recorded residual authorities; provider authorization does not constrain JSON contents, purge URLs emitted by an external binary or lifecycle rule semantics.

Run unmodified Terraform, AWS CLI and artifact-pages CLI directly with reviewed executable, arguments, working directory, inputs and outputs; never `eval` shell strings. Use isolated HOME/config directories and explicit selected identities. Remove inherited credentials/profiles, credential processes, SSO caches, metadata sources, proxy/endpoint overrides, SSH agents, GitHub tokens and unrelated Cloudflare credentials from test environments. Disable AWS metadata discovery. Do not mount host credential directories or the Docker socket into test containers. Keep SSO source/provisioner credentials out of test and hosted jobs. Review Terraform provider/backend identities so embedded profiles cannot select a broader identity. Use normal HTTPS certificate verification.

Before every phase and every renewed credential, read identity and authoritative policy metadata (separately where needed; `GetCallerIdentity` alone does not prove scope), compare trust/inline/attached/boundary/session-policy digests, resource bindings and expiry with the reviewed bindings, run allowed read/list controls, and run forbidden reads against independently confirmed existing targets. Only the expected authorization error proves a denial; timeout, 404, malformed response and endpoint errors do not. Record provider code, request ID if supplied and sanitized target. AWS proof credentials must receive AccessDenied for preserved bucket GET/list and preserved distribution GET; satellite a must be denied existing b/neighbor artifact/index/preview/control reads while own-site reads succeed. R2 writers must be denied existing neighbor objects, unauthorized registry/control keys, prefix-boundary siblings and unrelated known verify buckets. Registry readers are limited to exact read keys. Inspect account/zone policy for production exclusion without contacting production. AWS policy simulation supplements live probes for write/delete/lifecycle/IAM/invalidation denials. Never use destructive negative probes against preserved objects, lifecycle configuration or preserved distributions. After initial verification, use only disposable canaries for positive writes and denied cross-site writes/deletes; unexpected success stops the phase as a boundary failure.

**Staged target review.** Before each external transition, obtain chat OK for concrete commands and resolved targets. Discovery permits only enumerated reads against known verification anchors. Review discovered Cloudflare bucket/zone bindings before content/lifecycle reads, completed inventory before provisioning, and actual IDs/policies after A5 apply before proof requests.

Inventory and preservation use separate read-only capabilities for the explicitly preserved verification resources. Proof runners cannot inherit those capabilities and reject preserved AWS targets. Preservation snapshots remain permitted at scenario and cleanup checkpoints within the active approval's caps.

Cloudflare lifecycle addition and restoration are dedicated A8-short operations, including when setup is scheduled during A6. They use the existing lifecycle owner/state, fresh reviewed plans and full preservation-checked API readback. A6 alone grants no lifecycle mutation. Necessary existing-backend state/lock writes are confined to this reviewed lifecycle transaction.

Direct invocation does not intercept released subprocess requests or enforce their HTTP bodies, retry counts, invalidation paths or costs. Provider policies constrain authority; Claude main reviews targets/inputs and tracks conservative usage/retry allowances. Do not claim complete accounting of opaque retries. The retired fake containment tests and in-memory coordinator do not prove live isolation or product recovery. Keep the real publisher deterministic tests, `aws_live_smoke_test.go`, `preview_flow_live_smoke_test.go` and version-cleanup tests.

### Controlled failures, overlapping processes and cache retries (A7)

**Supported direct execution:** native conditional-write smoke, separate real CLI writers, externally observable interruption/recovery, confirmed missing-manifest cleanup, canonical warm-URL update/unregister and successful invalidation. An invalidation failure/retry or exact interruption is supported only when the reviewed mechanism can actually establish that cell. Record the commands, disposable keys, process IDs, observed stage, recovery ETag and preservation comparisons case by case.

**Unsupported cells stay open / not-run.** Exact internal barriers and injected failures inside an unmodified released CLI are unresolved. Approximate timing, fake Go coordinator results or deterministic product tests do not pass these live cells. Stop that cell when its barrier cannot be observed or its fault cannot be induced, and name the missing mechanism. Do not finish the retired harness, add production fault flags, alter shared IAM to force a denial, forge provider responses or report a fake failure as a provider outage. Deterministic product tests remain useful at their own boundary.

Run P4–P7 serially by case/provider; within a scenario only the designated competing processes overlap. AWS CAS can reuse the existing opt-in `TestAWSProductionBackendSmoke` with its exact environment/confirmation contract in [aws_live_smoke_test.go](../../../cli/internal/publisher/aws_live_smoke_test.go); it cleans **all versions/delete markers** in its random key prefix and needs the authorized test operator's version cleanup privileges, not satellite permission broadening. The existing preview-flow smoke remaps lock/catalog to a random namespace and explicitly excludes interruption/lock-loss; it cannot substitute for actual CLI cases here.

Outstanding precise fault schedule (coverage requirements, **not a claim of executable mechanisms**):

| Cases | Precise barrier / fault and recovery |
| --- | --- |
| P4 AWS race | Start two separate CLI processes at different new heads/groups under same site; pause a after first immutable PUT, observe b waiting on held lock with no writes, release a, both complete; confirm both manifests/files/catalog groups. Then SIGKILL another head after first successful file PUT; no catalog advert; inspect stopped owner, guarded ETag recovery, same-head retry. Recover/reacquire while old writer paused, resume it, require stale-owner rejection. |
| P4 both remaining | After completed manifest PUT but before catalog PUT: kill writer, keep complete unadvertised revision, guarded recover and retry. Separately refuse the next exact catalog PUT before sending; failed attempt does not advertise head; retry uses immutable completed bytes unchanged and adds it once. |
| P5 concurrency | Pause production a after first successful artifact PUT, start b and observe b successfully writing its own site before releasing a (proves overlap, not only locks); both complete. Compare both builder projections, private state, neighbor/app/registry guards. |
| P5 production recovery | Separate runs refuse one exact artifact/index/meta PUT; fail after first stale DELETE; refuse each initial listing / continuation page before mutation; steal/reacquire lock after production commit before preview cleanup. Check index/meta/content ordering and no stale deletion before switch, recorded partial deletion preserved as recoverable state, retry completes and second retry no-op. Continuation case seeds >1,000 objects under a (within cap). |
| P6 cleanup | Admin deletes only a disposable revision's completion manifest, with another intact and unknown/error candidate in same catalog. Inject 403, 503 and timeout reads one at a time; never call them absence. Fail production write before switch, then fail catalog write after successful switch in a separate run. Retry normal site sync; assert keep/remove reasons and exact catalog before/after; warm reader availability distinguishes missing from unknown. |
| P7 invalidation | First seed canonical warm responses, then refuse only the cache request after successful registry/app/site/unregister origin changes. Save pending retry bytes/ETag and origin hashes. Remove refusal, identical dry-run must not write/clear, real retry must submit exact pending path set even when object diff is zero; save real CloudFront invalidation ID/completion or Cloudflare purge success, clear record only on success. Refusing the request client-side proves deployed retry with a real successful second call, not provider outage behavior. |

Never recover an active unknown lock. Stop known child processes, capture ETag directly from `lock inspect`, require owner approval A7 for that named recovery, and use that exact ETag; mismatch stops and re-inspects. No unconditional delete/free-lock overwrite. SIGKILL stage does not authorize continuing after an unexplained owner change.

P7 freshness measurement: canonical URLs without cache-busting query, GET every 5 s for <=5 minutes per transition, <=60 probes per URL; save Date/Age/ETag/Cache-Control/Vary/Content-Encoding/cache result. Record observed interval, not a fabricated global SLA. Review direct invalidation-completion polling commands and their request allowance before execution. Assert actual origin state via authenticated reads and complete lists. After accepted invalidation, failure to converge within the test's 5-minute observation bound is a failed/unfinished sample requiring investigation, not proof of a new documented product guarantee. Only hosted AWS operations establish reference-role evidence through the new OIDC roles; local fault/recovery runs use the proof-only SSO-derived session and are labeled separately. Cloudflare operations use verify-only scoped identities and the separate purge token.

### Sequencing (A8-short and A9)

A4 → A5 → A6 → A7 → close A8-short observation → A9 → immediate teardown. Start the A8 life clocks during A5/A6 so observation overlaps A7; the displayed sequence refers to final proof completion.

At the end of A7, check whether released CLI v0.5.0 and all four Actions v0.3.0 are obtainable, their checksums/full source SHAs and release metadata are verified, the pin amendment is reviewed, and local ISSUE-112 migration/recovery acceptance passes.

- **Ready:** reuse the same disposable AWS stack for A9. Retain AWS a/b registrations, their complete pre-0.5 projection and control state, and the neighbor needed for preservation checks. Retain life only until A8-short closes. Run A9 immediately afterward, within its one-hour allowance, then destroy.
- **Not ready at A7 completion:** do not retain resources waiting for the release. Censor unfinished A8-short observations, record A9 not-run, clean up and destroy immediately. A later A9 requires fresh disposable resources, a fresh inventory/create plan and owner acceptance; never reuse a stale saved plan.

Remove completed Cloudflare proof data and restore its baseline as soon as its own observation closes; AWS A9 does not justify retaining Cloudflare proof resources.

Before A9, snapshot complete a/b projection and matching control state. A one-day lifecycle may already have expired old previews: record that fact, and prepare any required A9-only preview fixture with a new head **after** A8 closes. Never reset life-object ages. After migration, use compatible ≥0.5 writers for reconciliation and cleanup; CLI 0.4.4 is permitted only for the deliberate pre-write rejection check.

The five-day lifetime is a ceiling, not a reservation. There is no additional release-waiting period. Start teardown immediately when the remaining proofs finish or are censored.

### Natural expiry (P9; A8-short)

**AWS configuration.** Keep `preview_retention_days = 1` on the new disposable AWS module only. In `terraform/modules/aws/main.tf`, this sets both `expire-preview-projection.expiration.days` and `expire-noncurrent-preview-projection.noncurrent_version_expiration.noncurrent_days` to one, scoped to `_previews/`. Leave expired-delete-marker cleanup enabled and incomplete multipart-upload abort at seven days. Do not change bucket versioning or directly overwrite the module-owned lifecycle configuration.

**Cloudflare configuration.** The module’s `preview_retention_days = 1` maps to `delete_objects_transition.condition.max_age = 86400`, but its filter is the whole `_previews/` prefix. **Do not lower that input on the shared verification bucket.**

Instead, preserve every inventoried lifecycle rule and add exactly one temporary rule through the existing lifecycle owner’s `additional_lifecycle_rules`:

```hcl
{
  id      = "proof-life-20261018-expire"
  enabled = true
  conditions = {
    prefix = "_previews/proof-life-20261018/"
  }
  delete_objects_transition = {
    condition = {
      type    = "Age"
      max_age = 86400
    }
  }
  abort_multipart_uploads_transition = {
    condition = {
      type    = "Age"
      max_age = 604800
    }
  }
}
```

This uses the existing module input; the current verification root does not forward that input, so its isolated execution copy needs a reviewed caller-only addition. Use the **existing owning state**, never a second retention resource/state against the bucket. The plan must contain only the expected lifecycle-rule addition; existing rules and zone-root policies remain unchanged. Review the full API readback after apply. If policy ownership, credentials or a preservation-safe plan cannot be established, mark Cloudflare P9 blocked; do not broaden permissions or substitute a bucket-wide change.

The temporary multipart setting retains the module’s seven-day behavior and combined-rule shape; this experiment does not prove multipart expiry. Cloudflare’s lifecycle API replaces the complete rule set, so preserving unrelated rules is mandatory. [Cloudflare lifecycle API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/lifecycle/methods/update/)

**Timing.** One-day retention is an eligibility setting, not a promise of deletion after 24 hours. S3 adds one day to object creation/LastModified and rounds eligibility up to the next midnight UTC: approximately 24–48 hours after upload. Deletion then occurs asynchronously. Use another **24–48 hours after eligibility as a planning allowance**, not an AWS guarantee; allow approximately **48–96 hours from upload**. [S3 age calculation](https://docs.aws.amazon.com/AmazonS3/latest/userguide/intro-lifecycle-rules.html), [S3 expiration behavior](https://docs.aws.amazon.com/AmazonS3/latest/userguide/lifecycle-expire-general-considerations.html)

For R2, record the actual `x-amz-expiration` header and lifecycle readback. Cloudflare documents removal typically within 24 hours after expiration, with possible longer delays. Allocate up to 48 hours after eligibility for this bounded experiment; that allowance is not a service guarantee. [R2 lifecycle behavior](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)

**Setup and checks.**

1. Seed the life experiment during A5/A6, within eight hours of first AWS resource creation. Finish all life-site setup, publish exactly one completed preview revision, then freeze the experiment. Record registry/catalog bytes, every preview key, content hash, ETag, LastModified, metadata, initial successful HEAD, lifecycle rules and expiration headers. Use a small fixture to stay within existing request caps.
2. Do not republish, copy, touch, remove, unregister or reconcile life data during observation. A7 must exclude the entire life site from injected failures and cleanup.
3. Observe authenticated origin HEADs and complete prefix listings every three hours, with a final observation at the deadline. Record per-key eligibility and `[last-present, first-absent]` UTC intervals. Require confirmed missing exact keys **and** complete listing agreement. A 403, timeout, malformed response or partial listing is an error, never absence.
4. On AWS, also list all versions/delete markers and record bucket versioning. Current-key disappearance can involve a delete marker in a suspended-versioning bucket; report logical absence separately from permanent removal of stored versions. Do not wait beyond the cap merely to obtain marker cleanup.
5. Preserve the untouched catalog until its natural-expiry outcome is recorded. Once observation is closed, run ordinary `site sync` once. If a catalog survived with a confirmed-missing manifest, verify normal pruning. If the catalog also expired, record converged absence without claiming a pruning event. Record warm-reader behavior separately from origin deletion.
6. Close each provider’s observation immediately when the result is established. Otherwise stop at the earlier of **latest life-key eligibility + 48 hours** or **AWS creation + 108 hours**. Record incomplete observations as censored and leave their proof criteria open. Early teardown for the A9 readiness gate also censors any unfinished observation.

**Proof boundary.** Successful observations establish the sampled provider’s natural one-day lifecycle mechanism and any actually observed reconciliation. They do **not** establish production seven-day configuration, seven-day survival, the original seven-day observation coverage, exact deletion timing, worldwide cache withdrawal, noncurrent-version expiry or multipart cleanup unless separately measured. Do not close broader criteria using the shortened sample alone.

Manual deletion begins only after the observation’s completion/censor timestamp is recorded and is reported as cleanup, never natural expiry.

### Gzip follow-up (P10; A9, blocked until release)

Review the released writer command and the separate raw-origin reads/decoding, CDN fetches and browser checks together in the A9 command sheet; obtain owner chat OK against the verified release tuple and full pre-migration snapshot.

Repeat for the exact search manifest key emitted by the builder (freeze it in manifest, do not invent a key), small and large decoded fixtures, cold first URL and same-URL warm reads before/after an update. No `--compressed` for raw origin/hash evidence. Check Content-Type application/json, Content-Encoding gzip, inline disposition/cache, stored length/hash and decoded JSON equality; gzip concatenation/corruption constraints belong to local acceptance. Opaque search pack encoding/hash contract and source artifact bytes remain unchanged. Record CDN representation separately if it transforms compression. Browser JSON/full-text reads must work at unchanged URLs. A failed timing threshold is reported; no deadline or throughput policy changed. Supported writer rollback is >=0.5.0 with the encoding policy, content reverted by compatible writer; independent web rollback remains allowed. Never delete control state to downgrade. Full pre-0.5 projection/control restore is exceptional and needs a new owner recovery plan.

## Cost, interruption and cleanup contract

These are **authorization ceilings and conservative planning allowances**, not quoted tariffs/free-tier guarantees. No paid load test, new domain, WAF, account subscription, billing setup or plan upgrade. Verify current rate/remaining free allowance under A4 with owner billing context before apply; no assumption of a free tier. Track command usage conservatively against the ceilings even when budget dashboards lag. External subprocess retries and per-request cost cannot be fully accounted for, and provider credentials do not enforce a hard dollar cap.

- Overall provider work: <=14 operator hours including up to one hour final teardown, excluding owner waiting and unattended lifecycle polling; <=120 hours / five days retained lifetime from first AWS resource creation through final teardown; <=1 GiB objects per provider, <=5 GiB CDN transfer/provider, <=50,000 storage operations/provider, <=5,000 viewer requests/provider, <=200 CloudFront invalidation paths total across A5/A7/A9. Estimate $1–15 total, combined authorization ceiling **$20** (A4–A9); stop before either cap, no automatic increase. These are conservative planning ceilings, not provider-enforced spending caps. Per-request caps below are subordinate to total. Logs include direct calls, subprocess bounds, bytes/minutes and censored measurements; they do not claim complete per-request accounting of opaque SDK retries.
- A5 <=4 hours, AWS estimate $0–5/cap $5; A6 <=2 hours CF estimate $0–2/cap $2; A7 <=4 hours combined estimate $0–6/cap $6; A8-short <=48 hours after latest eligibility and <=108 hours from AWS creation/1 operator hour plus <=60 minutes final teardown estimate $0–1/cap $1; A9 <=1 hour estimate $0–5/cap $5. A4 <=30 minutes estimate $0–1/cap $1. Hosted fixture A1–A3 costs are separate, <=$7 total. No price-dependent automation that can exceed caps.
- Stop before each apply, app version switch, supported fault/recovery, visibility/access change and lifecycle setup until its corresponding approval is recorded. Additional stops: changed inventories, unknown writer, pending retry, hash drift, failure to restore baseline, lost credentials, scope/budget/deadline exceeded or any assertion mismatch. Do not advance to another scenario to “get more evidence” after a preservation failure.
- When any per-approval or overall time window is exhausted, stop starting work, pause at the next safe interruption point (cancel immediately if safe), report completed work/residual resources/cost and obtain renewed approval before continuing; no automatic extension. Reserve time for this safety stop before the budget expires; it authorizes no further experiment or unapproved cleanup. If the 120-hour/five-day lifetime cannot be met, stop at the A8-short deadline, notify the owner before it expires and request an explicit cleanup/retention extension; do not silently exceed the cap or delete uncensored life data to hide the overrun.
- On interruption terminate only recorded child PIDs/runner jobs, revoke/let expire only created sessions, retain retry/state and exact key list. Recovery remains guarded; no broad delete. Report last completed operation, residual keys/locks, pending invalidations and next safe action. An interrupted cleanup is not success.

## Cleanup sequence

1. Stop recorded test writers, capture evidence and resolve pending transactions with the compatible writer. Restore the inventoried Cloudflare web release and verify origin/browser hashes. Unexpected concurrent changes stop restoration for reconciliation.
2. At A7 completion, apply the readiness branch above. When reusing AWS for A9, `post-a7` cleanup must preserve AWS a/b, its neighbor guard and life. On Cloudflare, remove only completed a/b/neighbor proof registrations, retaining life and every original registration. Review each registry dry-run before execution.
3. After each provider’s A8-short result or censor timestamp, remove its life registration with the normal guarded registry workflow. Restore the Cloudflare lifecycle configuration by removing **only** the temporary rule through the same owning state, with a fresh reviewed plan and API readback. Do not destroy the lifecycle resource: its provider delete operation leaves API rules behind.
4. Once A9 completes—or A9 is recorded not-run at the A7 readiness gate—remove remaining AWS proof registrations using the correct writer version. Snapshot all versions/delete markers; produce an explicit key/version deletion manifest for this wholly new bucket only. Delete in batches of at most 1,000, inspect per-object errors and relist. Never empty the preserved AWS verification bucket or the shared R2 bucket.
5. Generate a fresh destroy plan from proof state only. The owner reviews exact addresses and hash before apply. Remove all A5-created resources, including the test-operator role/policy; preserve the pre-existing OIDC provider. Do not enable `force_destroy`. Allow up to 60 minutes for teardown; report any remaining billing resources and escalate before the five-day cap rather than silently extending it.
6. Keep the GitHub fixture callable until all hosted reconciliation/A9 jobs finish. Then remove proof-only secrets/variables/environments, make the fixture private/inert and disable workflows as already authorized. Preserve run/PR evidence; do not delete the repository.
7. Re-inventory preserved AWS/Cloudflare resources, original registry/app hashes, lifecycle configuration and unrelated objects. Record costs, elapsed time, residue and absent AWS proof resources. Retain sanitized evidence; keep incomplete proof criteria open.

All references elsewhere to seven days of A8 observation or nine days of retained lifetime are superseded by the deadlines above.

## Ordered host runbook

These phases are for the **main Claude session on the host**. Codex’s sandbox is not the execution environment: it cannot provide the required port binding, reliable GitHub API access or operator credential access. The host supervises Linux containers under Docker Desktop on the Mac; record host and container details separately so local container execution is not described as macOS execution.

The October 20 decision retires the launcher, signatures/seals, invocation registry and fake coordinator. Use direct released tools, the standalone policies and private evidence directory. No production credentials enter this run. Review complete concrete commands and outputs in chat at each gate.

1. **Prepare.** Freeze source/tool/release pins, rendered policies, exact command sheets, expected deltas, evidence locations, phase/combined caps and cleanup branches. Keep A1–A3 completed evidence. Unresolved inputs needed by the next step stop that step.
2. **A4 inventory.** Owner supplies SSO login/billing context; Claude main uses dedicated read-only identities and the A4 procedure above. Confirm AWS/Cloudflare bindings, complete snapshots/state comparisons, pins, permissions and freeze. Full Cloudflare refresh waits for dashboard-confirmed read-only groups; do not silently substitute edit permissions. Request an estimated extension before 30 minutes/usage allowances would be exceeded.
3. **A5 AWS.** Obtain chat OK for exact create addresses/saved-plan hash, trust/policies, fixture/environment changes, hosted OIDC commands and app switches. Apply only the fresh disposable local-state stack, bind actual IDs, run absent-key probes before app→registry→site bootstrap and P1/P2/P3/P8. Seed life under the separate A8-short approval and record creation time.
4. **A6 Cloudflare.** In the agreed freeze use scoped children and the separate purge token for P1/P3/P8; preserve full registry membership and restore the original web. Life setup is a separate A8 lifecycle-owner plan/hash/full-policy approval, never an A6 lifecycle mutation. Both life baselines must be recorded within eight hours of AWS creation.
5. **A7 recovery.** Review commands, disposable targets, fault mechanism, PIDs, ETag and preservation checks case by case. Run supported cells; leave unsupported precise faults open/not-run. At completion apply the A9 ready/not-ready branch above. If not ready, censor unfinished life observations, record A9 not-run and tear down immediately. Otherwise preserve AWS a/b/neighbor and unfinished life; remove only completed proof data permitted by the branch.
6. **A8-short.** Use read-only HEAD/list observers every three hours, plus AWS version/delete-marker listing, until completion or the earlier of eligibility+48h / AWS creation+108h. Record completion/censoring before ordinary reconciliation or manual deletion. Review exact Cloudflare lifecycle restoration plan/full-rule readback and cleanup manifests in chat. Observe ≤1 operator hour, ≤1h teardown, $1 and ≤120h total lifetime.
7. **A9 gzip.** After life observation closes, obtain chat OK for verified released CLI 0.5.0 / Actions 0.3.0 SHAs, checksums/ranges, exact commands, full pre-migration snapshot and compatible cleanup writer. Run migration, raw gzip/hash/metadata, small/large CDN/browser, same-URL update, no-op/repair/recovery and old-writer rejection checks within ≤1h/$5. No release waiting beyond the A7 readiness gate; later recreation requires fresh approval.
8. **Teardown.** Follow the cleanup sequence in order. Review exact key/version batches and a fresh proof-state-only destroy plan, addresses and hash before apply. Restore Cloudflare lifecycle/app/registrations and compare preserved snapshots. Complete within the retained lifetime; report residue, actual usage/cost and sanitized evidence, keeping incomplete proof criteria open.

## Owner approval status

- A1 — Approved and executed 2026-10-18. Two IMP-64 package guard PRs/comments/closures and branch cleanup; <=45 min, <=$2; blast radius: test branches/PRs in the two generated module repos only, no tags/settings. Evidence: [IMP-64](../implementation/IMP-64-generate-sync-terraform-packages.md).
- A2 — Approved and executed 2026-10-18. IMP-73 public fixture preparation, registry PR and caller-environment proof including owner deployment review; <=90 min, <=$3; blast radius: two named fixture repos, dummy secrets, branches/PRs and verification environment only. Evidence: [hosted fixture execution record](hosted-fixture-preparation-2026-10-18.md#execution-record).
- A3 — Approved and executed 2026-10-18. IMP-73 private/private omitted-environment proof and private inert retention; <=45 min, <=$2; blast radius: visibility and repo-local Actions access/dummy secrets of the same two fixture repos only. Evidence: [hosted fixture execution record](hosted-fixture-preparation-2026-10-18.md#execution-record).
- A4 — Approved 2026-10-18. Read-only inventory, preservation, target/pin/tool/billing checks, policy inspection and read probes; ≤30 minutes/≤$1. Dedicated read-only identities only. Owner bootstrap of missing identities is a separately chat-approved administrative prerequisite, not an A4 read operation. Execution requires identity/policy readback, fresh applicable positive/negative read evidence and owner chat OK for the concrete commands/plan; the October 20 method supersedes signing/sealing requirements.
- A5 — Approved 2026-10-18. Fresh named AWS proof stack, bounded owner bootstrap/provisioning, proof-only operator and OIDC identities, custom-prefix bootstrap/delivery, warm upgrade/rollback, and fixture scope already recorded; ≤4 hours/≤$5. CloudFront creation authority is an explicit owner-supervised exception. Concrete resource IDs and narrowed policies require post-create review in chat before proof writes. Execution requires identity/policy readback, fresh applicable positive/negative read evidence and owner chat OK for the concrete commands/plan; the October 20 method supersedes signing/sealing requirements.
- A6 — Approved 2026-10-18. Existing Cloudflare verify delivery, four proof sites, scoped children, and reviewed shared app/registry upgrade/rollback; ≤2 hours/≤$2. Shared-key and verify-zone purge authority are recorded residual risks. No lifecycle or zone-policy mutation. Execution requires identity/policy readback, fresh applicable positive/negative read evidence and owner chat OK for the concrete commands/plan; the October 20 method supersedes signing/sealing requirements.
- A7 — Approved 2026-10-18. Both-provider concurrency, supported controlled failures/recovery, reconciliation, and invalidation retries; ≤4 hours/≤$6. Credentials exclude life writes and unrelated site writes. Unsupported exact fault scenarios remain unproven. Execution requires identity/policy readback, fresh applicable positive/negative read evidence and owner chat OK for the concrete commands/plan; the October 20 method supersedes signing/sealing requirements.
- A8-short — Approved 2026-10-18. Existing one-day experiment, life cleanup, exact owner-operated Cloudflare lifecycle addition/restoration, and final AWS teardown. Preserve the merged amendment’s limits: observation ends by latest eligibility +48 hours or AWS creation +108 hours; infrastructure retention ≤120 hours; ≤1 operator hour plus ≤60 minutes teardown; ≤$1. Observation uses read-only credentials. Lifecycle administration and fresh destroy plans require their own exact-plan/hash chat OK. Execution requires identity/policy readback, fresh applicable positive/negative read evidence and owner chat OK for the concrete commands/plan; the October 20 method supersedes signing/sealing requirements.
- A9 — Approved conditionally 2026-10-18. Reviewed released tuple and AWS gzip proof; ≤1 hour/≤$5. Verify actual released CLI/Action hashes and compatibility before chat OK. Use newly verified phase credentials; retain the merged readiness/cleanup branches. Recreation or exceptional downgrade requires the existing fresh approval. Execution requires identity/policy readback, fresh applicable positive/negative read evidence and owner chat OK for the concrete commands/plan; the October 20 method supersedes signing/sealing requirements.
