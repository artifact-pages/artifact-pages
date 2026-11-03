# AI-assisted initial setup

Artifact Pages publishes finished HTML and Markdown; AI can help create those artifacts and prepare the shared infrastructure. You can use the [setup skill and its reference](../../plugins/artifact-pages/skills/artifact-pages-setup/SKILL.md) with a compatible agent, or ask any agent to read the [standalone setup reference](../../plugins/artifact-pages/skills/artifact-pages-setup/references/setup.md) and help you prepare an installation.

After this marketplace is published, register `artifact-pages/artifact-pages` as a marketplace and install `artifact-pages@artifact-pages` in Claude Code or Codex. The commands below were validated against a local marketplace; the GitHub route itself is not yet published or tested:

```sh
# Claude Code
claude plugin marketplace add artifact-pages/artifact-pages
claude plugin install artifact-pages@artifact-pages

# Codex
codex plugin marketplace add artifact-pages/artifact-pages
codex plugin add artifact-pages@artifact-pages
```

Then ask the agent to use the `artifact-pages-setup` skill to prepare an installation. It guides you through the setup conversationally, assumes a new admin repository unless you choose otherwise, and asks whether Terraform belongs there or in an existing infrastructure repository. It inspects only the locations and resources needed for the chosen setup. Plugin and skill versions evolve independently of the CLI, web, Actions and Terraform module versions. Check the [decision record](../research/ai-assisted-setup.md) for current validation and limitations. The [complete public setup guide](https://artifact-pages.dev/ja/02-setup/index.html) remains available for manual installation.
