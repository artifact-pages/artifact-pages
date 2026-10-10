# IMP-74 — Align AWS OIDC subject examples with the ID-qualified `sub`

- Status: Open
- Lanes: Terraform / AWS
- Owner: Codex (terraform)
- Depends on: [TD18](../technical-design/TD18-admin-provided-site-workflows.md) (finding)
- Blocks: —

## Goal

The organization's actual GitHub OIDC `sub` is `repo:<owner>@<owner-id>/<repo>@<repo-id>:ref:...` when no `sub` customization is set. The AWS module examples, documentation and tests use `repo:owner/repo:ref:...`, so an exact-match trust subject copied from them would not match in a real deployment.

## Scope

- Align the examples, module README and verification subjects with the observed form.
- Decide whether the module accepts both forms (for example through a list of allowed subjects) or only documents the observed one, and record the decision here.
- Check the `satellite_role_arns` output against the `aws-roles.json` shape IMP-73 consumes; adjust the output only if the map keyed by site ID does not suffice.
- Do not decide `job_workflow_ref` hardening (customizing `sub` so only the admin's official workflow can assume roles); note it as an option only.

## Acceptance criteria

- [ ] No example or test in the module uses a subject form that real GitHub OIDC tokens do not carry, or the module documents when each form applies.
- [ ] The module documentation states how to find the owner and repository IDs.
- [ ] The decision on accepting both forms is recorded in this item.
