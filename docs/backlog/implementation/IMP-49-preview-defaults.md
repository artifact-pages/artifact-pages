# IMP-49 — Preview defaults from registry and deployment config

- Status: Done
- Lanes: CLI, Actions
- Execution: Agent-led.
- Depends on: [IMP-11](IMP-11-cli.md), [IMP-13](IMP-13-action.md), [IMP-40](IMP-40-unified-deployment-config.md)
- Related design: [TD8](../technical-design/TD8-action-consumer-contract.md)

## Goal

A satellite workflow calls the preview Action with only `site` (plus `pull-request` or `comment`). `source` and `base-url` come from the deployed registry and the deployment config.

## Slices

1. `preview publish --source` defaults to the site's registered source path; an explicit value must still match exactly.
2. `preview publish --base-url` defaults to the deployment config's origin: the new provider-neutral top-level `publicBaseURL`, or Cloudflare's `cloudflare.publicBaseURL`. An explicit value wins; with neither the command exits two.
3. The preview Action's `source` and `base-url` inputs become optional.

## Acceptance criteria

- [x] Omitted `--source` resolves from the deployed registry and non-matching explicit values still fail (`TestRunPreviewPublishDefaultsSourceAndBaseURLFromRegistryAndConfig`).
- [x] Omitted `--base-url` resolves from config, explicit wins, and the missing case exits 2 with guidance (same test and `TestRunPreviewPublishRequiresBaseURLWhenConfigHasNone`).
- [x] Config parsing, layering and the Cloudflare agreement rule are covered (`TestEffectivePublicBaseURL`, `TestParseLayersPublicBaseURLBelongsToTheTargetUnit`).
- [x] Specification §19 and §22 describe the defaults. `go test ./cli/...`, `npm run test:actions-shared` and `npm run test:actions-parity` pass.
