# A missing indexed HTML body shows only the server error inside the reader

- Status: Done
- Priority: P3
- Area: Reader / HTML artifact failure state
- Implementer: Claude
- Assignee: Claude
- Source: hands-on project review 2026-10-15, functional coverage note; monorepo `86841bb1`
- Related: [ISSUE-102](ISSUE-102-load-errors-offer-no-retry-action.md), [T24](../verification/T24-pre-launch-browser-and-keyboard-matrix.md)

## Problem

When a known artifact's HTML object is missing, the outer reader still presents the selected document and its normal toolbar while the iframe shows the server's bare “404 Not Found”. There is no reader-level explanation of the failed body or a way to retry that body. Existing outer site navigation remains usable, so this is a localized recovery improvement rather than a completely trapped reader.

## Evidence and reproduction

1. Serve a valid registry, site metadata and artifact index with an HTML entry such as `missing.html`.
2. Make only its `/_artifacts/<site>/missing.html` response return HTTP 404 with an ordinary server-error HTML body.
3. Open the logical route `/<site>/missing.html`. The document title/toolbar remain while the iframe shows “404 Not Found”.
4. The review reproduced this with a loopback static build, not by deleting production objects. `ArtifactWorkspace` renders the HTML iframe and handles its load for fragments/highlighting, but supplies no reader-level failure state.

Supplementary workspace evidence: `reviews/2026-10-15-project/missing-html.jpg` and `review-server.py`.

## Expected outcome

The reader can explain that a known HTML document's body is unavailable and expose a recovery path. This does not change the accepted unknown-route soft-404 policy or the trusted same-origin HTML model. The implementation must consider iframe error-detection limits; this issue does not prescribe a second request for every successful page load.

## Acceptance criteria

- [x] The known-HTML failure case has a reader-level explanation and an accessible recovery path, retaining navigation to the site.
- [x] If the body becomes available, its recovery action loads it without discarding the logical location unnecessarily.
- [x] Genuine unavailable content remains distinct from an unknown logical route and from intentionally authored HTML pages.
- [x] Successful HTML execution, relative resources, fragments and search highlighting keep working.
- [x] Record how failure detection behaves, including unavoidable detection limits and any added request cost; verify the reproduced 404 case.

## Verification

- Detection: the HTML iframe `onLoad` handler reads the frame's navigation entry (`contentWindow.performance.getEntriesByType('navigation')[0].responseStatus`) and treats a status of 400 or more as a failed body. The check is the first step of the handler; on failure the keydown forwarding, highlighting and height watching are skipped. It adds no request.
- Display: the iframe is hidden (kept mounted) and a `markdown-state` alert "Document unavailable" shows the title, `HTTP <status>`, a "Try again" button and a "← <site title>" link to the site root. The toolbar, breadcrumbs and sidebar are unchanged. "Try again" remounts the iframe with the same `src` (key `<artifactUrl>#<attempt>`), so the logical URL is unchanged; after a failed retry focus returns to the button. The failure state and counter reset when the artifact changes.
- Detection limit: browsers that do not expose `responseStatus` (for example Safari) report no status, so the check does nothing and the server's error page keeps showing in the frame as before. A cross-origin or unreadable frame is ignored the same way.
- E2E (Chromium): `a known HTML document whose body fails to load shows reader guidance and can be retried` serves an indexed `guides/missing.html` with a 404 HTML body, expects the alert with HTTP 404 and the site link, retries once while still 404 (focus on the button), then serves a valid page and retries: the iframe content shows and the URL is unchanged.
- Full e2e on the compose project `claude-issue-106-098` (port 4396): 224 passed. The existing HTML, fragment and search-highlight tests stay green.
