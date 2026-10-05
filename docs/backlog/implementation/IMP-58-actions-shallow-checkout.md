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
- [x] The token never appears in logs or in `.git/config` (private-repository run 2026-10-05, see Decisions).
- [ ] Guides and examples no longer require `fetch-depth: 0`.

## Decisions

- **Token.** The CLI step gets `ARTIFACT_PAGES_FETCH_TOKEN: ${{ github.token }}` (site-publish, root and preview-publish; the admin Action reads no history). `github-token` stays `GITHUB_TOKEN` for private-config reads, but it may be a token for a different repository that cannot read the source repository, and the CLI would otherwise prefer `GITHUB_TOKEN` for the fetch. `gitdepth.AuthEnv` therefore prefers `ARTIFACT_PAGES_FETCH_TOKEN`, then `GITHUB_TOKEN`, then `GH_TOKEN`. The token reaches only the fetch subprocess through `GIT_CONFIG_*`, never `.git/config`, and `permissions: contents: read` suffices.
- **Preview preflight under depth 1.** The trust preflight still runs before any provider access and never needed local objects for the event path (it compares the event head SHA with GitHub's pull-request metadata). An explicit full-SHA `head` input is now compared with that metadata directly instead of through `git rev-parse`, because a depth-1 base-ref checkout lacks the head commit. A non-SHA `head` is still resolved locally. The Git-ref check keeps only the cases the CLI cannot repair: a head that is neither local nor a full SHA, and a default ref that is neither local nor `origin/<branch>`. The merge base is no longer checked there; the CLI fetches and deepens and reports `no merge base`.
- **Smoke.** The `actions-smoke` job checks out at depth 1. The preview step moved before the first site publish, because the first publish (no deployed state) unshallows the checkout; the smoke asserts the checkout is shallow and holds no `extraheader`, that the preview fetched `origin/<base>` and a merge base exists, and that `updatedAt` and `lastCommitter` of the published document equal the complete history.
- The public repository cannot exercise a private-repository fetch on a hosted runner; the first acceptance criterion needs a private-repository run before this item is Done.
- 2026-10-05 owner decision: v0.2.0 ships as a pre-release with the private-repository criterion recorded as known-unverified. The private-specific paths are tracked in [T23](../verification/T23-private-repository-topology.md); this item stays In progress until that run.
- 2026-10-05 private-repository evidence ([T23](../verification/T23-private-repository-topology.md)): `artifact-pages-docs` is now private. [Preview run 37319833962](https://github.com/tasuku43/artifact-pages-docs/actions/runs/37319833962) for pull request #10 ran from a depth-1 checkout and logged `Preview head bb27d18d (event) -> fetched by the CLI; ... the CLI deepens a shallow checkout to the exact merge base`. The guide published only the changed page, architecture reported no preview, and the comment was posted. This establishes the head fetch and merge-base deepening in a private repository. Criterion 1 is not closed: no matching `fetch-depth: 0` run was compared, and a private `site-publish` that deepens was not separately inspected. Criterion 2 (token absent from logs and `.git/config`) was not checked explicitly. The item stays In progress; the remaining checks are a depth-0 comparison and a `.git/config` inspection.
- 2026-10-05 private-repository run (owner-approved verification, `site-publish` v0.2.0, dry-run, site `guide`, private `artifact-pages-docs`, temporary branch `verify/imp58-depth`, since deleted): [run 37321201663](https://github.com/tasuku43/artifact-pages-docs/actions/runs/37321201663) and [run 37321338179](https://github.com/tasuku43/artifact-pages-docs/actions/runs/37321338179), matrix `fetch-depth` 1 and 0.
  - Plans were identical: the same `changes` (`_artifacts/guide/en/publishing.html` and `_indexes/guide/index.json`, both `update`), `previewChanges`, `filesPublished` and `configCommitSha`. The plan JSON carries no per-document metadata, so the second run rebuilt the index in the job with `artifact-pages index build --site guide`. The depth-1 leg was re-shallowed first (`count=1`, `shallow=true`), and the CLI deepened it to the full history (`count=38`, `shallow=false`). The resulting `_indexes/guide/index.json` is identical to the depth-0 leg after `jq -S`, except for `generatedAt`; this includes `updatedAt` and `lastCommitter` of `en/publishing.html`, which had been edited in more than one commit.
  - Token: zero matches for `ghs_`, `ghp_`, `github_pat_` and `x-access-token` values in both logs; the only `AUTHORIZATION: basic` lines are `actions/checkout`'s own and are masked (`***`). `git config --get-regexp 'http\..*extraheader'` returned nothing after the Action step and after the CLI deepen in both legs.
  - Not covered by this run: `preview-publish` from a depth-1 checkout on a private repository, and a real (non-dry-run) publish. The first acceptance criterion names both actions, so this item stays In progress until the preview-publish leg is run.
