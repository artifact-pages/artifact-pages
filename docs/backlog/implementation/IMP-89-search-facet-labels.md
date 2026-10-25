# IMP-89 — Readable folder facets and snippet recheck

- Status: Done
- Assignee: Codex
- Scope: UI/UX S7

## Accepted outcome

Search facets show sidebar names with secondary paths. Counts, rank, in= identity and partial-result truthfulness are unchanged. Recheck published snippets after docs search-ignore markers; no document body edits or frontend fixed-string deletion.

## Verification

Build and278 web units passed. Search suite48 passed with one added assertion using a nonexistent status class; corrected selector, then integrated8/8 cases passed, including S6 modes and new label/reload/unknown behavior. Fresh Sonnet5.5 medium independent review: no actionable P0–P2. Live production query Cloudflare now shows relevant article excerpts without skip/step navigation; actual published HTML carries search-ignore markers. Workspace evidence S7-LIVE-SNIPPETS.md, S7-REVIEW.md and s7-live-cloudflare-snippets.png. No public document or extraction changes. No release/deploy.
