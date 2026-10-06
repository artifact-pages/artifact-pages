# IMP-66 — Widen the AWS IAM `_control/*` scopes so CLI control paths do not need module changes

- Status: Open
- Lanes: Terraform / AWS
- Depends on: design check below (owner review before implementation)
- Sequencing: land **after** the `cli-sync-remove` change (in flight, touches `terraform/modules/aws/main.tf` and `deployment.test.js` for the same `_control/*` reason) to avoid conflicts, and rebase on [IMP-63](IMP-63-consolidate-terraform-modules.md) if that merges first (it rewrites the same file)
- Related: [TD15](../technical-design/TD15-terraform-module-source-of-truth.md) (decision 2026-10-07: independent module versions), [IMP-64](IMP-64-generate-sync-terraform-packages.md), [IMP-44](IMP-44-aws-waf-custom-rules.md)

## Goal

Make the AWS module's IAM policies grant `_control/*` by prefix wherever it is safe, so that a new CLI control-record path no longer requires a module change. This is the precondition for releasing the AWS module independently of CLI releases ([TD15](../technical-design/TD15-terraform-module-source-of-truth.md)). Cloudflare needs nothing: its credentials are bucket-level.

## Why

Module commits that co-changed with CLI code on `origin/main` are all AWS IAM scope additions: `81117714` (site cache and durable retries), `deabd108` (publish state), `037263f7` (app/registry cache retry). `cli-sync-remove` adds about 12 lines to `terraform/modules/aws/main.tf` (`_control/preview-cleanup/*`, app-bundle delete scopes) for the same reason.

## Design check (done 2026-10-07, read-only; owner review required)

Sources: `terraform/modules/aws/main.tf` on `origin/main` (`9e4a29b9`) and `git diff -- terraform/modules/aws/` of the `cli-sync-remove` worktree (uncommitted, not modified). The CLI's `_control/` keys in use: `locks/registry.json`, `locks/application.json`, `locks/sites/<site>.json`, `site-cache/<site>.json`, `publish-state/<site>.json.gz`, `registry-cleanup.json`, `app-cache/retry.json`, and (cli-sync-remove) `preview-cleanup/<site>.json`.

### Current `_control/*` statements

There are two roles, not one: the **admin** role (`<prefix>-admin-publisher`, whole registry and app plane) and one **satellite** role per site (`<prefix>-<site>-publisher`, scoped to its own site). "Publisher" in the brief covers both; they need different answers.

Admin role (`local.admin_statements`), all `Resource` entries under `${bucket_arn}/`:

| Statement | Action | `_control` entries (origin/main) | Added by `cli-sync-remove` |
| --- | --- | --- | --- |
| `ListProjectionPrefixes` | `s3:ListBucket` (prefix condition) | `_control/locks/*`, `site-cache/*`, `publish-state/*`, `registry-cleanup.json` | none (no list of `preview-cleanup`, `app-cache`) |
| `ReadRegistryAppAndControlState` | `s3:GetObject` | `locks/*`, `site-cache/*`, `publish-state/*`, `registry-cleanup.json`, `app-cache/retry.json` | `preview-cleanup/*` |
| `WriteApplicationRegistryAndControlState` | `s3:PutObject` | same five | `preview-cleanup/*` |
| `DeleteUnregisteredProjectionObjects` | `s3:DeleteObject` | `registry-cleanup.json`, `site-cache/*`, `publish-state/*`, `app-cache/retry.json` (not `locks`) | `preview-cleanup/*`, plus app keys (`index.html`, `preview-bridge.js`, `LICENSE`, `THIRD_PARTY_NOTICES.txt`, `assets/*`) |

Satellite role (`aws_iam_role_policy.satellite`, per `<site>`), exact keys only:

| Statement | Action | `_control` entries (origin/main) | Added by `cli-sync-remove` |
| --- | --- | --- | --- |
| `ReadRegisteredSiteAndLock` | `s3:GetObject` | `locks/sites/<site>.json`, `site-cache/<site>.json`, `publish-state/<site>.json.gz` | `preview-cleanup/<site>.json` |
| `ListSelectedSiteProjection` | `s3:ListBucket` | the same three keys as list prefixes | none |
| `WriteSelectedSiteAndLock` | `s3:PutObject` | the same three | `preview-cleanup/<site>.json` |
| `DeleteSelectedSiteStaleObjects` | `s3:DeleteObject` | `site-cache/<site>.json`, `publish-state/<site>.json.gz` | `preview-cleanup/<site>.json`, `_previews/<site>/*` |

No other role touches the bucket: CloudFront reads only through the OAC bucket policy (`AllowCloudFrontOACReadOnly`), and the module has no reader role. `/_control/*` has no CloudFront behavior, so the keys are never served.

### Proposed consolidation

