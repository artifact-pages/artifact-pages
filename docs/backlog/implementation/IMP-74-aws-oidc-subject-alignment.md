# IMP-74 — Align AWS OIDC subject examples with the ID-qualified `sub`

- Status: Open
- Lanes: Terraform / AWS
- Owner: Codex (terraform)
- Depends on: [TD18](../technical-design/TD18-admin-provided-site-workflows.md) (finding)
- Blocks: —

## Goal

The organization's actual GitHub OIDC `sub` is `repo:<owner>@<owner-id>/<repo>@<repo-id>:ref:...` when the repository OIDC setting `use_immutable_subject` is true (the observed `sub_claim_prefix` of `artifact-pages/admin`); the form therefore depends on that setting. The AWS module examples, documentation and tests use `repo:owner/repo:ref:...`, so an exact-match trust subject copied from them would not match in a real deployment.

## Scope

- Align the examples, module README and verification subjects with the observed form.
- Decide whether the module accepts both forms (for example through a list of allowed subjects) or only documents the observed one, and record the decision here.
- Record the decision on accepted forms in the AWS module README and specification §17, with a pointer from this item.
- Do not decide `job_workflow_ref` hardening (customizing `sub` so only the admin's official workflow can assume roles); note it as an option only.

## Acceptance criteria

- [ ] Examples, tests and README use or explain the ID-qualified form; if both forms are accepted, a test covers each.
- [ ] The documentation describes both forms and how to read the exact prefix with `gh api repos/OWNER/REPO/actions/oidc/customization/sub` (`sub_claim_prefix`).
- [ ] The accepted-forms decision is recorded in the module README and specification §17.
