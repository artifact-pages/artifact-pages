# T2 — CLI and Action interface

- Status: Open
- Phase: Post-MVP preview

## Design question

What are the exact CLI flags, resource-include syntax, and Action inputs/outputs for pre-publish and production publish? The same core operation must work locally and from CI; workflows choose when to invoke it.

## Exit criteria

- [ ] Document exact command forms and dry-run output for explicit site selection, optional PR number or URL, source comparison, and additional non-document resources. Omitted PR input must remain manual; neither CLI nor Action silently infers it.
- [ ] Define normalization and validation of an explicit PR reference against the registered source repository and previewed head before claiming PR provenance.
- [ ] Define typed outputs for `published` and `no-preview`, including group-list and fixed document URLs.
- [ ] Define the Action boundary as a thin CLI wrapper, without requiring a reusable workflow or a separate cleanup command.
- [ ] Reconcile the [publishing contract's input/output table](../../architecture/preview-publishing-contract.html#inputs) with CLI help and the [specification](../../specification.md#post-mvp-pre-publish-preview-contract).

## Evidence

Not yet recorded. Names in the current contract are illustrative.
