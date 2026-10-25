# Cache policy migration

This guide is for an operator moving an existing deployment from a CLI that requested CDN invalidation (0.5.2 and earlier) to a CLI that owns `Cache-Control` and never invalidates. It gives the migration order, the checks, how to retire purge credentials, and how to roll back. The [specification](../specification.md) lists the exact header for every object class.

The migration moves five things, and each is checked separately: the CLI version of every writer, the delivery module, the headers stored on origin objects, the entries edge caches already hold, and the credentials. Changing headers on origin objects does not by itself expire what an edge already cached.

**Status.** No step of this sequence has been run against a production or verification deployment yet. The CLI and module changes are verified locally only; provider behaviour, root freshness and cost are measured separately ([T30](../backlog/verification/T30-cache-freshness-and-root-latency.md)). Rehearse the whole sequence, including the rollback, on a verification deployment before you run it on production. Cloudflare results do not establish AWS behaviour; treat AWS as unverified until it has its own run.

## Before you start

- Identify every writer: the admin repository (registry sync, app deploy), every satellite repository (site sync, preview publish and remove), and any local operator who publishes by hand. All of them must move together.
- Use a compatible CLI release: the first release that includes the no-invalidation change. Its release notes name it. A compatible CLI reads and migrates the old journals; an older CLI cannot read the journals a compatible CLI writes.
- Use a compatible delivery module: the reference AWS and Cloudflare modules from the same product release. On AWS, the new module removes `cloudfront:CreateInvalidation` from the publisher roles, so an old CLI publishing against it fails.
- Know the largest shared-cache freshness your old setup allowed for mutable objects. For the reference modules it is 300 seconds (artifacts and preview revisions); a custom CDN may have its own value.
- Do not purge as part of the migration. Waiting out the old freshness is the plan.

## Migration sequence

Run the steps in this order.

