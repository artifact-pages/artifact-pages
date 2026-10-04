# IMP-58 — Actions default to a shallow checkout

- Status: Open
- Phase: Actions
- Depends on: IMP-57, and the Action consumer slimming pull request (branch `action-consumer-slimming`, IMP-50 through IMP-56 and TD12) merged first. This item edits the same Action wrappers, `actions/shared/preview-refs.mjs` and parity test that pull request changes, so it must start from its merged result and must not be implemented before it lands
- Design: [TD13](../technical-design/TD13-shallow-clone-publish-and-preview.md)

The CLI now handles shallow checkouts. The Actions and their documented examples still demand full history.

## Work

- Change the documented and example default checkout to `fetch-depth: 1`.
- Pass `GITHUB_TOKEN` (or `GH_TOKEN`) into the CLI step's environment so deepening can fetch from a private repository. `actions/checkout` is used with `persist-credentials: false`, so the checkout holds no credential. The CLI scopes the token to the fetch subprocess only.
- Relax the `fetch-depth: 0` failure in `actions/shared/preview-refs.mjs` (`assertPreviewRefsReachable`): do not require that the head, default ref and merge-base resolve in the checkout. The CLI fetches a missing `origin/<branch>` or head SHA at depth 1 and deepens to the merge-base. Keep the check that the head input resolves to a SHA when it is a `pull_request` event SHA.
- Update the Action parity test and the hosted smoke workflow to run from a depth-1 checkout, for both `site-publish` and `preview-publish`.
- Document that `permissions: contents: read` is enough for the fetch, and that a full clone remains available when content-neutral commits between publishes must be reflected.

## Acceptance criteria

- [ ] `site-publish` and `preview-publish` run from `fetch-depth: 1` on a hosted runner against a private repository and match the results of a `fetch-depth: 0` run.
- [ ] The token never appears in logs or in `.git/config`.
- [ ] Guides and examples no longer require `fetch-depth: 0`.
