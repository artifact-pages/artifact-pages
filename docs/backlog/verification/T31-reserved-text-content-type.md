# T31 — Reserved-name text artifact MIME and reader behavior

- Status: Open
- Phase: Provider-backed deployment

## Observation and comparison

**Cloudflare local scoped-credential evidence (CLI 0.4.4 darwin_arm64); not hosted Actions/OIDC.** A6 P3 recorded 200 `application/octet-stream` for `reserved/space name.txt`, `reserved/café.txt`, `reserved/hash#mark?.txt` (once-encoded URLs). Source: `~/.config/artifact-pages-verify/a6-20261024/evidence/NOTES-A6-part1.md`, `p3/`, and the [A6 result](provider-proof-plan-2026-10-18.md#cloudflare-a6a7-execution-result--october-2425-2026). This was successful resource fetch evidence, not proof of native inline text rendering.

**AWS comparison, separate earlier evidence:** `~/.config/artifact-pages-verify/a5-20261020/evidence/p3/browser-{proof-a-20261018,proof-b-20261018,proof-neighbor-20261018,preview-a}.json` each records the same three encoded paths as 200 `application/octet-stream`, with byte lengths 19, 21 and 31 respectively. This is an inspection of saved AWS evidence, not a new AWS run. The Cloudflare label above applies only to the Cloudflare observations.

## Backend assessment

No Cloudflare-specific defect is established: AWS matches, and the shared publisher `contentType` mapping in `cli/internal/publisher/publish.go` has no general `.txt` case and falls back to `application/octet-stream` (notice files have a separate text/plain special case). Reserved-name encoding itself worked. Do not infer a Cloudflare header rewrite or a reserved-character MIME bug. A fetch success alone does not decide whether this fallback gives the intended raw-text reading experience. Keep this as verification of that boundary rather than asserting an unobserved user-facing failure or silently adding a text/plain guarantee to the specification.

## Proof needed

- [ ] Compare stored Content-Type with delivered headers and bytes for ordinary and reserved-name `.txt` artifacts, covering production and preview from saved evidence where available; distinguish publisher metadata from provider transformation.
- [ ] Check direct/raw and reader behavior (display/download, disposition, nosniff) against the accepted artifact-type contract and record whether a reader-facing defect exists. If it does, file one shared publisher issue with observable impact and text/plain acceptance criteria; if the fallback is intentional, record that outcome and close this proof without changing the product contract.

No new provider execution is authorized; use saved evidence first. Any future live proof needs its own owner-approved scope. T4/T15 remain open for their broader delivery criteria.
