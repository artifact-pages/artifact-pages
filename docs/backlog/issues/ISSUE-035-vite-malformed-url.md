# Return a client error instead of crashing Vite on malformed URLs

- Status: Open
- Priority: P2
- Area: Local development / artifact middleware
- Review: 2026-09-28, finding 22, source revision `50c327d886c71fc5e0d086a5967b90cd9038e01e`

## Problem

Artifact URL decoding can throw outside the middleware error handler. One malformed percent-encoded request terminates the development server, interrupting all local product work.

## Evidence and reproduction

1. Start an independent Vite server, not an existing user session.
2. Send `curl --path-as-is http://127.0.0.1:<port>/_artifacts/bad%`.
3. On Node 22.14.0 the review observed URIError, process exit 1, an empty reply, and a subsequent root request failing with connection refused.

Reviewed source: [vite.config.ts:53](../../../vite.config.ts). The review's supplementary local evidence is `.local/reviews/2026-09-28/vite-malformed-url-evidence.json`; it is ignored and is not required to understand or reproduce this issue. Preserve the reproduction as a committed regression when implementing the fix.

## Expected outcome

Malformed client paths receive a clear 4xx while the local server continues to serve valid requests.

## Acceptance criteria

- [ ] Malformed percent encodings return a controlled client-error response and leave the server alive.
- [ ] A subsequent `/` request and a valid artifact request succeed in the same process.
- [ ] Valid encoded spaces, Unicode, percent signs, and traversal rejection retain correct behavior.
- [ ] Add a process-level regression so exception handling is verified beyond a standalone decoder unit test.
