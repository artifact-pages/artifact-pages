# IMP-70 — Bootstrap CLI re-exec and `cli-version` override

- Status: In progress
- Assignee: Codex
- Lanes: CLI, Actions
- Owner: Codex
- Depends on: [TD17](../technical-design/TD17-config-pinned-component-versions.md), IMP-69
- Blocks: IMP-72

## Goal

Any CLI resolves the config and re-executes the CLI version it names; the Actions install a bootstrap CLI, declare their supported range and accept an override (TD17 sections 4, 5, 5a and 6).

## Scope

- CLI: tolerant `cli.version` read after layer merge; download, verify, cache and re-exec; `ARTIFACT_PAGES_CLI_RESOLVED` loop guard; `--cli-version` and `ARTIFACT_PAGES_CLI_VERSION` precedence; downloads use only `ARTIFACT_PAGES_DOWNLOAD_TOKEN`, never the private-config token.
- The overriding CLI runs the same checks as IMP-69; an override never skips validation.
- The CLI release that implements this slice and IMP-69 is the lower bound of every Action's `cliRange` (older CLIs reject the new config keys).
- Actions: `release.json` schemaVersion 2 (`actionVersion`, `bootstrapCli`, `cliRange`, `repository`); range check before download, applied to the config version and to a `cli-version` override alike; `cli-version` input; summary line when an override ran; preview resolves only after the trust preflight from the trusted config; `ARTIFACT_PAGES_TEST_CLI` skips bootstrap and re-exec.

## Acceptance criteria

- [x] Tests for loop guard, range failure, precedence, token separation and preview ordering.
- [x] Action parity and hosted smoke pass with an unreleased bootstrap and a released target (or a local release fixture).
- [ ] Spec "Released CLI" text is updated (IMP-71) in or before the PR that merges this slice.

## CLI implementation handoff (Codex, 2026-10-08)

- The bootstrap shares T10 locator selection, private-config authentication, size limits and layer loading with the strict resolver. It interprets only `cli.version` and `web.version`, tolerates unknown fields and any config schema, and rejects malformed exact versions or a second layer setting either component. The selected target then runs the existing strict parser and IMP-69 checks.
- `--cli-version` wins over `ARTIFACT_PAGES_CLI_VERSION`, which wins over the merged config. The Action input becomes the environment value only when no caller environment override exists. `ARTIFACT_PAGES_CLI_RANGE` carries the Action range (`>=0.1.0 <0.2.0` initially); unsupported ranges and targets fail with exit 2 before download.
- Official root CLI release assets are checksum verified. The runner tool cache/user cache separates version and platform. Each cache reuse fetches current official checksums and hashes the cached bytes, including recreated 0.x releases; tampered/stale binaries are replaced only after verification. Anonymous rate-limit retries use only `ARTIFACT_PAGES_DOWNLOAD_TOKEN` through fixed official GitHub API URLs; private-config tokens never authenticate CLI downloads.
- Re-exec preserves arguments, standard input/output/error, environment and the child exit code. `ARTIFACT_PAGES_CLI_RESOLVED` prevents another resolution and fails if the executing binary differs. Introspection (`version`, help, `compatibility`) and commands without deployment config skip bootstrap unless an explicit override is given; release exports therefore describe the executing binary itself.
- Internal Action metadata: `ARTIFACT_PAGES_CLI_METADATA` names a wrapper-owned JSON file with `schemaVersion: 1`, `cliVersion` (actually executing binary), `configVersion`, `override`, `overrideSource` (`flag`, `environment`, or empty), and `resolved`. Failures before target execution keep the bootstrap version and `resolved: false`. The child carries the selected config pin through `ARTIFACT_PAGES_CLI_CONFIG_VERSION`. Operation JSON output remains unchanged. This `resolved` flag describes CLI selection, not completion of IMP-69's optional storage `pending` records: an override or source-test run never certifies pending/unknown storage.
- Unreleased Action source sets `ARTIFACT_PAGES_CLI_SKIP_RESOLUTION=1` after installing `ARTIFACT_PAGES_TEST_CLI`; the CLI still runs strict config and storage compatibility checks. A raw `ARTIFACT_PAGES_TEST_CLI` variable alone does not bypass resolution. Published wrappers remove inherited test/skip variables.
- Preview preflight supplies `ARTIFACT_PAGES_TRUSTED_CONFIG_REF` only after trust checks. Both tolerant and strict resolvers read repository-local layers from regular tracked files at that full base SHA, including default discovery when the PR removes the config. PR-added configs, base symlinks, and repository links escaping the checkout fail closed. Explicit external operator files preserve their existing authority; an external alias back into the checkout reads the base blob. Remote operator locators are unchanged. A missing base object can be fetched exactly with the workflow fetch/download token; private-config tokens are removed from that subprocess.
- `app deploy --version` now directs callers to config `web.version` or local `--archive`. A config with only `cli.version` requires `web.version` or `--archive` and fails with exit 2 before creating a backend or requesting an archive. Neither-pin legacy configs retain the root CLI-version web bundle path. **IMP-72 rollout dependency:** root CLI-only releases lack that legacy web asset; operational configs must set `web.version` before upgrading to the split-release CLI. No fallback infers a web version from a CLI tag.

CLI validation: full `go test ./cli/...` passed; targeted tests cover future schemas, remote/private locators, local layers and precedence, loop guards/ranges, checksum cache tampering/symlinks, download/fetch token separation, real child streams/exit codes, trusted preview base/deletion/addition/symlinks/shallow fetch, and strict/compatibility checks after resolution. An integrated local official-release fixture builds an actual target CLI (`0.1.99`), downloads its binary/checksum through the fixed official paths, re-executes it, records the actual target version and proves its incompatible-stored-web refusal before writes. Local Action parity with the actual unreleased CLI passed. Hosted Composite Actions smoke passed at `eb77b931` in [run 37702566666](https://github.com/artifact-pages/artifact-pages/actions/runs/37702566666); CI revalidation of the rebased head with the compatibility-test fixture repair and narrow release/reader documentation fixes is pending. The IMP-71 specification criterion remains pending; keep this item In progress until that criterion is verified.