1. **Admin role: widen to the prefix.** Replace the five-to-six enumerated `_control` entries in the Read, Write and Delete statements with a single `${bucket_arn}/_control/*`, and the List prefix entries with `_control/*`. Rationale: the admin already holds read/write on every record under `_control` and delete on all but `locks`, and it administers the whole registry. The only new capability is `DeleteObject` on `_control/locks/*` (and on future records); lock deletion is what lock recovery needs and the admin can already overwrite locks. Optionally keep `locks/*` out of Delete in the policy if the CLI never deletes locks (verify against `cli/internal` lock code before choosing).
2. **Satellite role: do not grant `_control/*`.** A site's role must only touch its own records. Prefix-level `_control/*` would let any one site's GitHub workflow (including a preview from a PR in that site's repository) read, overwrite or delete the locks, publish state, cache-retry and cleanup records of every other site and the registry/application locks, which breaks the per-site isolation the module documents ("do not broaden satellite storage access to another site, the registry, or the application plane"). The per-site exact-key scheme is also what makes the object ARNs safe from site-id collisions.
3. **Satellite role: per-site wildcard by convention (option for the owner).** Reduce the need for module changes without breaking isolation by requiring every per-site control record to live at `_control/<kind>/<site>.json` or `<site>.json.gz` (`locks/sites/<site>.json` is the one existing exception) and granting `_control/*/<site>.json` and `_control/*/<site>.json.gz` (S3 resource patterns: `*` also matches `/`). A new per-site record kind then needs no module change; a new global (non-per-site) record is simply not reachable by a satellite, which is correct. This is the proposal for the owner to approve or reject; if rejected, satellites keep exact keys and AWS stays coupled to CLI releases for satellite-scoped records only.

### Roles that must NOT gain `_control/*`

- Every satellite role: no prefix-level access (see 2). Per-site wildcard (3) is the most that is acceptable.
- No role should gain `_control/private/*` or similar sentinel/test paths unless a verification profile needs it; the verification deployment (`cloudflare-verify` and the AWS verify caller) must keep working with its own policy.
- CloudFront OAC: must not gain `_control/*` (stays read-only on the content paths that have behaviors). Check that the bucket policy resource is `bucket/*` today (`local.bucket_objects`) and that the missing behavior for `/_control/*` is what keeps it unserved; the widening in this item does not change the bucket policy, but a regression test should assert it.

### Risk assessment

- Admin widening: low. Same principal that already runs lock, cache, state and registry cleanup; new exposure is future control records and `DeleteObject` on `locks/*`. Blast radius is the admin OIDC subject (exact subject inputs), unchanged.
- Satellite per-site wildcard (3): medium-low. Collision risk if site IDs are not constrained: `_control/*/<site>.json` also matches `_control/app-cache/retry.json` for a site named `retry` and `_control/*/registry-cleanup.json` for a site named `registry-cleanup`, and, because `*` crosses `/`, `_control/locks/sites/<site>.json`. Mitigation: reject or reserve such site IDs in the registry validation (check the existing site-ID rules; the `locks/sites/` directory is already per-site), and keep a test that enumerates all CLI control keys and asserts which role may touch each. Deleting under the wildcard also allows deleting another record of the same site, which the site role may already do.
- A satellite wildcard also widens `ListBucket` prefixes: keep list conditions per kind-of-site pattern, not `_control/*`.
- Policy size: IAM inline policy limits (10,240 bytes per role) improve, not worsen, with consolidation.
- Existing deployments: widening an inline policy is an in-place update (no replacement); applying is an owner step. Narrowing is not part of this item.
- Coupling to CLI contract tests: add a test that fails when the CLI writes a `_control/` key the policy does not cover, so IAM drift is caught in CI instead of in production.

## Scope

- After the owner approves the design check, implement 1 (and 3 if approved) in `terraform/modules/aws/main.tf`, update `deployment.test.js` (`localStatement` assertions) and the module README paragraphs that enumerate the keys.
- Add the CLI-key coverage test described above.
- No apply; no change to the Cloudflare module.

## Acceptance criteria

- [ ] The owner has reviewed the design check and chosen the satellite approach (exact keys, per-site wildcard, or other); the decision is recorded here.
- [ ] Admin policy grants `_control/*` by prefix; its enumerated `_control` entries are gone; `cli-sync-remove`'s additions are covered without further module edits.
- [ ] No satellite role has prefix-level `_control/*`; a test proves a site role cannot touch another site's control records or the registry/application locks.
- [ ] A test enumerates every `_control/` key the CLI uses and asserts which role may read, write, delete and list it.
- [ ] `terraform validate`/tests and the Node tests pass; the plan against the AWS verification deployment shows only in-place IAM policy updates (reviewed, no apply).
- [ ] [TD15](../technical-design/TD15-terraform-module-source-of-truth.md) is updated: AWS is decoupled from CLI releases once this item is Done.

## Results

Design check recorded 2026-10-07; implementation not started.
