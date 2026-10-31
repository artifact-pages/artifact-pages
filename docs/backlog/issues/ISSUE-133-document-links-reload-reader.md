# Documentation links reload the reader on every page

- Status: Done
- Assignee: Codex
- Priority: P2
- Area: Web / published HTML navigation and Japanese documentation

## Problem

A same-site link inside a Japanese documentation page reloads the whole reader. With an empty or disabled browser cache this repeats the application download for each link and makes ordinary page-to-page reading feel slow.

## Evidence and reproduction

On 2026-10-30, the owner reported a recurring multi-second delay at `https://artifact-pages.dev/ja` with browser cache disabled. The docs' shared script used `top.location.assign` for same-site document links. On the `.stream` verification copy, five link clicks with Chromium, cache disabled, 100 ms latency and 1.6 Mbps downlink reloaded the top-level page, transferred approximately 247 KB of application JavaScript, and reached iframe reveal in 2.21–2.47 s. This controlled test reproduces the behavior for that interaction; it does not prove the cause of every delay observed by the owner.

## Expected outcome

A same-site documentation link can use the already open reader while retaining current site discovery, index freshness, ordinary link behavior and safe fallback in older readers.

## Acceptance criteria

- [x] A supported published HTML document can request same-site reader navigation without a full app reload, and unsupported readers retain ordinary navigation.
- [x] Each accepted request refreshes the relevant site index and site discovery, without reusing an expired or invalidated in-memory index; newly published pages are available subject to the existing CDN freshness policy.
- [x] Only the current published frame can request an eligible same-site route; preview, unrelated frame and external destinations are not intercepted. The check is for routing correctness, not a security boundary.
- [x] Back/Forward, query and fragments, modified clicks, downloads, focus and error/retry behavior remain usable.
- [x] Verify on the isolated Cloudflare target, including a newly published page and an older reader, and compare observable page-display time against the released baseline.
- [x] An independent review and relevant CI pass before merging; production deployment is separately authorized.

## Outcome

The reader bridge shipped in [#242](https://github.com/artifact-pages/artifact-pages/pull/242), with the documentation client in [docs #59](https://github.com/artifact-pages/docs/pull/59). Web v0.4.11 was deployed to production and the documentation was published on 2026-10-31. Five cache-disabled Chromium navigations under 100 ms latency and 1.6 Mbps downlink showed a production median of 694 ms versus 2,742 ms before; none reloaded the top-level document. This small controlled sample does not represent all users or initial page loads.
