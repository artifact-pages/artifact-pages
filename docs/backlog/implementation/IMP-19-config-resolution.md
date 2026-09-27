# IMP-19 — Resolve a deployment configuration

- Status: Open
- Phase: Provider-backed deployment
- Depends on: [T10](../technical-design/T10-config-location.md)
- Proves: local/remote resolution and precedence tests

## Outcome

Make the CLI resolve one explicit deployment target from the T10-defined configuration locator, independently of the current repository and of `sites.yaml`.

## Acceptance criteria

- Local and supported remote config forms resolve to the same typed provider settings; precedence, defaults and failures match T10.
- A satellite checkout can resolve its target without cloning or reading the admin repository's manifest.
- Invalid or inaccessible config fails before any provider mutation; diagnostics do not print credentials.
- Tests cover precedence, missing/default remote ref or file, and malformed config.
