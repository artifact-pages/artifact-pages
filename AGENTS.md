# Agent guidance

Read these before making architectural changes:

1. docs/thesis.md
2. docs/specification.md
3. docs/roadmap.md

## Current phase

Phases 1 and 2 (local product and local production projection builder) are in place. Work now spans **Phase 3, provider-backed deployments**, and **Phase 4, reusable distribution**, as laid out in `docs/roadmap.md`. Cloudflare (R2 and Cache) is the first provider and has live evidence; AWS is independently gated and `gcp-local` stays emulator-only. `docs/backlog/release-readiness.md` records the release execution order and what has shipped.

Shipped and in scope, per their tickets and technical designs:

- the `artifact-pages` CLI with prebuilt binaries attached to pre-releases (v0.x; no cross-version compatibility promise before 1.0.0, see TD2)
- thin composite GitHub Actions under `actions/` and caller-owned workflow examples (TD4)
- Terraform reference modules for Cloudflare and AWS
- release and CI workflows (`.github/workflows/`, the compatibility gate and release scripts)
- operator repositories ([`artifact-pages/admin`](https://github.com/artifact-pages/admin), [`artifact-pages/docs`](https://github.com/artifact-pages/docs)) and a verification environment on `artifact-pages.stream` (TD5)

Still require explicit owner approval: tagging or publishing a release, Terraform Registry or Marketplace publication, real-account apply, and anything that spends or mutates production. Do not add a general-purpose CLI surface, a new provider, or a backend service unless the roadmap, a technical design, or the owner asks for it. A listed later-phase ticket does not authorize implementing it on its own.

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
- Claim an item before working on it: add `- Assignee: <who>` right below `- Status:` (`Claude`, `Codex`, or `Owner`). One assignee per item. Set it when the item moves to `In progress`; keep it on `Done` as a record of who finished it; remove it if you drop the item. Two coding agents work in this repository, so check the field before starting and do not take an item someone else holds.
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

# Who holds what (items with an assignee that are not finished)
for f in $(grep -rl '^- Assignee:' --include='*.md' --exclude=_template.md docs/backlog); do
  st=$(grep -m1 '^- Status:' "$f" | sed 's/^- Status: //')
  case "$st" in Done|"Won't fix") continue;; esac
  printf '%-10s %-12s %s\n' "$(grep -m1 '^- Assignee:' "$f" | sed 's/^- Assignee: //')" "$st" "${f#docs/backlog/}"
done | sort
~~~

## Current implementation direction

- Vite + React + TypeScript SPA, served as a static application with no backend service
- nginx behind Docker Compose remains the local analogue of the CDN routing; the Cloudflare and AWS deployments serve the same projection from object storage
- committed fixtures model the object-storage projection; generated local output belongs under .local/ and stays untracked
- the Go CLI and the composite Actions publish through a provider-neutral publisher/storage contract; provider credentials, storage, locking and cache calls stay inside each adapter
- artifacts are rendered in an iframe rather than injected into the SPA DOM
- the SPA consumes per-site index metadata (`/_indexes/*`); local discovery may use the nginx directory listing for `/_indexes/`

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
