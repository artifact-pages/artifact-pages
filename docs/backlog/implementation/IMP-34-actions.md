# IMP-34 — Thin admin and site GitHub Actions

- Status: Done
- Phase: Reusable distribution
- Depends on: [IMP-23](IMP-23-registry-apply.md), [IMP-26](IMP-26-site-publish-command.md), [IMP-31](IMP-31-app-distribution.md), [T11](../technical-design/T11-command-surface.md)
- Proves: Actions integration with OIDC and local CLI parity

## Outcome

Offer optional, versioned Action entry points for registry/application and site workflows while leaving trigger timing to each adopting repository.

## Acceptance criteria

- Wrappers call the same CLI operations and expose typed outputs/exit status; PR workflows can use dry-run, and merge or other chosen events can apply/publish.
- Examples show least-privilege admin versus satellite credentials and an explicitly selected site; all already-published third-party Actions use full-SHA pins. The Artifact Pages release ref remains a documented placeholder until a public release exists, tracked under [T16](../verification/T16-external-adoption.md).
- No required reusable workflow, implicit PR discovery, or mandatory preview cleanup workflow is introduced; compose preview [IMP-13](IMP-13-action.md) where appropriate.
- A smoke test compares direct CLI and Action results for equivalent inputs.

## Local implementation and evidence

`actions/admin/action.yml` wraps registry publish, registry unregister, and app deploy; `actions/site-publish/action.yml` requires an explicit site and wraps site publish. Both build the CLI from the Action's pinned source and call the shared CLI with JSON output. Their outputs preserve the result object, JSON change arrays, operation/outcome/site, registry-updated state when present, error text, and original CLI exit code. Dry-run is available for registry, site, and application planning. No reusable workflow, inferred site, PR discovery, or standalone preview-cleanup policy is added.

`node scripts/test-actions-parity.mjs` builds the CLI and compares direct invocations with the same shared invocation entry point used by the composite Actions, with separate local targets for each path. It verifies registry publish and unregister, explicit-site publish, and app deploy in both dry-run and apply modes; exact JSON result/output, stdout, and exit-code parity; invalid-manifest and unregistered-site failures; and unchanged storage after dry-runs and validation failure. The site-publish case seeds the same stale preview catalog reference in both targets, confirms a missing completion manifest is planned as `remove`/`manifest-missing` without writes, and then verifies apply removes the stale reference. The script also checks composite input/output wiring, workflow example naming and explicit site selection, scoped GitHub permissions, distinct registry/app/satellite role variables, and full-SHA pins for third-party Action references. The third-party checkout, Go setup, and AWS credential Action references in the templates are pinned by full commit SHA.

This completes the Action source, examples, and local parity implementation. No GitHub-hosted Action run, OIDC role assumption, AWS/Cloudflare provider operation, or released Artifact Pages Action reference was exercised. Replace the documented Action-reference placeholder with the full SHA of the reviewed published commit when a release is available; T15/T16 own those release and live-provider checks.
