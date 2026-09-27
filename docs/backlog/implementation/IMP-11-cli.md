# IMP-11 — Pre-publish CLI and dry-run

- Status: Open
- Phase: Post-MVP preview
- Depends on: [IMP-02](IMP-02-source-selection.md)–[IMP-05](IMP-05-publication.md), and the public interface in [T2](../technical-design/T2-cli-action-interface.md)
- Proves: [T5](../verification/T5-concurrency-recovery.md), [T6](../verification/T6-resources-navigation.md)

## Outcome

Expose the same provider-neutral pre-publish operation locally and to a thin Action wrapper. Accept an explicit site and optional explicit PR number/URL; accept the T2-defined extra-resource inputs. Dry-run reports selection and intended catalog effect without provider writes.

## Acceptance criteria

- Help, errors and tests reflect exact T2 flags; omitted PR input stays manual, never inferred from local Git or CI environment.
- Typed `published`, `no-preview` and failure results expose the mutable group-list URL and revision-specific document URLs, with PR context when supplied.
- Dry-run distinguishes deletion-only `no-preview` from non-document-only error, lists document/resource changes and performs no provider write.
- Local and CI callers invoke the same core operation; CLI output is machine-readable where Action outputs require it.
