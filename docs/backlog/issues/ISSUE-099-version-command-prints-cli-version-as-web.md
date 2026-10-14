# The version command prints the CLI version as the web app version

- Status: Done
- Assignee: Codex
- Priority: P3
- Area: CLI
- Implementer: Codex
- Source: cold-start trial A, 2026-10-14

## Problem

`artifact-pages version` prints a line `Web app   v<CLI product version> (pinned; deployed by app deploy)`. The web app has its own `web/vX.Y.Z` release series ([TD17](../technical-design/TD17-config-pinned-component-versions.md)), so the line shows a web version that does not exist. An operator reading it can believe the wrong bundle is pinned.

## Evidence and reproduction

1. Run `artifact-pages version` with CLI v0.4.2.
2. Observed: `Web app   v0.4.2 (pinned; deployed by app deploy)`. The web releases at that time were 0.3.x (0.3.2 and 0.3.1 were deployed in the trial).
3. Source: `cli/cmd/artifact-pages/main.go`, the version writer, the line that formats `"v"+version.Product` for the web app.

## Expected outcome

The command shows only versions the CLI really knows. Open question for Codex to settle with the owner, with two options:

- Drop the `Web app` line.
- Keep a line that reports only what the CLI knows, such as the web version pinned in the loaded config, or none when no config is loaded.

## Acceptance criteria

- [x] `artifact-pages version` never prints the CLI product version as the web app version.
- [x] The chosen option is covered by a test of the text output.

## Resolution

Removed the misleading `Web app` line; the text output test still checks the CLI product, revision, and Go lines. The JSON output is unchanged.
