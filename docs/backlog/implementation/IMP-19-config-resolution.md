# IMP-19 — Resolve a deployment configuration

- Status: Done
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

## Verification evidence

- `go test -count=1 ./internal/config` passes strict-schema, precedence, remote default-ref/file fallback, redaction, AWS region validation, and local/remote typed-config equivalence checks. The remote resolution case uses an empty satellite checkout without `sites.yaml`.
- `go test -count=1 ./cmd/artifact-pages -run 'TestDeploymentResultReportsResolvedRemoteConfigCommit|TestSitePublishRejectsMalformedConfigBeforeCreatingLocalBackend'` passes. It verifies text and JSON SHA reporting and confirms malformed credentials/config fail without creating the local backend or exposing the credential value.
- Provider commands resolve configuration before creating a backend or invoking mutation operations; remote resolution reports the commit SHA in text and JSON output.
