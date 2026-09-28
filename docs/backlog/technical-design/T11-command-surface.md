# T11 — Registry, site and application command surface

- Status: Done
- Phase: Provider-backed deployment

## Settled contract

Public publishing commands select operations; provider details come from the resolved deployment config and do not appear as `s3` or `r2` command branches:

~~~text
artifact-pages registry register [--manifest sites.yaml] [--config LOCATOR] [--dry-run] [--format text|json]
artifact-pages registry unregister --site ID [--manifest sites.yaml] [--config LOCATOR] [--dry-run] [--format text|json]
artifact-pages site publish --site ID [--source DIR] [--config LOCATOR] [--dry-run] [--format text|json]
artifact-pages app deploy (--version VERSION | --archive FILE) [--repository OWNER/REPO] [--config LOCATOR] [--dry-run] [--format text|json]
artifact-pages lock inspect (--site ID | --scope registry) [--format text|json]
artifact-pages lock recover (--site ID | --scope registry) --observed-etag ETAG [--format text|json]
~~~

`registry register` validates the selected Git-owned YAML, creates its JSON projection, and reconciles the deployed registry to the complete desired registration set in one operation. It serializes whole-registry updates and cleans content prefixes for sites omitted from the manifest; callers do not run a separate registry-build command. `registry unregister --site ID` requires the checked-out manifest to already omit that site, then withdraws the deployed entry and cleans the selected site's prefixes. Every site operation requires one explicit site ID. The optional `--config LOCATOR` selects the deployment target according to T10's locator precedence. `site publish` builds the index as part of the operation; `index build` remains a local low-level utility. `--dry-run` performs config, registry, identity, production-object, preview-catalog and completion-manifest reads needed to produce a plan but does not write objects or request cache changes. It is available on registry register/unregister, site publish, and app deploy. `app deploy` accepts exactly one of `--version` or `--archive`. `--version` selects and verifies a published release; it downloads the bundle in a temporary location that is removed after the command. `--archive` accepts a caller-provided packaged archive with its adjacent manifest and checksum. In text format, a site-publish dry-run summarizes production create, update and removal counts and preview prune and retain counts. In JSON format, `changes` is the full per-path production change list, sorted by path and action, including generated index and metadata objects when they change. `previewChanges` is the per-group preview disposition list, sorted by group ID and head SHA; each entry contains `action`, `groupId`, `headSha` and `reason`. The action is `remove` only when the completion manifest is confirmed missing; present or unavailable manifests produce `keep` entries with reason `manifest-present` or `manifest-unavailable`. A provider read error is not evidence that a manifest is missing. For a real site publish, preview-only pruning is a successful `published` operation; `no-op` means there are no production changes and no preview groups marked for removal. JSON output has stable `operation`, `outcome`, selected `site` (when applicable), sorted `changes`, and result fields; `site publish` JSON also includes `previewChanges`. `registry register` reports `registered` when it reconciles a changed desired set and `no-op` when the set and all pending cleanup are already current; `registry unregister` reports `unregistered` after removal and cleanup. The `registryUpdated` field is present on planned, registered, unregistered, and no-op registry results. Other outcomes include `planned`, `published` for site content, and `failed`. Successful operations, plans and no-ops exit 0; invalid command/config/manifest exits 2; provider or reconciliation failures exit 1. Errors go to stderr and machine-readable failures use the same JSON envelope on stdout.

The registry register dry-run reports the exact registration additions, changes, removals, and intended content cleanup without provider writes; the real invocation uses the same validated complete desired set. Lock inspection supports both site and whole-registry locks; recovery requires the operator's previously observed ETag and never clears a changed lock. Optional Actions call these same operations, pass provider credentials, and relay the result without owning a second implementation.

## Design question

What are the exact public commands and dry-run output for registering the complete Git-owned site set, unregistering a site, publishing an explicitly selected site, deploying the versioned application bundle, and inspecting/recovering locks?

## Exit criteria

- [x] Resolve verb/flag names and exit codes without exposing a standalone index build as the required publish path.
- [x] Define a consistent `--dry-run` that compares desired and deployed state without provider writes, for registry, site, and application workflows.
- [x] Define machine-readable plans/results, explicit site selection, and the boundary between CLI operations and optional thin GitHub Actions wrappers.
- [x] Align preview CLI work in [T2](T2-cli-action-interface.md) without making preview a prerequisite for normal publish.
- [x] Record agreed interface in the specification and CLI help before implementation is marked complete.

## Evidence

The command syntax, stable JSON success/failure envelopes, exit-code classes, dry-run behavior, and shared Action boundary are recorded in [the specification](../../specification.md#22-deployment-configuration-and-command-interface) and reflected in the CLI help. The CLI now emits operation/outcome/change fields for registry, site, app, and lock operations; parser and plan-test evidence remains with the implementation tickets.
