# Cache policy migration

This guide is for an operator moving an existing deployment from a CLI that requested CDN invalidation to a CLI that owns `Cache-Control` and never invalidates. The complete migration and rollback sequence is still being prepared; this page currently covers the one-time preview metadata helper, which that sequence uses after registry, sites and the application have converged.

## Why previews need a helper

A current CLI rewrites headers on its own for everything it republishes. `registry sync`, `site sync --reconcile` and `app deploy` treat a header-only difference as a change and converge the registry, each site's artifacts and indexes, and the application files to the current policy.

Preview revisions are different. A revision's manifest and files are immutable: once written, a normal `preview publish` of the same head compares them and never rewrites them. Objects written by an older CLI therefore keep the old headers (`s-maxage=60` on the catalog, `s-maxage=300` on revision objects) until they expire. The helper rewrites only their `Cache-Control`, once, so they match the current policy (`s-maxage=0`, revalidated on every request).

The helper is a maintenance tool in the repository, not a product command. It is not part of the released CLI binary or the Actions, and ordinary publishing never runs it.

## What it changes

For one site you name, the helper reads the preview catalog and its ownership ledger and checks every recorded revision's manifest against it. It then considers exactly these objects:

- the site's preview catalog, `_previews/<site>/catalog.json`;
- each recorded revision's `manifest.json`;
- each file that revision's manifest and ownership record both list.

It never lists prefixes to find objects, so an object the ledger does not prove belongs to the site, such as a stray upload under a revision prefix, is left alone. It never touches another site, artifacts, indexes, the registry or the application.

For each object it keeps the bytes, content type, encoding, disposition and custom metadata exactly as read, and replaces only `Cache-Control`. Each write is conditional on the ETag it read. An object that already has the current header is skipped, so a rerun after an interruption finishes the remaining objects and then reports `no-op`.

The run stops without writing anything when the catalog or a manifest fails validation, when an owned object is missing from a revision that still has other objects, or when an object carries a `Cache-Control` value that is neither the current nor the earlier CLI policy. A revision whose manifest and files are all gone has expired under the provider retention rule; the helper reports it as `expired` and continues.

## Run it

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

## Side effects

Rewriting an object's metadata changes its `Last-Modified` time. If the bucket expires previews with a lifecycle rule based on object age (`preview_retention_days` in the reference modules), every migrated revision object restarts its retention period once, so old previews can stay up to one extra retention period. Plan the run with that in mind, or run it close to when the oldest previews would expire anyway. Ordinary preview publishing does not repeat this extension.

Viewers who already have a preview open keep what their browser loaded; the new header applies to the next request.