1. **Stop the old writers and settle their work.** Pause the publish, preview, registry and app-deploy workflows, and stop hand-run publishing. Let any running job finish. If a job was interrupted, run it again with the old CLI until it succeeds, so no old journal is left half-applied. Then back up the private control records you have: every `_control/sites/<site>/site-cache.json`, `_control/sites/<site>/preview-cleanup.json`, `_control/registry-cleanup.json` and `_control/app-cache/retry.json`. Keep the source repositories as they are.
2. **Move every writer to the compatible CLI.** Change `cli.version` in the admin config and the Action pins in every repository (see [Operator repository changes](#operator-repository-changes)). Do not delete control records or source files. Leave the purge credential in place for now; the compatible CLI ignores it.
3. **Apply the compatible delivery module.** Review the plan first. On AWS the plan replaces the indexes, artifacts and immutable-assets cache policies with one origin-respecting policy and removes the invalidation permission; on Cloudflare the cache rule already respects the origin and the plan should show no cache-rule change.
4. **Converge headers and journals.** Run, each with `--dry-run` first: `registry sync` from the admin repository, `site sync --reconcile` for every registered site, and `app deploy` with the current `web.version`. Each command treats a header-only difference as a change and rewrites the header; the first real run of each also migrates or retires any journal an older CLI left, after saving the exact bytes of an old site journal under `_control/sites/<site>/legacy/`.
5. **Run the preview helper** for every site that has previews (see [Preview metadata helper](#preview-metadata-helper) below). Without it, existing preview revisions keep the old headers until they expire.
6. **Wait out the old freshness.** Wait for the module change to propagate and then for the largest old mutable freshness to pass: 300 seconds for the reference modules, or your custom CDN's real value. Until then an edge may still serve a copy it cached under the old rules.
7. **Verify.** For the registry, one site's metadata and index, a search manifest, an artifact, a preview catalog and revision file, `index.html` and a hashed asset, request the object from the origin and through the delivery hostname, and confirm the `Cache-Control` matches the specification. Publish a small change and confirm a fresh request sees it within the expected bound: up to 5 seconds for the registry, site metadata and index, immediately for artifacts and previews. Confirm the publish result lists no invalidation and that the journals listed in step 1 are absent after successful runs.
8. **Retire purge credentials.** Only after step 7 passes, and only for credentials that served purge alone (see below).

## Retire purge credentials

- **Cloudflare, explicit R2 key pair.** The CLI no longer reads `CF_API_TOKEN`. Remove it from the workflow `env` blocks, then delete the secret and revoke the token in Cloudflare. Workflows generated by `registry setup` keep forwarding `CF_API_TOKEN`, because `apiTokenEnv` defaults to that name; with an explicit pair the CLI never reads it, so a regenerated line that points at a deleted secret is harmless. Check first that the deployment really uses an explicit pair (`CF_R2_ACCESS_KEY_ID` and `CF_R2_SECRET_ACCESS_KEY` are set for every writer); otherwise the token is your R2 credential.
- **Cloudflare, single-token mode.** Keep `CF_API_TOKEN`: the CLI derives the R2 credentials from it. You may remove its `Cache Purge` permission; it needs `Workers R2 Storage Bucket Item Write` only.
- **AWS.** Applying the compatible module in step 3 already removed `cloudfront:CreateInvalidation` from the publisher roles. There is no separate secret to retire.

Keep any credential the rollback below would need until you are sure you will not roll back.

## Rollback

Restarting an old writer is not a rollback on its own. An old CLI cannot read a schema 2 journal and stops on it, and the old module and permissions are gone. Roll back these together:

1. **Quiesce the compatible writers.** Pause every workflow and let running jobs finish. Rerun any interrupted job with the compatible CLI until it succeeds, so that no journal remains. Never delete an unknown or unfinished journal to make an old CLI start.
2. **Restore old journals only from a quiescent backup.** If a journal must survive the rollback, restore the backup from migration step 1 only when nothing has changed since it was taken. Otherwise finish the work with the compatible CLI first. The backups under `_control/sites/<site>/legacy/` are evidence of what the compatible CLI migrated, not records to put back blindly.
3. **Restore the old module and permissions.** Apply the previous module version, which brings back the old cache policies and, on AWS, `cloudfront:CreateInvalidation`. On Cloudflare, make sure the old CLI has a token with `Cache Purge` for the zone again.
4. **Pin the old CLI** in the admin config and every Action pin.
5. **Bring back the old headers.** Run `registry sync`, `site sync` for every site and `app deploy` with the old CLI, and check that the stored headers are the old values. How completely an old CLI rewrites headers written by a newer one has not been rehearsed, so check each object class and fix any that remain. Preview revisions keep the new header until they expire; the old CLI's policy allows that.
6. **Verify** as in migration step 7, against the old freshness rules.

## Operator repository changes

The production operator repositories follow this sequence like any adopter. These are the changes to review there; they are not applied by this guide.

`artifact-pages/admin`, deployment config (step 2; `<compatible>` is the release from [Before you start](#before-you-start)):

```diff
 cli:
-  version: 0.5.2
+  version: <compatible>
```

`artifact-pages/admin` and `artifact-pages/docs` workflows: bump every `artifact-pages/*-action@<tag>` pin to the release that bundles the compatible CLI (step 2). Production uses an explicit R2 key pair, so after step 7 the purge token can leave every Cloudflare job's `env` (step 8), for example in `.github/workflows/registry.yml`:

```diff
     env:
       CF_R2_ACCESS_KEY_ID: ${{ secrets.CF_R2_ACCESS_KEY_ID }}
       CF_R2_SECRET_ACCESS_KEY: ${{ secrets.CF_R2_SECRET_ACCESS_KEY }}
-      CF_API_TOKEN: ${{ secrets.CF_API_TOKEN }}
```

The same line goes from `app-deploy.yml`, `publish-site.yml` and `preview-site.yml`, and from the docs repository's publish and preview workflows. Then delete the repository and environment secrets and revoke the token. Update the comment at the top of `artifact-pages.yaml` that lists `CF_API_TOKEN` among the credentials.

## Preview metadata helper

### Why previews need a helper

A current CLI rewrites headers on its own for everything it republishes. `registry sync`, `site sync --reconcile` and `app deploy` treat a header-only difference as a change and converge the registry, each site's artifacts and indexes, and the application files to the current policy.

Preview revisions are different. A revision's manifest and files are immutable: once written, a normal `preview publish` of the same head compares them and never rewrites them. Objects written by an older CLI therefore keep the old headers (`s-maxage=60` on the catalog, `s-maxage=300` on revision objects) until they expire. The helper rewrites only their `Cache-Control`, once, so they match the current policy (`s-maxage=0`, revalidated on every request).

The helper is a maintenance tool in the repository, not a product command. It is not part of the released CLI binary or the Actions, and ordinary publishing never runs it.

### What it changes

For one site you name, the helper reads the preview catalog and its ownership ledger and checks every recorded revision's manifest against it. It then considers exactly these objects:

- the site's preview catalog, `_previews/<site>/catalog.json`;
- each recorded revision's `manifest.json`;
- each file that revision's manifest and ownership record both list.

It never lists prefixes to find objects, so an object the ledger does not prove belongs to the site, such as a stray upload under a revision prefix, is left alone. It never touches another site, artifacts, indexes, the registry or the application.

For each object it keeps the bytes, content type, encoding, disposition and custom metadata exactly as read, and replaces only `Cache-Control`. Each write is conditional on the ETag it read. An object that already has the current header is skipped, so a rerun after an interruption finishes the remaining objects and then reports `no-op`.

The run stops without writing anything when the catalog or a manifest fails validation, when an owned object is missing from a revision that still has other objects, or when an object carries a `Cache-Control` value that is neither the current nor the earlier CLI policy. A revision whose manifest and files are all gone has expired under the provider retention rule; the helper reports it as `expired` and continues. The provider deletes expired objects one by one, so a revision caught part-way through expiry looks partial and stops the run; wait until the provider has finished deleting it and run the helper again.

### Run it

Run from a checkout of the monorepo at a commit that contains the helper, with the same credentials a site publisher uses for that site (see [Cloudflare deployment](cloudflare-deployment.md) or [AWS deployment](aws-deployment.md)). The config must be a local file; remote config locators and layered configs are not accepted.

Start with a dry run. It takes no lock and writes nothing:

```sh
go run ./cli/tools/migrate-preview-cache --config artifact-pages.yaml --site sre
```

It prints each object it would update and each expired revision, followed by a summary. Add `--format json` for a machine-readable result. When the plan looks right, apply it:

```sh
go run ./cli/tools/migrate-preview-cache --config artifact-pages.yaml --site sre --apply
```

With `--apply` the helper takes the site's lock, so it waits for or fails against a concurrent `site sync`, `preview publish` or `preview remove` for that site, as those commands do with each other. It checks before every write that it still holds the lock and stops if it does not. If a run stops part-way, run the same command again.

Exit status 0 means success, 2 means a usage or config error, and 1 means a provider or validation error. A stale lock left by a crashed run is handled like any other site lock; see the [operator recovery runbook](operator-recovery.md).

### Side effects

Rewriting an object's metadata changes its `Last-Modified` time. If the bucket expires previews with a lifecycle rule based on object age (`preview_retention_days` in the reference modules), every migrated revision object restarts its retention period once, so old previews can stay up to one extra retention period. Plan the run with that in mind, or run it close to when the oldest previews would expire anyway. Ordinary preview publishing does not repeat this extension.

Viewers who already have a preview open keep what their browser loaded; the new header applies to the next request.
