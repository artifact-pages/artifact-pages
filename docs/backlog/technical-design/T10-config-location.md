# T10 — Configuration locator and precedence

- Status: Open
- Phase: Provider-backed deployment

## Design question

How does one CLI resolve the deployment target from an explicitly selected local or Git-hosted configuration file, without coupling a satellite checkout to the admin repository?

## Exit criteria

- [ ] Specify the config document, local-path and remote-reference forms, default remote ref/file fallback, and `--config` / environment / saved-default precedence.
- [ ] Separate target configuration from the admin-owned `sites.yaml` manifest; the satellite reads the deployed registry, not the manifest.
- [ ] Define authentication, pinning/freshness, error handling, and redaction for remote config resolution; never imply a remote URL is a trust boundary.
- [ ] Provide one-repository and separate admin/satellite examples, including an explicit site selection in both cases.
- [ ] Update the specification before implementing the public syntax.

## Evidence

Not yet recorded. Earlier CLI discussions established the conceptual split, not a frozen file format or flag set.
