# Bare apply commands print help and exit 0 instead of running

- Status: Done
- Priority: P1
- Area: CLI command dispatch

## Problem

`artifact-pages app deploy`, `registry register`, `registry unregister`, `site publish` and `preview publish` printed their usage to stdout and exited 0 when given no further arguments, without resolving a config or changing anything. The documented admin workflow ("run `artifact-pages registry register`", config resolved from `ARTIFACT_PAGES_CONFIG`, `artifact-pages.yaml` or the saved default) silently did nothing, and a CI step running the bare command would report success for a no-op.

## Evidence and reproduction

1. In a directory with a valid `artifact-pages.yaml`, run `artifact-pages registry register`.
2. Observed: usage on stdout, exit 0, no registry written. Confirmed in `run` in `cli/cmd/artifact-pages/main.go`, where each leaf command was guarded by `len(args) < 3 || args[2] == "--help" || args[2] == "-h"`, so "no further arguments" was treated as a help request.
3. The specification (§22) and T10 define the resolution order `--config`, `ARTIFACT_PAGES_CONFIG`, repository-local `artifact-pages.yaml`, saved default, and only an explicit help flag is a help request.

Not affected: `lock inspect|recover` and `index build` already ran their flag handling for bare invocations; `version` runs without arguments. Group commands with no subcommand (`app`, `registry`, `site`, `preview`, `lock`, `config`, `index`) still print group usage and exit 0; they select no operation and are out of scope.

## Expected outcome

A bare apply command resolves its config the normal way and runs. With no resolvable config it fails non-zero with "no deployment config found; pass --config, set ARTIFACT_PAGES_CONFIG, add artifact-pages.yaml, or save a default". Commands that require flags fail on the missing flag. Only `-h` / `--help` prints help and exits 0.

## Acceptance criteria

- [x] A bare `registry register` with a resolvable config (repository-local file or `ARTIFACT_PAGES_CONFIG`) runs and writes the registry.
- [x] Bare `app deploy`, `registry register`, `registry unregister`, `site publish` and `preview publish` with no resolvable config fail non-zero and do not print usage on stdout; the config commands report the no-config message.
- [x] Bare `registry unregister`, `site publish` and `preview publish` fail on `--site is required`.
- [x] `--help` and `-h` still print usage and exit 0 for each of the five commands.
- [x] Regression tests in `cli/cmd/artifact-pages/bare_command_test.go` fail before the fix (10 failures) and pass after; `go test ./... -count=1` and `npm run test:actions-parity` pass.
