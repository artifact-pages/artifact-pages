# T2 — CLI and Action interface

- Status: Done
- Phase: Post-MVP preview

## Design question

What are the exact CLI flags, resource-include syntax, and Action inputs/outputs for pre-publish and production publish? The same core operation must work locally and from CI; workflows choose when to invoke it.

## Decision

The provider-backed preview command is `artifact-pages preview publish --site ID --source DIR --base-url ORIGIN`. Optional inputs are `--head` (default `HEAD`), `--default-ref` (default `origin/HEAD`), `--pull-request REF`, repeatable `--include PATH`, `--config LOCATOR`, `--dry-run`, and `--format text|json`. `--source` is required and must equal the registered source path. PR provenance is only accepted when explicitly supplied as a positive number or canonical public GitHub pull URL; the resolver verifies the registered base/head repository and selected full head SHA. No PR is inferred from Git or CI context.

`--include` accepts exact source-relative paths or Go `path.Match` patterns over slash-separated paths. Wildcards do not cross `/`; every match must be an additional non-document resource inside the selected source tree. Normal resource discovery remains automatic.

Dry-run reads the Git source, config, deployed registry and preview state needed for its plan without acquiring a lock or mutating provider state. JSON results expose `operation`, `outcome`, `site`, `groupId`, `headSha`, optional `pullRequestUrl`, `groupListUrl`, sorted `documents`, `objects`, and `catalogChanges`, optional `configCommitSha`, and optional `error`. The `documents` array carries source-relative path, title, and fixed revision URL. Catalog changes sort by group ID, head SHA, action, then reason; object changes sort by path with the manifest last. A failure after source selection retains the known group/document URLs in the typed result. Outcomes are `planned`, `published`, `no-op`, `no-preview`, and `failed`; `no-preview` removes an existing PR group's catalog entry when one exists but does not delete the prior immutable revision.

The optional preview Action maps `site`, `source`, `head`, `default-ref`, `pull-request`, `base-url`, `config`, and `dry-run` to the same CLI operation. Its `include` input is a newline-separated path/pattern list expanded to repeated CLI flags. It exposes `outcome`, `group-list-url`, and `documents` as a JSON string. It does not infer PR provenance, select workflow timing, or post comments. Production registry/site Actions continue to use the separate T11 command and result contract.

The full CLI and Action contract is recorded in the [specification's post-MVP preview section](../../specification.md#post-mvp-pre-publish-preview-contract). CLI help matches the command flags and defaults; implementation and behavior evidence remains with [IMP-11](../implementation/IMP-11-cli.md), [IMP-13](../implementation/IMP-13-action.md), [T5](../verification/T5-concurrency-recovery.md), and [T6](../verification/T6-resources-navigation.md).

## Exit criteria

- [x] Document exact command forms and dry-run output for explicit site selection, optional PR number or URL, source comparison, and additional non-document resources. Omitted PR input remains manual and is never inferred.
- [x] Define normalization and validation of an explicit PR reference against the registered source repository and previewed head before claiming PR provenance.
- [x] Define typed `published`, `no-preview`, and failure results, including group-list and fixed document URLs.
- [x] Define the Action boundary as a thin CLI wrapper, without requiring a reusable workflow or a separate cleanup command.
- [x] Reconcile the [publishing contract's input/output table](../../architecture/preview-publishing-contract.html#inputs) with CLI help and the specification.

## Evidence

The CLI implementation exposes the documented command and option names in `cmd/artifact-pages/preview.go`; `go run ./cmd/artifact-pages preview publish --help` matches the documented defaults and flags. Resolver and command tests cover explicit PR number/URL lookup, repository and head validation, typed outputs, URL escaping, and a dry-run that leaves provider storage unchanged. The Action is a specified wrapper contract; its implementation and hosted-provider evidence remain in IMP-13.
