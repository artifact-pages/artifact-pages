# Agent guidance

Read these before making architectural changes:

1. docs/thesis.md
2. docs/specification.md
3. docs/roadmap.md

## Current phase

The repository is in **Phase 1: local product**.

Do not implement AWS infrastructure, Terraform, GitHub Actions publishing, or a general-purpose CLI unless explicitly requested. First prove the browser product and local serving contract.

## Backlog and issue tracking

Unfinished work lives in `docs/backlog/`, one item per Markdown file, split into tracks with different definitions of `Done`:

| Track | Holds | Index |
| --- | --- | --- |
| `issues/` | Independently actionable product problems with evidence and acceptance criteria. | `issues/README.md` (also defines P0–P3); new items from `issues/_template.md` |
| `implementation/` | Independently reviewable implementation slices. | `implementation/README.md` |
| `technical-design/` | Decisions about how to fulfil an accepted contract. | The `TD*` files |
| `verification/` | Tests or measurements that prove an accepted contract. | The `T*` files |
| `documentation/` | Public reader-facing documentation pages, one per ticket, reviewed one at a time. | `documentation/README.md` |

`docs/backlog/delegation.md` records work modes and owner boundaries; `docs/backlog/release-readiness.md` records the release execution order.

| Status | Meaning | Completion rule |
| --- | --- | --- |
| `Open` | Not yet started. | — |
| `In progress` | Actively being worked on. | — |
| `Blocked` | Cannot proceed without a decision, dependency, or external change. | Record the blocker in the item. |
| `Done` | Outcome established. | Issue or implementation: acceptance criteria verified. Technical design: settled contract recorded. Verification: actual results or measurements linked. |
| `Deferred` | Deliberately postponed. | Design, implementation and verification only; record when to revisit. |
| `Won't fix` | The problem will not be pursued. | Issues only; record why. |

- An item's own file is the source of truth for its status; keep its track index in sync when status or priority changes.
- Keep one independently finishable problem, slice, decision, or proof per file. Do not turn design or verification work into issues.
- Priorities `P0`–`P3` apply to issues only.
- Accepted product behavior belongs in `docs/specification.md`, not in a backlog item.

Derive counts and the active list from the items instead of maintaining them by hand:

~~~sh
# Status counts per track
for t in issues implementation technical-design verification documentation; do
  printf '%-17s' "$t"
  grep -rh -m1 '^- Status:' --include='*.md' --exclude=_template.md "docs/backlog/$t" |
    sed 's/^- Status: //' | sort | uniq -c | awk '{n=$1; $1=""; printf "%s %s · ", substr($0,2), n}'
  echo
done

# Every item that is not finished
grep -rH -m1 '^- Status:' --include='*.md' --exclude=_template.md docs/backlog |
  grep -vE "Status: (Done|Won't fix)$" | sed 's|^docs/backlog/||; s|:- Status: | — |' | sort
~~~

## Current implementation direction

- Vite + React + TypeScript
- nginx behind Docker Compose as the local analogue of CloudFront routing
- committed fixtures model the future object-storage projection
- generated local output, when introduced, belongs under .local/ and stays untracked
- artifacts should be rendered in an iframe rather than injected into the SPA DOM
- the SPA should consume per-site index metadata; local discovery may use the nginx directory listing for `/_indexes/`

## Product boundaries

The stable application plane is:

~~~text
/index.html
/assets/*
~~~

The changing content plane is:

~~~text
/_indexes/*
/_artifacts/*
~~~

Logical user routes are:

~~~text
/
/:site
/:site/*
~~~

Do not expose storage paths as the primary user-facing navigation model.

## Keep abstractions honest

Avoid introducing backend services for functionality that can remain static. Avoid coupling the core product contract to AWS-specific APIs. Avoid making repository identity part of the public site URL unless the product specification explicitly requires it.

Prefer a small implementation that demonstrates the thesis over speculative framework code for future distribution.
