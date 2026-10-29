# A site without previews makes every page load log a failed request

- Status: Open
- Priority: P3
- Area: Web / previews, publisher

## Problem

When a site has never had a preview, `/_previews/<site>/catalog.json` does not exist. The reader requests it on site pages (for the Previews count) and treats 404 as "no previews", which is correct, but the browser logs "Failed to load resource: 404" in the console on every load. Operators checking the console, and monitoring that counts 4xx, see an error that is not one. Found in the ja docs review of 2026-10-29 (B2): every page of https://artifact-pages.dev/ja logs it.

## Expected outcome

A site with no previews loads without a failed request, or the 404 is explicitly accepted as the contract and documented for operators.

## Acceptance criteria

- [ ] Decision recorded (backend designer): make the absence observable without a 404 (for example from data the reader already loads), or keep the 404 as the contract and document it in the operator docs.
- [ ] If changed: no 404 request for a site without previews; Previews count and list unchanged for sites with previews; compatibility with existing published data stated.
