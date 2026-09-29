# IMP-40 — Unified deployment config and site-description data flow

- Status: Done
- Phase: Phase 1 local product
- Execution: Agent-led local implementation; the owner-reviewed production UI follow-up is recorded in the issue-track completion note.
- Depends on: [T10](../technical-design/T10-config-location.md), [T11](../technical-design/T11-command-surface.md), [IMP-20](IMP-20-registry-projection.md), [IMP-23](IMP-23-registry-apply.md), and [IMP-27](IMP-27-admin-unregister.md).
- Related: [IMP-21](IMP-21-registered-discovery.md), [T13](../verification/T13-registered-flow.md), and the [product issue track](../issues/README.md).

## Outcome

One strict deployment YAML config can hold provider settings and the desired site registry. The `registry register` and `registry unregister` commands use that config, while an optional site description flows into deployed discovery metadata and remains backward-compatible when omitted.

## Scope

- Add an optional `sites` map to the unified deployment config, with strict validation and distinct behavior for an omitted map versus an explicitly empty map.
- Resolve provider target defaults without credential discovery: Cloudflare uses `artifact-pages` and its standard credential environment names; AWS derives an omitted bucket only from an explicit 12-digit account ID and region. Keep preview retention out of the CLI config.
- Have registry registration and removal project the configured site set without a separate manifest argument. Keep normal site-publish eligibility tied to the deployed registry.
- Carry optional descriptions from config through the registry and generated index metadata to browser discovery validation.
- Align the thin admin Action and local registered-site/clean-room examples with the single-config contract.
- Demonstrate the description hierarchy in Storybook, then apply the owner-reviewed hierarchy to the site picker and site search.
- Verify the local config, registry, publisher, Action-parity, and relevant browser flows.

## Non-goals

- IMP-037 Cloudflare entry-module work, IMP-038 Terraform Registry publication, and IMP-039 AWS configuration.
- Terraform or provider infrastructure changes, live cloud operations, or public releases.

## Acceptance criteria

- [x] The strict config parser accepts `sites` and optional string descriptions, rejects unknown or invalid fields, and preserves omitted-versus-empty `sites` behavior.
- [x] The strict version-1 parser accepts Terraform-generated AWS/Cloudflare targets, resolves and reports the effective bucket, rejects malformed or explicitly blank overrides, and rejects the removed `previewRetentionDays` field.
- [x] `registry register` and `registry unregister` consume the same selected config without a separate manifest flag; missing `sites` fails before storage access, explicit empty `sites` is valid, and a site can be unregistered only after it is absent from the configured set.
- [x] Normal site publication still checks the deployed registry; configured desired state does not grant publish eligibility by itself.
- [x] Optional descriptions survive registry projection and publication into per-site discovery metadata, browser validation accepts them, and omitted descriptions remain absent without breaking existing sites.
- [x] Action parity, registered-flow, clean-room adoption, and relevant local browser checks pass with the single-config contract.
- [x] Guides and examples describe the single config and register/unregister terminology. The owner-approved Storybook hierarchy is implemented in site selection and search; descriptions remain optional and searchable.
- [x] No IMP-037/038/039 or provider-infrastructure work is included in this slice.

## Verification

Verified locally on 2026-09-29:

- `go test ./...` and `go test -race -count=1 ./...` passed.
- `npm run build` passed as part of `npm run test:e2e` and `npm run test:registered-flow`; the app build reports the existing large-chunk advisory.
- `node scripts/test-actions-parity.mjs` passed for admin, site, and preview wrappers without provider credentials.
- `npm run test:registered-flow` passed its publish/update/unregister walkthrough and browser checks (2 passed, 1 expected skip).
- `node scripts/test-clean-room-adoption.mjs` passed with separate temporary admin and satellite repositories.
- `npm run test:e2e` passed all 66 local browser tests.
- `npm run build-storybook` completed successfully with both site-description concept stories.

UI follow-up verified locally on 2026-09-29:

- `npm run build` and `npm run build-storybook` passed after the production UI changes.
- The focused registered-discovery E2E passed 2/2 cases at a 320px viewport, covering long and omitted descriptions, description search, navigation, and horizontal overflow.
- The full E2E run passed 65/66 cases. One preview-HTML navigation case failed in the separate preview flow and also failed on isolated rerun; it does not exercise the site-picker or site-search changes.

Provider-config follow-up verified locally on 2026-09-29:

- `go test ./...` passed after removing CLI `previewRetentionDays`, resolving Cloudflare defaults and deterministic AWS bucket selection, and reporting effective deployment targets in text and JSON.
- `node --test infra/cloudflare/delivery/main.test.js` passed 8/8 checks after aligning the deployment example assertion with provider-only retention.
- `node --check scripts/run-edge-profile.mjs`, `git diff --check`, and `git check-ignore -v -- artifact-pages.cloudflare.yaml` passed.
- No AWS or Cloudflare account operations, Terraform apply, Registry publication, or public release was performed.

Independent provider-config verification on 2026-09-29:

- `go test ./... -count=1` passed with all live AWS/Cloudflare smoke-test switches explicitly disabled.
- `node scripts/test-actions-parity.mjs` and `npm run test:provider-delivery` passed; the latter completed 22/22 offline checks.
- `npm run test:registered-flow` passed the separate admin/satellite walkthrough, including dry-run, publication, update/removal, preview resources, browser reload, and scoped unregister.
- `E2E_PORT=4186 npm run test:e2e` completed with 65/66 cases passing. The previously recorded preview HTML-to-Markdown navigation failure reproduced at `e2e/local-serving.spec.ts:2777`; this is not an all-green browser result and remains separate from provider-config validation.
- The ignored `artifact-pages.cloudflare.yaml` uses `https://artifact-pages.dev`. Account and zone IDs remain explicit placeholders; cloud readiness is not claimed.

These checks establish the local contract and UI only. They do not claim live provider delivery, public distribution, or infrastructure work for IMP-037/038/039. The completed site-description issue record is retained in Git history.
