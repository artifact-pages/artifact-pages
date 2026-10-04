# TD13 — Shallow-clone publish and preview

- Status: Done
- Phase: CLI read side (Git history)
- Decided: 2026-10-05 (owner decision: deep `fetch-depth: 0` clones are slow; publish and preview must work from shallow clones with results identical to a full clone)
- Related implementation: [IMP-57](../implementation/IMP-57-shallow-clone-publish-and-preview.md), [IMP-58](../implementation/IMP-58-actions-shallow-checkout.md)
- Builds on: [TD6](TD6-fused-publish-state.md) (per-object SHA-256 rows in the committed publish state)
- Product contract: [Specification, Git metadata](../../specification.md) and [preview selection](../../specification.md)

## Problem

History is read in two places. Production publish derives each document's `updatedAt` and `lastCommitter` from `git log` over the source path. With a depth-1 clone every tracked file appears to have been added by HEAD, so every document would silently get HEAD's commit. Preview selection needs the merge-base of the default ref and the head; a shallow clone has none, and a partially deepened one can report a merge-base that is not the most recent common ancestor.

## Decision

Detect a shallow checkout with `git rev-parse --is-shallow-repository`. A complete checkout keeps the existing code path byte for byte. A shallow checkout never trusts a shallow boundary commit (listed in the repository's `shallow` file) as a real touching commit.

### Production publish

1. Read, read-only and also in dry-run, the committed publish state (one GET) and the deployed `_indexes/<site>/index.json`. The index is trusted only when its SHA-256 equals the digest of its row in the state. A mismatch, a missing state or a missing index means no trustworthy prior state.
2. No trustworthy prior state: `git fetch --unshallow`, then the existing path.
3. Otherwise carry forward a document's deployed `updatedAt` and `lastCommitter` when all hold:
   - it was deployed with a committer (it had Git history);
   - its attribution scope has identical paths and SHA-256 values in the state and in the checkout, computed under each side's own document layout. The scope is the existing roll-up rule: a document file belongs to itself; any other file belongs to every document in the nearest ancestor directory holding documents, falling back to the root;
   - no source path removed since the deployment rolls up into it under the current layout (a deleted document or resource still appears in `git log --name-only` and attributes to its surviving neighbours).
4. Every other document is computed from `git log` (the log pass also records which commits are shallow boundaries). A result is accepted only if the newest non-boundary touching commit is strictly newer than every boundary commit touching the document. Otherwise deepen `origin` by cumulative `--deepen` steps of 8, 32, 128, 512, 2048, then `--unshallow`, and recompute; failing after that is an error.
5. A carried document is replaced by a visible non-boundary commit that touches its scope and is newer than the deployed value. This catches a revert to identical bytes when that commit is within the fetched history.
6. Working-tree and filesystem-mtime fallbacks are applied after this step and are unchanged. Untracked or ignored documents have no history in either clone kind, so they keep the filesystem fallback.

### Preview

Missing `origin/<branch>` default ref or head SHA: fetch it at depth 1 (this reduces the Action change to a token and an unchanged `fetch-depth: 1`). Then deepen both refs by the same steps until the merge-base is exact: it exists and every shallow boundary reachable from either ref is an ancestor of it or equal to it. If a boundary is not below the merge-base, a more recent common ancestor could be hidden past it, so deepening continues; after `--unshallow` the plain result is returned or "no merge base" is reported. Selection stays merge-base-based. It never compares against production state, which the specification forbids because main-only changes would be flagged.

### Dry-run

Deepening only writes Git objects into the local checkout and nothing to the provider, so dry-run deepens too. This keeps the dry-run plan equal to the real run.

### Credentials

The CLI never persists credentials. When `origin` is an HTTPS URL on `github.com` or on the `GITHUB_SERVER_URL` host, no `http.extraheader` is already configured for that URL, and `GITHUB_TOKEN` or `GH_TOKEN` is set, the fetch subprocess receives `GIT_CONFIG_COUNT/KEY_n/VALUE_n` with `http.<origin>/.extraheader` set to a basic `x-access-token` header. Existing `GIT_CONFIG_*` entries are preserved. Other hosts and SSH remotes get no token, so it cannot leak to an unrelated server. `GIT_TERMINAL_PROMPT=0` prevents prompts. Any Git output is redacted of the token and its encoding before it is shown. The failure message names `fetch-depth: 0` as the alternative.

## Answers to the open questions

- **Force push or history rewrite.** Carry-forward is keyed on bytes, not commits, so a rewrite that changes bytes is recomputed correctly. A rewrite that preserves bytes while changing commit times or committers is not detected: a full clone would report the new values, the shallow path keeps the deployed ones. This is a deliberate limit. Use a full clone to force recomputation. It is stated in the specification. The same limit covers a byte-identical commit (a revert to the deployed bytes, a touch, or a content-preserving rewrite) that lies beyond the fetched history: the document keeps the carried-forward `updatedAt` and `lastCommitter`. The owner accepted this on 2026-10-05 as a constraint of the design, with no schema change.
- **Multi-commit pushes.** Handled by deepening until each changed document resolves to a non-boundary commit. Tests cover 10 and 40 commits since the last publish, a shared resource change, and an old changed document that needs three deepen steps.
- **Renamed files.** The log uses `--no-renames`, so a rename is a delete plus an add. The destination is a new document, with no deployed entry and therefore computed. The deleted source path rolls up into its former neighbours and is handled by the removed-path rule.
- **Files without Git history.** Unchanged: filesystem mtime and no committer.

## Deviations from the first design and judgement calls

- **Attribution scope, not only the document's own hash.** The delegating brief said to compare the document hash and its rendering-resource hashes. The code's metadata rule is directory roll-up, not rendering closure, so the scope uses that rule. Using the rendering closure would give different answers from a full clone.
- **Removed paths invalidate neighbours.** Not in the first design. Without it, a lone deletion at HEAD would be invisible to a shallow publish and would diverge from a full clone.
- **State is read before the source is prepared.** The deployed index (one extra GET) and the state body are read only when the checkout is shallow, through a lazy loader. For a shallow checkout the state is therefore read twice on a no-op publish (once for the loader, once for the existing fast-path check). Full clones are unchanged.
- **The deployed index must match the state digest.** The state holds hashes but not metadata. The index holds metadata but is not transactionally bound. The digest check ties them together and routes an interrupted transaction or out-of-band edit to the safe unshallow path.
- **Branch base.** Based on `origin/main`, which contains the fused schema-1 publish state (TD6). It does not depend on the Action consumer slimming branch's code.
- **No new state fields.** The deployed commit SHA is not recorded, so the deployed point in history cannot be located directly. Adding it would change the private control schema, and the owner declined a schema change on 2026-10-05 (see the accepted limitation above). It remains the natural future improvement if byte-identical commits matter: deepen until the deployed commit is present.

## Action follow-up

Recorded as [IMP-58](../implementation/IMP-58-actions-shallow-checkout.md): the Actions must switch to `fetch-depth: 1`, pass the token and relax the `fetch-depth: 0` error in `actions/shared/preview-refs.mjs`. This design does not edit the Actions.
