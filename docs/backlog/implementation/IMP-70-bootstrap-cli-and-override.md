# IMP-70 — Bootstrap CLI re-exec and `cli-version` override

- Status: Open
- Lanes: CLI, Actions
- Owner: Codex
- Depends on: [TD17](../technical-design/TD17-config-pinned-component-versions.md), IMP-69
- Blocks: IMP-72

## Goal

Any CLI resolves the config and re-executes the CLI version it names; the Actions install a bootstrap CLI, declare their supported range and accept an override (TD17 sections 4, 5, 5a and 6a).

## Scope

- CLI: tolerant `cli.version` read after layer merge; download, verify, cache and re-exec; `ARTIFACT_PAGES_CLI_RESOLVED` loop guard; `--cli-version` and `ARTIFACT_PAGES_CLI_VERSION` precedence; downloads use only `ARTIFACT_PAGES_DOWNLOAD_TOKEN`, never the private-config token.
- Actions: `release.json` schemaVersion 2 (`actionVersion`, `bootstrapCli`, `cliRange`, `repository`); range check before download; `cli-version` input; summary line when an override ran; preview resolves only after the trust preflight from the trusted config; `ARTIFACT_PAGES_TEST_CLI` skips bootstrap and re-exec.

## Acceptance criteria

- [ ] Tests for loop guard, range failure, precedence, token separation and preview ordering.
- [ ] Action parity and hosted smoke pass with an unreleased bootstrap and a released target (or a local release fixture).
- [ ] Spec "Released CLI" text is updated in IMP-71 before merge of this slice.
