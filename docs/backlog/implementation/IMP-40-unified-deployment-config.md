# IMP-40 — Unified deployment config and site-description data flow

- Status: Done
- Phase: Phase 1 local product
- Execution: Agent-led local implementation; site-description UI placement remains under owner review in [ISSUE-013](../issues/ISSUE-013-site-description.md).
- Depends on: [T10](../technical-design/T10-config-location.md), [T11](../technical-design/T11-command-surface.md), [IMP-20](IMP-20-registry-projection.md), [IMP-23](IMP-23-registry-apply.md), and [IMP-27](IMP-27-admin-unregister.md).
- Related: [IMP-21](IMP-21-registered-discovery.md), [T13](../verification/T13-registered-flow.md), [ISSUE-013](../issues/ISSUE-013-site-description.md).

## Outcome

One strict deployment YAML config can hold provider settings and the desired site registry. The `registry register` and `registry unregister` commands use that config, while an optional site description flows into deployed discovery metadata and remains backward-compatible when omitted.

## Scope

- Add an optional `sites` map to the unified deployment config, with strict validation and distinct behavior for an omitted map versus an explicitly empty map.
- Have registry registration and removal project the configured site set without a separate manifest argument. Keep normal site-publish eligibility tied to the deployed registry.
- Carry optional descriptions from config through the registry and generated index metadata to browser discovery validation.
- Align the thin admin Action and local registered-site/clean-room examples with the single-config contract.
- Provide Storybook-only examples for the proposed description hierarchy. Keep production UI placement pending the owner review recorded in ISSUE-013.
- Verify the local config, registry, publisher, Action-parity, and relevant browser flows.

## Non-goals

- IMP-037 Cloudflare entry-module work, IMP-038 Terraform Registry publication, and IMP-039 AWS configuration.
- Terraform or provider infrastructure changes, live cloud operations, or public releases.
- Production site-picker or command-palette changes before the description placement review.

## Acceptance criteria

- [x] The strict config parser accepts `sites` and optional string descriptions, rejects unknown or invalid fields, and preserves omitted-versus-empty `sites` behavior.
- [x] `registry register` and `registry unregister` consume the same selected config without a separate manifest flag; missing `sites` fails before storage access, explicit empty `sites` is valid, and a site can be unregistered only after it is absent from the configured set.
- [x] Normal site publication still checks the deployed registry; configured desired state does not grant publish eligibility by itself.
- [x] Optional descriptions survive registry projection and publication into per-site discovery metadata, browser validation accepts them, and omitted descriptions remain absent without breaking existing sites.
- [x] Action parity, registered-flow, clean-room adoption, and relevant local browser checks pass with the single-config contract.
- [x] Guides and examples describe the single config and register/unregister terminology. The Storybook concept demonstrates the proposed hierarchy without changing production UI; ISSUE-013 remains Open until the placement review and UI work are complete.
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

These checks establish the local contract only. They do not claim live provider delivery, public distribution, or a reviewed production UI hierarchy. ISSUE-013 remains Open for the owner review and subsequent UI implementation.
