# IMP-58 — Actions default to a shallow checkout

- Status: In progress
- Phase: Actions
- Depends on: IMP-57 and the Action consumer slimming pull request (IMP-50 through IMP-56, TD12); both are merged
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

## Decisions

- **Token.** The CLI step gets `ARTIFACT_PAGES_FETCH_TOKEN: ${{ github.token }}` (site-publish, root and preview-publish; the admin Action reads no history). `github-token` stays `GITHUB_TOKEN` for private-config reads, but it may be a token for a different repository that cannot read the source repository, and the CLI would otherwise prefer `GITHUB_TOKEN` for the fetch. `gitdepth.AuthEnv` therefore prefers `ARTIFACT_PAGES_FETCH_TOKEN`, then `GITHUB_TOKEN`, then `GH_TOKEN`. The token reaches only the fetch subprocess through `GIT_CONFIG_*`, never `.git/config`, and `permissions: contents: read` suffices.
- **Preview preflight under depth 1.** The trust preflight still runs before any provider access and never needed local objects for the event path (it compares the event head SHA with GitHub's pull-request metadata). An explicit full-SHA `head` input is now compared with that metadata directly instead of through `git rev-parse`, because a depth-1 base-ref checkout lacks the head commit. A non-SHA `head` is still resolved locally. The Git-ref check keeps only the cases the CLI cannot repair: a head that is neither local nor a full SHA, and a default ref that is neither local nor `origin/<branch>`. The merge base is no longer checked there; the CLI fetches and deepens and reports `no merge base`.
- **Smoke.** The `actions-smoke` job checks out at depth 1. The preview step moved before the first site publish, because the first publish (no deployed state) unshallows the checkout; the smoke asserts the checkout is shallow and holds no `extraheader`, that the preview fetched `origin/<base>` and a merge base exists, and that `updatedAt` and `lastCommitter` of the published document equal the complete history.
- The public repository cannot exercise a private-repository fetch on a hosted runner; the first acceptance criterion needs a private-repository run before this item is Done.
- 2026-10-05 owner decision: v0.2.0 ships as a pre-release with the private-repository criterion recorded as known-unverified. The private-specific paths are tracked in [T23](../verification/T23-private-repository-topology.md); this item stays In progress until that run.
