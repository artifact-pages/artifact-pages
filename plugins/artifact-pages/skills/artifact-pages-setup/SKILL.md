---
name: artifact-pages-setup
description: Prepare an initial Artifact Pages installation for a GitHub organization using the official Cloudflare or AWS modules, CLI, and workflows. Use for platform onboarding, not for publishing an individual artifact to an existing installation.
---

# Artifact Pages initial setup

Read [the setup reference](references/setup.md) before acting. It gives the provider-specific investigation, required human decisions, deterministic generator commands, release/version boundaries, verification and approval gates. If a referenced official guide is unavailable, report it and do not invent inputs or behavior.

Artifact Pages publishes finished Git-managed HTML and Markdown; it does not create or style them. Guide the operator conversationally, asking for information as it becomes needed. Unless the operator says otherwise, start with a new Artifact Pages admin repository; ask whether Terraform belongs there or in an existing infrastructure repository and which directory to use. Inspect only the chosen locations and the specific existing resources relevant to the selected setup; do not inventory the organization or select an existing repository on the operator's behalf. Reuse official Terraform modules, CLI and Actions. Clearly separate observed facts, assumptions and operator decisions; keep existing registrations and resources intact unless the operator directs otherwise. Do not print or record credentials.

The operator must explicitly approve each actual cloud apply, state or permissions change, GitHub setting or secret change, workflow dispatch, or publication after seeing the target and effect. Do not treat installation or a generic setup request as approval. Local generated files, validation, and authorized read-only checks can proceed before approval. Report what was verified, what remains blocked on a human or credentials, and what has not been tested.
