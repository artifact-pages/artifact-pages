# First-reader documents describe an outdated state

- Status: Done
- Assignee: Claude
- Priority: P2
- Area: Repository docs
- Implementer: Claude
- Source: public-launch review 2026-10-13, section 7 (last paragraphs)

## Problem

A first reader can pick an outdated procedure or version from three places. These documents do not show unfinished work; they show old state.

## Evidence and reproduction

1. `README.md:28-30` says "Phase 1 local product" and that AWS infrastructure and published reusable distribution packages "come later", while the CLI, web bundle and Actions are released pre-releases and Cloudflare is deployed.
2. `docs/backlog/release-readiness.md` still describes the earlier personal repository, bundled versions, private operator repositories and unpublished candidates (it is dated 2026-10-05).
3. `docs/backlog/documentation/` is a copy made before the operator repositories were transferred; the live documentation backlog is now in the `artifact-pages/docs` repository and no longer matches this copy.

## Expected outcome

A first reader finds the current state in one place, and old records are visibly historical.

## Acceptance criteria

- [x] `README.md` describes the current state (released components, Cloudflare first, AWS gated, GCP emulator-only, Windows unsupported) and points to the published guide.
- [x] `release-readiness.md` is updated to the current state or clearly marked historical with a pointer to the current source.
- [x] The documentation track states that the live backlog is in the `artifact-pages/docs` repository and marks the local copy historical or removes it.

## Resolution

- `README.md`: the Status section now states the pre-release state, released components, Cloudflare first, AWS gated, GCP emulator-only, Windows unsupported, and links the published guide and the Cloudflare deployment guide.
- `docs/backlog/release-readiness.md`: marked as a historical record with pointers to GitHub Releases and the public launch order.
- `docs/backlog/documentation/`: the README and every DOC file are marked as historical copies pointing to the live backlog in `artifact-pages/docs`.
