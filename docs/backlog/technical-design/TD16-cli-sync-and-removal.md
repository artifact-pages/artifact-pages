# TD16 — Desired-state sync and scoped removal

- Status: Done
- Date: 2026-10-07
- Phase: Provider-backed deployment
- Supersedes the command names and removal behavior in [T11](T11-command-surface.md) for the current 0.x CLI.

## Decision

Use `registry sync` for the complete configured sites set and `site sync` for a site's complete publishable source tree. Keep `preview publish` and add explicit `preview remove --site ID --group ID`; keep `app deploy` and add `app remove`. Do not provide the old `registry register`, `registry unregister`, or `site publish` aliases. The 0.x CLI and the newly written preview history format have no compatibility or migration promise.

The current command tree, result outcomes, shared flags, and public Action boundary are recorded in [the specification](../../specification.md#22-deployment-configuration-and-command-interface). This design settles destructive scope and retry behavior.

Implementation and independent Sol review are complete. Verified locally with `go test ./...`, `node scripts/test-actions-parity.mjs`, `node --test scripts/taskfile.test.mjs`, `node --test terraform/modules/aws/deployment.test.js`, the compatibility gate, and the documentation asset checks. These prove local and provider-fake contracts, not live AWS/Cloudflare behavior.

## Registry and site synchronization

`registry sync` treats the effective config's `sites` map as the complete desired set. A missing field is an input error; an explicit empty map is valid. Omitting a previously deployed site withdraws it and cleans its site-owned artifact, index, preview catalog, and revision prefixes. Existing registry cleanup intent remains durable after catalog withdrawal and is resumed by a later registry sync, so a retry does not require restoring a removed site to the config.

`site sync` reconciles a selected registered site's entire publishable directory, including generated and untracked files, against its artifact and index projection. Preserve the existing lock/CAS/state-recovery/cache-retry path; the verb change must not bypass state verification or broaden stale deletion. Successful registry and site changes report `synced`; converged state reports `no-op`.

## Preview group ownership and removal

The preview catalog gains a top-level `revisionHistory` ownership ledger, separate from its reader-facing `groups` array. Each ledger entry contains a `groupId` and the set of every full lowercase commit SHA written for that group, sorted by SHA, with the exact sorted source file paths owned by each revision. Republishing a head is idempotent, including reverting to an earlier SHA; the visible group's current head is stored separately in `groups`. The ledger survives no-preview withdrawal and missing-manifest pruning because physical storage is keyed by SHA and a SHA can be shared by multiple groups.

Before any mutation, removal validates the site ID, exact group ID, catalog, all group histories needed to determine shared ownership, and manifests for every selected unshared revision. If the selected group or any visible sibling that could share a selected SHA lacks supported complete history, removal fails closed before mutation. A missing group with no pending journal and no ownership record remains an idempotent no-op. No ownership is inferred from a PR number, a branch, the latest catalog head, or absence of a sibling reference in a legacy catalog. The CLI must not enumerate the whole site prefix or guess at uncatalogued revisions.

Build the deletion set from the selected group's validated ownership ledger. If a revision manifest still exists, validate that its file list matches the ledger before mutation; if retention already removed the manifest, the ledger still provides the exact owned file paths. For every exclusive SHA, completely list only `_previews/<site>/revisions/<full-SHA>/`, validate every returned key as a canonical manifest or file key in that exact prefix, and include all listed keys so an interrupted upload's unmanifested objects are removed. Any failed or unsafe listing aborts before catalog or journal changes. If any sibling group references a candidate SHA, preserve that revision's manifest and files without listing or deleting its prefix. Remove only the selected reader-facing catalog entry, its ownership-ledger entry, and its exclusive exact revision objects. The caller holds the same per-site lock used by preview publication and site synchronization.

Persist a versioned cleanup journal under the site's private control namespace before changing the catalog. Registry omission must resume and clear this journal under the same site lock before its whole-site preview cleanup, then remove the now-finished journal with the site control records. The journal contains the validated group ID, exact exclusive revision SHAs and object keys, catalog transition, and one `/_previews/<site>/*` cache invalidation path. That site-scoped cache purge can evict sibling preview responses from edge caches, but it never deletes sibling origin objects; a single wildcard also stays within provider invalidation quotas for groups with many revisions. Resume the journal under the site lock before another preview writer begins. Keep it through catalog write, object deletion, and cache invalidation; clear it only after all stages succeed. Every stage is idempotent. A missing group with no pending journal is a no-op; `--dry-run` reads and validates a plan but does not acquire the lock, write the journal, mutate the catalog, delete objects, or invalidate cache.

## Application removal and least privilege

`app remove` owns exactly four fixed root keys (`index.html`, `preview-bridge.js`, `LICENSE`, and `THIRD_PARTY_NOTICES.txt`) plus keys below `assets/`. Probe those root keys individually and list only `assets/`; do not list or delete the bucket root. Under the application lock, write the existing app cache retry record with the sorted union of prior retry paths and app removal routes before deleting. Delete only the enumerated owned keys, then invalidate the exact app routes and clear the retry record. Failures retain or restore the retry record. `app deploy` consumes pending retry paths before deciding that an unchanged bundle is a no-op.

AWS policies include the fixed app root keys and `assets/*` in the admin role's `DeleteObject` scope, alongside the existing narrowly scoped site and control cleanup prefixes. A site satellite receives `DeleteObject` on `_previews/<site>/*` for preview removal. Do not grant bucket-wide delete permission. Contract tests assert allowed prefixes and unrelated denied scopes.

## Actions and rollout

Keep the four existing Action repositories and monorepo Action directories. The publish and registry wrappers call the renamed sync commands and preserve their public input/output names. The two remove commands remain CLI-only; Actions stay one operation each. Update active monorepo docs, parity fixtures, and workflow caller examples. After a separately approved product release, regenerate and publish all four existing Action repositories from this monorepo, then update the `admin` and `docs` repository pins to that released tag. Reconcile the published Terraform package source separately when its release is approved. Until then, released consumers continue using their current pins; never point them at unreleased code.

## Verification

Verification completed: `go test ./...` (including preview/app removal, registry omission retry, and failure recovery); `node scripts/test-actions-parity.mjs`; `node --test scripts/taskfile.test.mjs`; `node --test terraform/modules/aws/deployment.test.js`; compatibility gate; and documentation asset synchronization/checks. Independent Sol review found no remaining safety defects. No live AWS or Cloudflare account operation was run. Release publication and external operator pin updates remain a separate owner-approved rollout.
