# IMP-74 — Align AWS OIDC subject examples with the ID-qualified `sub`

- Status: Done
- Assignee: Codex
- Lanes: Terraform / AWS
- Owner: Codex (terraform)
- Depends on: [TD18](../technical-design/TD18-admin-provided-site-workflows.md) (finding)
- Blocks: —

## Goal

The organization's actual GitHub OIDC `sub` is `repo:<owner>@<owner-id>/<repo>@<repo-id>:ref:...` when the repository OIDC setting `use_immutable_subject` is true (the observed `sub_claim_prefix` of `artifact-pages/admin`); the form therefore depends on that setting. The AWS module examples, documentation and tests use `repo:owner/repo:ref:...`, so an exact-match trust subject copied from them would not match in a real deployment.

## Scope

- Align the examples, module README and verification subjects with the observed form.
- Accept either form only when its exact subject string is explicitly supplied in the existing allowlist inputs. A caller that supplies both entries permits both exact subjects; the module does not add a wildcard or infer the alternate form. The IAM policy continues to use `StringEquals` for both audience and subject.
- Record the decision on accepted forms in the AWS module README and specification §17, with a pointer from this item.
- Do not decide `job_workflow_ref` hardening (customizing `sub` so only the admin's official workflow can assume roles); note it as an option only.

## Acceptance criteria

- [x] Examples, tests and README use or explain the ID-qualified form; an offline Terraform plan test checks legacy and immutable exact subjects in both admin and satellite trust policies.
- [x] The documentation describes both forms and how to read `sub_claim_prefix` with `gh api repos/OWNER/REPO/actions/oidc/customization/sub`, and explains that custom templates require checking the emitted `sub`.
- [x] The accepted-forms decision is recorded in the module README and specification §17.

## Evidence

- Read-only GitHub API responses for `artifact-pages/admin` and `artifact-pages/docs` both reported `use_default = true` and `use_immutable_subject = true`; their `sub_claim_prefix` values are recorded in the [AWS verification caller README](../../../terraform/deployments/aws/README.md#github-oidc-subjects). The caller appends its `:environment:aws-verify` context.
- `terraform/modules/aws/oidc-subjects.tftest.hcl` evaluates the module's IAM policy-document data sources and asserts the unchanged `StringEquals` audience plus exact legacy and immutable subject sets for admin and satellite roles.
- `terraform/deployments/aws/tests/verification.tftest.hcl` supplies the two observed immutable subjects while planning the mocked AWS verification caller.
- Focused checks passed: Terraform 1.9.8 module OIDC test (1 passed), Terraform 1.16.4 AWS caller test (1 passed), and `git diff --check`.
