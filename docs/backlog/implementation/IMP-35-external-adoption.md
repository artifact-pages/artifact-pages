# IMP-35 — External-repository adoption and release readiness

- Status: Open
- Phase: Reusable distribution
- Depends on: [IMP-28](IMP-28-local-operator-flow.md), [IMP-30](IMP-30-aws-deployment-module.md), [IMP-31](IMP-31-app-distribution.md), [IMP-34](IMP-34-actions.md)
- Proves: clean-room adoption checklist and provider smoke evidence

## Outcome

Prove that an organization can adopt released components using its own admin and site repositories, rather than cloning this OSS repository as an application workspace.

## Acceptance criteria

- A clean-room walkthrough covers config selection, registry review/apply, app deploy, explicit site publish, update and unregister, with local and AWS evidence; Cloudflare parity is tracked separately by [IMP-33](IMP-33-cloudflare-deployment.md).
- Document roles, Git/HTML trust model, checksum verification, version compatibility, upgrade/rollback and failure recovery.
- Choose and record an OSS license and release/versioning policy before claiming a public release; do not mark Done on documentation alone without the walkthrough.
