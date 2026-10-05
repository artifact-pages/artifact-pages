# DOC-15 — Guide: shallow checkouts and document dates

- Status: Done
- Site: `guide`
- Page: revision of `ja/publishing.html` and `en/publishing.html` (the "Dates and committers" section and the example workflow that currently sets `fetch-depth: 0`). Optional one-paragraph pointer in `architecture` `publishing-model.html`.
- Audience: Adopters writing their publish workflow and deciding between a shallow checkout and a full clone
- Depends on: [IMP-58](../implementation/IMP-58-actions-shallow-checkout.md) merged and released, so that `fetch-depth: 1` is the Actions' default

The public docs live in the separate `artifact-pages-docs` repository (`sites/guide/{ja,en}/publishing.html`); this ticket records the change to make there and does not edit that repository.

## Purpose

Tell adopters what the default shallow checkout does to per-document `updatedAt` and `lastCommitter`, and when to choose a full clone instead.

## Scope

- With `fetch-depth: 1` (the default since IMP-58), the CLI deepens the checkout on demand and carries forward each document's deployed `updatedAt` and `lastCommitter` by content (SHA-256 of the document and the files attributed to it). The published dates equal those of a full clone in normal use.
- The accepted limitation: a byte-identical commit that lies beyond the fetched history does not bump the dates. Examples: a revert back to the published bytes, a touch, or a content-preserving history rewrite. A full clone (`fetch-depth: 0`) would report the new commit time and committer. The owner accepted this on 2026-10-05 (see [TD13](../technical-design/TD13-shallow-clone-publish-and-preview.md)).
- Switching the depth later (or the first publish after a missing or unverifiable deployed state, which unshallows) can change those dates on the next publish, because dates are then recomputed from the visible history.
- When to use `fetch-depth: 0`: content-neutral commits between publishes must be reflected in the dates.
- Update the example workflow: drop `fetch-depth: 0` and its "dates and committers come from Git history" comment, or show `fetch-depth: 0` only as the opt-in for the case above. `permissions: contents: read` is enough for the fetch.

## Out of scope

- The deepening algorithm and the publish-state mechanics (belong in `architecture`, at most one pointer paragraph).
- Preview selection (the merge base is exact in both modes).

## Primary sources

- [Specification: Git metadata, Shallow checkouts, and Action checkout](../../specification.md)
- [TD13](../technical-design/TD13-shallow-clone-publish-and-preview.md) (accepted limit and answers to the open questions)
- [IMP-58](../implementation/IMP-58-actions-shallow-checkout.md), [Guide: GitHub Actions](../../guides/github-actions.md)

## Acceptance criteria

- [x] `ja/publishing.html` and `en/publishing.html` state the default shallow checkout, the carry-forward-by-content rule, the byte-identical-commit limitation with at least the revert and no-op rewrite examples, and the effect of switching depth later.
- [x] The example workflow no longer implies that full history is required.
- [x] Every statement matches the specification and TD13; the page introduces no behavior they do not state.
- [x] Renders correctly in light and dark themes and at ~400px width without horizontal scrolling.
- [x] Published locally with `site publish --dry-run` then `site publish`, and opened in the local reader.
- [x] The owner reviewed and approved the page.

## Result

Published on 2026-10-05 after owner approval. Pages: [`publishing.html#shallow`](https://artifact-pages.dev/guide/en/publishing.html#shallow) (ja: `/guide/ja/publishing.html`){extra}. Docs PR: https://github.com/tasuku43/artifact-pages-docs/pull/12. Publish run on main (guide `published`, architecture `no-op`): https://github.com/tasuku43/artifact-pages-docs/actions/runs/37327799565. Example workflows pin `@v0.2.1`.
