# `config set-default --help` saves "--help" as the default config

- Status: Open
- Priority: P2
- Area: CLI — `artifact-pages config set-default`

## Problem

Asking for help on `config set-default` does not print help. The CLI treats `--help` as the locator, resolves it against the current directory, and saves it as the user's default deployment config. The command reports success, so the user has no reason to suspect that a persistent setting changed. Later commands that rely on the saved default (no `--config`, no `ARTIFACT_PAGES_CONFIG`, no `./artifact-pages.yaml`) then point at a nonexistent file.

## Evidence and reproduction

1. From the repository root, run `artifact-pages config set-default --help`.
2. Observed (2026-10-02, during the documentation review): no usage text; `~/Library/Application Support/artifact-pages/default-config` was created containing `<repo>/--help`.
3. Cause, confirmed in source: `cli/cmd/artifact-pages/main.go` handles `--help`/`-h` only as `args[1]`; for `config set-default --help` it passes `args[2]` straight to `deploymentconfig.Resolver.SetDefault`. Any other flag-shaped argument (`-h`, `--dry-run`) is accepted the same way.

## Expected outcome

`config set-default --help` and `-h` print the command's usage and change nothing. A locator that looks like a flag is rejected with a usage error instead of being saved.

## Acceptance criteria

- [ ] `config set-default --help` and `config set-default -h` print usage, exit 0, and do not create or modify the default-config file.
- [ ] `config set-default` with any other argument starting with `-` exits 2 with a usage error and writes nothing.
- [ ] A regression test covers both cases in `cli/cmd/artifact-pages`.

## Resolution

`config set-default` now handles `--help`/`-h` as its third argument by printing usage on stdout, and rejects any locator starting with `-` with a usage error (exit 2) before `SetDefault` runs. Sibling commands (`lock`, `registry`, `site`, `app`, `preview`, `index`) already handle help, through the `flag` package or explicit checks, and were left unchanged.

Verified with `cd cli && go vet ./... && go test ./... -count=1` (all packages pass), including `TestConfigSetDefaultHelpAndFlagLikeLocatorWriteNothing` in `cli/cmd/artifact-pages/main_test.go`, which asserts usage output, exit code 2 for `--dry-run`, `-x` and `--config=foo`, and that no file is written under the user config directory.
