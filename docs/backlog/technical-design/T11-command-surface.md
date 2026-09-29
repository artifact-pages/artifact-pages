# T11 — Registry, site and application command surface

- Status: Done
- Phase: Provider-backed deployment

## Settled contract

Public commands select operations; provider details come from the resolved unified config and do not appear as `s3` or `r2` command branches:

~~~text
artifact-pages registry register [--config LOCATOR] [--dry-run] [--format text|json]
artifact-pages registry unregister --site ID [--config LOCATOR] [--dry-run] [--format text|json]
artifact-pages site publish --site ID [--source DIR] [--config LOCATOR] [--dry-run] [--format text|json]
artifact-pages app deploy (--version VERSION | --archive FILE) [--repository OWNER/REPO] [--config LOCATOR] [--dry-run] [--format text|json]
artifact-pages lock inspect (--site ID | --scope registry) [--config LOCATOR] [--format text|json]
artifact-pages lock recover (--site ID | --scope registry) --observed-etag ETAG [--config LOCATOR] [--format text|json]
~~~

The `--config` locator selects one strict version-1 YAML document containing provider settings and an optional top-level `sites` mapping. It remains the deployment-target selector for every config-consuming command and follows T10's locator precedence. There is no `--manifest` option, separate `sites.yaml` input, or two-file legacy mode.

`registry register` and `registry unregister` require `sites` to be present in the selected config and use it as the complete desired registration set. An absent field is an input error; `sites: {}` explicitly requests an empty set. Register serializes whole-registry updates and cleans content prefixes for sites omitted from the mapping; callers do not run a separate registry-build command. Unregister requires the checked-out config to already omit the selected site, then withdraws the deployed entry and cleans that site's prefixes. Both operations preserve dry-run, retry, and machine-readable result semantics.

Site publish, preview publish, and app deploy resolve provider settings but do not reconcile the config's `sites` mapping. Site and preview publish continue to validate eligibility against the deployed `/_indexes/sites.json`, not the mapping in the selected config. Every site operation requires one explicit site ID. `site publish` builds the index as part of the operation; `index build` remains a local low-level utility.

`--dry-run` performs the config and deployed-state reads needed to produce a plan but does not write objects or request cache changes. It is available on registry register/unregister, site publish, and app deploy. `app deploy` accepts exactly one of `--version` or `--archive`. `--version` selects and verifies a published release; it downloads the bundle in a temporary location that is removed after the command. `--archive` accepts a caller-provided packaged archive with its adjacent manifest and checksum. In text format, a site-publish dry-run summarizes production create, update and removal counts and preview prune and retain counts. In JSON format, `changes` is the full per-path production change list, sorted by path and action, including generated index and metadata objects when they change. `previewChanges` is the per-group preview disposition list, sorted by group ID and head SHA; each entry contains `action`, `groupId`, `headSha` and `reason`. The action is `remove` only when the completion manifest is confirmed missing; present or unavailable manifests produce `keep` entries with reason `manifest-present` or `manifest-unavailable`. A provider read error is not evidence that a manifest is missing. For a real site publish, preview-only pruning is a successful `published` operation; `no-op` means there are no production changes and no preview groups marked for removal. JSON output has stable `operation`, `outcome`, selected `site` (when applicable), sorted `changes`, and result fields; `site publish` JSON also includes `previewChanges`. Registry JSON reports `registryUpdated` on planned, registered, unregistered, and no-op outcomes. Plans, success and no-op outcomes exit 0; invalid command or config input exits 2; provider or reconciliation failures exit 1. Errors go to stderr and machine-readable failures use the same JSON envelope on stdout.

The registry register dry-run reports the exact registration additions, changes, removals, and intended content cleanup without provider writes; the real invocation uses the same validated complete desired set. Lock inspection supports both site and whole-registry locks; recovery requires the operator's previously observed ETag and never clears a changed lock. Optional Actions call these same operations, pass provider credentials, and relay the result without owning a second implementation.

## Design question

What are the exact public commands and dry-run output for reconciling the complete site set from the selected config, unregistering a site, publishing an explicitly selected site, deploying the versioned application bundle, and inspecting/recovering locks?

## Exit criteria

- [x] Resolve verb/flag names and exit codes without exposing a standalone index build as the required publish path.
- [x] Define a consistent `--dry-run` that compares desired and deployed state without provider writes, for registry, site, and application workflows.
- [x] Define machine-readable plans/results, stable JSON shapes, explicit site selection, and the boundary between CLI operations and thin GitHub Actions wrappers.
- [x] Align preview CLI work in [T2](T2-cli-action-interface.md) without making preview a prerequisite for normal publish.
- [x] Record the unified-config interface in the specification before implementation is marked complete.

## Evidence

This contract supersedes the earlier `--manifest` command surface. The CLI resolves registry inputs once, rejects missing `sites` before backend access, accepts an explicit empty map, and prevents unregistering an ID that remains in the desired config. The admin Action forwards the same config locator. `go test ./...`, `go test -race -count=1 ./...`, and `node scripts/test-actions-parity.mjs` passed in the 2026-09-29 local verification; registered-flow and clean-room evidence is recorded in IMP-40.
