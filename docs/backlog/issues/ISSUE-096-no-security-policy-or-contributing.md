# The repository has no security policy, contributing guide or issue templates

- Status: In progress
- Assignee: Claude
- Priority: P2
- Area: OSS project
- Implementer: Claude
- Source: public-launch review 2026-10-13, section 7 item 5

## Problem

A public reader who finds a vulnerability has no private reporting route, no statement of which versions get fixes, and no guidance on contributing or filing issues. The monorepo has no `SECURITY.md`, `CONTRIBUTING.md` or `.github/ISSUE_TEMPLATE/`.

## Evidence and reproduction

1. At `04783fb3` none of `SECURITY.md`, `CONTRIBUTING.md` or `.github/ISSUE_TEMPLATE/` exists in the repository.
2. All releases are `0.x` pre-releases, so a support policy has to say what that means for fixes.

## Expected outcome

The repository tells reporters how to report privately, which versions are fixed, and how to contribute or file an issue.

## Acceptance criteria

- [ ] `SECURITY.md` points to GitHub private vulnerability reporting, states the response expectation, and states which versions receive fixes during the `0.x` pre-releases. Enabling private vulnerability reporting is a repository setting tracked in the workspace ops item OPS-005.
- [x] A minimal `CONTRIBUTING.md` and issue templates (bug report and feature request) exist.
- [x] Every link in the new files resolves.

## Verification

- Created `SECURITY.md`, `CONTRIBUTING.md`, `.github/ISSUE_TEMPLATE/bug_report.yml`, `.github/ISSUE_TEMPLATE/feature_request.yml` and `.github/ISSUE_TEMPLATE/config.yml`; `README.md` links the first two.
- YAML files parse; relative links resolve.
- Blocked on the owner enabling private vulnerability reporting (workspace ops item OPS-005); checked 2026-10-13: disabled. Mark Done after the advisories/new link opens the form.
