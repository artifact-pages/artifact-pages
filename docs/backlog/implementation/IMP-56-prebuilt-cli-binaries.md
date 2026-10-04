# IMP-56 — Prebuilt CLI binaries for the composite Actions

- Status: In progress
- Lanes: CLI / release, Actions
- Execution: Agent-led. Creating the release and tag stays an owner step (TD2).
- Depends on: [IMP-45](IMP-45-unified-release-and-compatibility.md), [IMP-46](IMP-46-action-marketplace-release.md) slice 3
- Related design: [TD4](../technical-design/TD4-action-marketplace-distribution.md) (amended 2026-10-05), [TD2](../technical-design/TD2-component-release-policy.md)

## Goal

An adopter pinned to a release tag skips setup-go and `go build` on every run. A SHA or branch pin, a missing asset or an unsupported platform still builds from the pinned source.

## Slices

1. `scripts/package-cli-release.mjs` builds the binaries (linux and darwin, amd64 and arm64, `CGO_ENABLED=0 -trimpath`), a sha256 checksums file and the Go dependency notices; the release workflow attaches them and its published-release verification re-checks them.
2. `actions/shared/prebuilt-cli.mjs` selects, downloads and verifies the binary. Every Action runs it after checkout (preview: after the trust preflight) and skips the Go steps when it installed a binary.

## Acceptance criteria

- [x] Selection uses a binary only for a release-tag ref equal to the source version on a supported platform; SHA, branch, `uses: ./`, version mismatch and Windows fall back (`actions/shared/prebuilt-cli.test.mjs`).
- [x] A checksum mismatch fails and installs nothing; a missing asset or checksum entry falls back; the token is used only for the rate-limit retry through the API and never printed (same test).
- [x] The packaging script builds all four platforms, writes checksums, and the notices cover the linked Go modules and fail on a missing license (`scripts/package-cli-release.test.mjs`; a local run produced four binaries, the checksums file and a notices file, and the darwin/arm64 binary reported the product version).
- [x] Every Action's wiring is checked: ref and repository inputs, workflow token, four Go steps conditional, download before Go setup and after the preview preflight (`scripts/test-actions-parity.mjs`).
- [x] The specification "Shared Action behavior", TD4 and TD2 describe the behavior.
- [ ] A release created by the owner's tag push attaches the binaries, checksums and notices, and its published-release verification passes (not run: no release or tag was created).
- [ ] A workflow on a GitHub-hosted runner using the release tag logs "using the released binary" and publishes successfully, and a SHA-pinned run logs a source build (not run).
