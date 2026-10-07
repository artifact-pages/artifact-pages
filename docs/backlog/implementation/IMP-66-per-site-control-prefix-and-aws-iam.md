# IMP-66 — Per-site control prefix and prefix-level AWS IAM

- Status: Open
- Lanes: CLI, Terraform / AWS
- Depends on: design check below; owner decision recorded 2026-10-07 (option c)
- Sequencing: land **after** the `cli-sync-remove` change (in flight, touches `terraform/modules/aws/main.tf` and `deployment.test.js` for the same `_control/*` reason) to avoid conflicts, and rebase on [IMP-63](IMP-63-consolidate-terraform-modules.md) if that merges first (it rewrites the same file)
- Related: [TD15](../technical-design/TD15-terraform-module-source-of-truth.md) (decision 2026-10-07: independent module versions), [IMP-64](IMP-64-generate-sync-terraform-packages.md), [IMP-44](IMP-44-aws-waf-custom-rules.md)

## Goal

Owner decision (2026-10-07), option (c): the CLI moves every per-site control record under `_control/sites/<site>/...`; each satellite role gets only `_control/sites/<site>/*` and the admin role gets prefix-level `_control/*`. With that, a new control record needs no module change, and per-site isolation is kept by the key layout instead of by enumerated keys. Previously the goal was only to make the AWS module's IAM policies grant `_control/*` by prefix wherever it is safe, so that a new CLI control-record path no longer requires a module change. This is the precondition for releasing the AWS module independently of CLI releases ([TD15](../technical-design/TD15-terraform-module-source-of-truth.md)). Cloudflare needs nothing: its credentials are bucket-level.

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
3. **Decided 2026-10-07: option (c), per-site control prefix.** Per-site records move to `_control/sites/<site>/...` (`lock.json`, `site-cache.json`, `publish-state.json.gz`, `preview-cleanup.json`, and any future per-site record). Each satellite role gets Get/Put/Delete/List on `_control/sites/<site>/*` only, replacing all enumerated control keys. Global records (`locks/registry.json`, `locks/application.json`, `registry-cleanup.json`, `app-cache/retry.json`) stay where they are and remain admin-only via the admin `_control/*`.

   Rejected alternatives:
   - *Exact keys per record (status quo).* Safe, but every new per-site record needs a module change, so AWS stays coupled to CLI releases, which defeats TD15's independent versions.
   - *Per-site wildcard `_control/*/<site>.json[.gz]`.* Avoids a layout change but relies on naming conventions: `*` crosses `/`, so a site named `retry` or `registry-cleanup` would match global records, and it needs reserved site IDs and still special-cases `locks/sites/<site>.json`.

### Roles that must NOT gain `_control/*`

- Every satellite role: access only to `_control/sites/<site>/*`, never `_control/*` or another site's prefix.
- No role should gain `_control/private/*` or similar sentinel/test paths unless a verification profile needs it; the verification deployment (`cloudflare-verify` and the AWS verify caller) must keep working with its own policy.
- CloudFront OAC: must not gain `_control/*` (stays read-only on the content paths that have behaviors). Check that the bucket policy resource is `bucket/*` today (`local.bucket_objects`) and that the missing behavior for `/_control/*` is what keeps it unserved; the widening in this item does not change the bucket policy, but a regression test should assert it.

### Risk assessment

- Admin widening: low. Same principal that already runs lock, cache, state and registry cleanup; new exposure is future control records and `DeleteObject` on `locks/*`. Blast radius is the admin OIDC subject (exact subject inputs), unchanged.
- Per-site prefix (c): low-medium. Isolation comes from the key layout, so the site-ID collision problem of the wildcard option disappears and no site-ID reservation is needed for IAM, provided site IDs cannot contain `/` or `..` (confirm in the registry validation; if they can, add that constraint). The risk moves to the CLI migration below. `ListBucket` conditions use `_control/sites/<site>/*`.
- Policy size: IAM inline policy limits (10,240 bytes per role) improve, not worsen, with consolidation.
- Existing deployments: widening an inline policy is an in-place update (no replacement); applying is an owner step. Narrowing is not part of this item.
- Coupling to CLI contract tests: add a test that fails when the CLI writes a `_control/` key the policy does not cover, so IAM drift is caught in CI instead of in production.

## Key-layout migration and ordering

0.x carries no compatibility promise ([TD2](../technical-design/TD2-component-release-policy.md)), but the cutover must not strand state (locks, publish state, cache-retry and cleanup records):
- New CLI writes only the new keys. For reads it falls back to the old key when the new one is absent and writes the result to the new key (read-old-write-new); the old key is deleted after the new key is written, by the admin or satellite role that holds delete on it. Alternative if the fallback is too intrusive: a one-shot `registry sync` step that moves all per-site records, run once by the admin. The implementer picks one and records it in Results; the fallback is the default because it needs no operator step.
- Locks are short-lived: the cutover is safe when no publish is in flight; document that, and treat a stale old-path lock as recoverable by the existing lock-recovery rules.
- Ordering: (1) module release that grants **both** the old exact keys and `_control/sites/<site>/*` (and admin `_control/*`), applied by the owner; (2) CLI release writing the new layout (with old-key fallback), published as a product release; (3) a later module release drops the old exact keys once the satellites run the new CLI. Releasing the CLI before step 1 would fail with AccessDenied on the new keys. This is the one place where the AWS module and CLI releases are still ordered; afterwards they are independent.
- Cloudflare credentials are bucket-level; the Cloudflare module needs no change, but the CLI layout change applies to both providers and the local/emulator profiles, fixtures and spec text (`docs/specification.md` control-record paths) must be updated with it.

## Scope

- CLI: move per-site control records to `_control/sites/<site>/...` with the migration above; update the spec, fixtures and local profiles.
- Module: admin `_control/*` (1), satellite `_control/sites/<site>/*` (3), transitional old exact keys per the ordering; update `deployment.test.js` and the README paragraphs that enumerate keys.
- Add the CLI-key coverage test described above.
- No apply; no change to the Cloudflare module. Implementation starts only after `cli-sync-remove` has merged.

## Acceptance criteria

- [x] The owner chose option (c), per-site control prefix (2026-10-07), recorded above.
- [ ] Admin policy grants `_control/*` by prefix; its enumerated `_control` entries are gone; `cli-sync-remove`'s additions are covered without further module edits.
- [ ] Per-site records live under `_control/sites/<site>/`; each satellite role is limited to that prefix; a test proves a site role cannot touch another site's control records or the registry/application locks.
- [ ] The migration (read-old-write-new fallback or one-shot move) is implemented and tested, including a stale old-key lock and state, and the release ordering is documented in the release notes.
- [ ] A test enumerates every `_control/` key the CLI uses and asserts which role may read, write, delete and list it.
- [ ] `terraform validate`/tests and the Node tests pass; the plan against the AWS verification deployment shows only in-place IAM policy updates (reviewed, no apply).
- [ ] [TD15](../technical-design/TD15-terraform-module-source-of-truth.md) and the specification are updated: AWS is decoupled from CLI releases once this item is Done.

## Results

Design check and owner decision (option c) recorded 2026-10-07; implementation not started.
