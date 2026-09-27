# T11 — Registry, site and application command surface

- Status: Done
- Phase: Provider-backed deployment

## Settled contract

Public publishing commands select operations; provider details come from the resolved deployment config and do not appear as `s3` or `r2` command branches:

~~~text
artifact-pages admin apply [--manifest sites.yaml] [--dry-run] [--format text|json]
artifact-pages admin unregister --site ID [--manifest sites.yaml] [--config LOCATOR] [--dry-run] [--format text|json]
artifact-pages site publish --site ID [--source DIR] [--config LOCATOR] [--dry-run] [--format text|json]
artifact-pages app deploy (--archive FILE | --version VERSION) [--format text|json]
artifact-pages lock inspect (--site ID | --scope registry) [--format text|json]
artifact-pages lock recover (--site ID | --scope registry) --observed-etag ETAG [--format text|json]
~~~

Every site operation requires one explicit site ID. The optional `--config LOCATOR` selects the deployment target according to T10's locator precedence. `site publish` builds the index as part of the operation; `index build` remains a local low-level utility. `--dry-run` performs config, registry, identity, production-object, preview-catalog and completion-manifest reads needed to produce a plan but does not write objects or request cache changes. In text format, a site-publish dry-run summarizes production create, update and removal counts and preview prune and retain counts. In JSON format, `changes` is the full per-path production change list, sorted by path and action, including generated index and metadata objects when they change. `previewChanges` is the per-group preview disposition list, sorted by group ID and head SHA; each entry contains `action`, `groupId`, `headSha` and `reason`. The action is `remove` only when the completion manifest is confirmed missing; present or unavailable manifests produce `keep` entries with reason `manifest-present` or `manifest-unavailable`. A provider read error is not evidence that a manifest is missing. For a real publish, preview-only pruning is a successful `published` operation; `no-op` means there are no production changes and no preview groups marked for removal. JSON output has stable `operation`, `outcome`, selected `site` (when applicable), sorted `changes`, and result fields; `site publish` JSON also includes `previewChanges`. `outcome` is `planned`, `published`, `no-op`, `unregistered`, or `failed`. Successful operations, plans and no-ops exit 0; invalid command/config/manifest exits 2; provider or reconciliation failures exit 1. Errors go to stderr and machine-readable failures use the same JSON envelope on stdout.

`admin apply` validates and projects the Git-owned manifest, serializes the whole-registry deployment, and reconciles removals. For `admin unregister`, the selected site must already be removed from the checked-out YAML; the command deploys that desired registry and cleans the explicit site's prefixes even when a prior attempt already removed its registration. Lock inspection supports both site and whole-registry locks; recovery requires the operator's previously observed ETag and never clears a changed lock. Optional Actions call these same operations, pass provider credentials, and relay the result without owning a second implementation.

## Design question

What are the exact public commands and dry-run output for applying a Git-owned registry, publishing an explicitly selected site, deploying the versioned application bundle, and inspecting/recovering locks?

## Exit criteria

- [x] Resolve verb/flag names and exit codes without exposing a standalone index build as the required publish path.
- [x] Define a consistent `--dry-run` that compares desired and deployed state without provider writes, for admin and satellite workflows.
- [x] Define machine-readable plans/results, explicit site selection, and the boundary between CLI operations and optional thin GitHub Actions wrappers.
- [x] Align preview CLI work in [T2](T2-cli-action-interface.md) without making preview a prerequisite for normal publish.
- [x] Record agreed interface in the specification and CLI help before implementation is marked complete.

## Evidence

The command syntax, stable JSON success/failure envelopes, exit-code classes, dry-run behavior, and shared Action boundary are recorded in [the specification](../../specification.md#22-deployment-configuration-and-command-interface) and reflected in the CLI help. The CLI now emits operation/outcome/change fields for app, site, admin, and lock operations; parser and plan-test evidence remains with the implementation tickets.
