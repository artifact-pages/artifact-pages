# IMP-11 — Pre-publish CLI and dry-run

- Status: Done
- Phase: Post-MVP preview
- Depends on: [IMP-02](IMP-02-source-selection.md)–[IMP-05](IMP-05-publication.md), and the public interface in [T2](../technical-design/T2-cli-action-interface.md)
- Proves: [T5](../verification/T5-concurrency-recovery.md), [T6](../verification/T6-resources-navigation.md)

## Outcome

Expose the same provider-neutral pre-publish operation locally and from CI. Accept an explicit site and optional explicit PR number/URL; accept T2's extra-resource inputs. Dry-run reports selection and intended catalog effect without provider writes.

## Acceptance criteria

- Help, errors and tests reflect exact T2 flags; omitted PR input stays manual and is never inferred from local Git or CI environment.
- Typed `published`, `no-preview` and failure results expose the mutable group-list URL and revision-specific document URLs, with PR context when supplied.
- Dry-run distinguishes deletion-only `no-preview` from non-document-only error, lists document/resource changes and performs no provider write.
- CI can invoke the same `artifact-pages preview publish` command/core operation as local use; the typed JSON output exposes the fields a thin Action needs.

## Current implementation evidence

- `cmd/artifact-pages preview publish` implements the T2 interface: explicit site/source/base origin, configurable head/default refs, explicit PR number or canonical URL, repeatable resource includes, config locator, dry-run and text/JSON output.
- `internal/publisher.BuildAndPlanPreview` builds the Git snapshot through the shared provider-neutral preview store. A real publication acquires the site lock before revalidating the deployed registry and source mapping; dry-run is read-only and takes no lock.
- JSON output includes planned object/catalog changes and typed group/document URLs. PR URLs preserve the explicit group context; manual previews omit it. Deletion-only changes return `no-preview`, while a non-document-only change is an error.
- `go run ./cmd/artifact-pages preview publish --help` matches the documented command surface. `go test -race -count=1 ./internal/preview ./internal/publisher ./cmd/artifact-pages` passes, including PR resolver validation, URL escaping, dry-run storage-snapshot checks and apply/readback.

The acceptance criteria are verified. `go test -race -count=1 ./...` passes; after adding the final command-level no-preview/resource-only regression, `go test -race -count=1 ./cmd/artifact-pages` and `git diff --check` also pass. An independent read-only review found two issues in failure output/order, both fixed with regression coverage; the reviewer confirmed the fixes and reported no remaining actionable gaps. GitHub-hosted Action execution and provider-origin proof remain separate gates in [IMP-13](IMP-13-action.md), [IMP-12](IMP-12-provider-boundary.md), and [IMP-18](IMP-18-cloudflare-preview-adapter.md).
