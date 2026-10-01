# IMP-42 — Committed-query full-text search UX integration

- Status: Deferred
- Priority: P2
- Phase: Phase 1 local product
- Execution: Agent-led exploration and implementation after owner requests continuation.
- Depends on: [IMP-41](IMP-41-fulltext-search-core.md) (Done).
- Contract/API: [Static full-text search core](../../architecture/fulltext-search.md).
- Deferred by owner: 2026-10-01; detailed palette UX was explicitly postponed while the core was built.

## Goal

Let a reader search the active site's static title/body after committing a query. The owner intends to fetch search data only after query confirmation, rather than treating full-text search as ordinary character-by-character palette filtering. The core engine/build/publish/API is complete; the interaction surface has not been selected.

## Start here

Read IMP-41's implementation map, tested constraints and shared-workspace caution, then inspect `CommandPalette.tsx`, current site metadata/state and the actual diff. The existing localhost:4188 research form is a proof of search performance, not an approved production UX.

Explore how the committed-query flow coexists with the current palette's metadata search, site switching and keyboard shortcuts. Show concrete interface choices for review before settling detailed behavior. Do not assume a new ordinary palette or a particular result-list layout has already been approved.

Once the interaction is agreed, create a site client using `createSiteFullTextSearch(siteMetadata)`, invoke `search(query, { signal, offset, limit })` on commit, and render the returned IDs/paths/routes. Search construction is network-free; empty inputs do not fetch. The current site index can supply titles and reader metadata. Clear/drop the client when leaving a site. Guard against an older response replacing a newer submission (submission ID or cancellation).

## Acceptance criteria to verify after integration

- [ ] Agreed committed-query interaction is implemented, including Enter/button and Japanese IME behavior.
- [ ] Search assets are not fetched while opening the surface or typing; only committed nonblank queries invoke the API.
- [ ] Active-site scope and unavailable search metadata remain clear; ordinary site/command/heading search behavior is preserved or deliberately revised.
- [ ] Loading, zero hits, network/invalid-data failure, retry and result paging work; a superseded query cannot overwrite current results.
- [ ] Result selection uses normal logical routes and renders HTML/Markdown through the existing reader.
- [ ] Browser checks cover the selected UX and network timing; documentation records the final interaction.

This item is not an instruction to deploy externally, add a backend, change infrastructure, or add ranking/snippets to the search format. If a UX requirement needs additional core fields, record that specific change and its capacity impact before expanding IMP-41's settled format.

Suggested prompt: “Proceed with IMP-42. Read IMP-41 and the core contract, explore the committed-query UX with me, then connect the agreed UI to the existing full-text API.”
