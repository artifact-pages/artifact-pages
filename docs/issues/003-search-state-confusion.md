# Independent searches leave contradictory result states

- Status: Open
- Priority: P1
- Area: Site search and artifact navigation

## Problem

The sidebar filter, site-home search, and command palette search maintain separate queries without explaining their scope. A user can see zero results in the sidebar while the main pane shows a match. Opening that match leaves the sidebar filtered to zero results, so the current artifact is absent from navigation.

## Evidence and reproduction

1. Open `/sre` and enter `latency` in “Filter this site.” The sidebar shows two matches.
2. Enter `topology` in the main “Search SRE” field. The main pane shows one match while the sidebar still shows the latency matches.
3. Set the sidebar query to a nonmatching value and open an artifact from the main search or command palette. The artifact opens, but the sidebar remains at zero matches.

## Expected outcome

The user can tell which content each search controls and can still locate the current artifact after navigation.

## Acceptance criteria

- [ ] The sidebar filter and broader search controls communicate their distinct scopes, or use one shared query state.
- [ ] Opening an artifact from any search path does not leave its current location hidden behind a zero-result sidebar state.
- [ ] Clearing a query restores the expected browse state without affecting unrelated navigation unexpectedly.
