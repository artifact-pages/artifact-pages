# T13 — Registered admin and satellite flow

- Status: Open
- Phase: Provider-backed deployment

## Proof needed

- [ ] Validate strict YAML → sorted registry JSON, including malformed and empty registries.
- [ ] In separate admin and satellite checkouts, apply, publish, browse, update, and unregister one site while another stays intact.
- [ ] Confirm the satellite reads provider-origin registration after acquiring its site lock; no admin YAML checkout is needed.
- [ ] Exercise dry-run with zero provider writes, plus registration mismatch and direct-link/reload behavior.

## Evidence

Not yet recorded. A local proof does not establish cloud-provider behavior.
