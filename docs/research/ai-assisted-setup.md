# AI-assisted setup: decision and local evaluation

## Problem and boundary

The official Japanese setup runs from provider infrastructure through admin workflows, app deployment, registration, first publish and optional PR previews. For an experienced platform engineer, Terraform apply is only one operation. The harder work is choosing access and ownership boundaries, matching provider output to the deployment config, arranging credentials and exact OIDC subjects, connecting independently versioned CLI/web/Actions/modules, and coordinating the admin and team repositories. Existing-resource ownership, especially Cloudflare zone-wide rulesets, is a material migration risk.

| Work | Existing automation | Remaining human or agent work |
| --- | --- | --- |
| Infrastructure | Versioned provider Terraform modules and outputs | Inspect ownership/state, choose access and cost constraints; operator reviews and approves plan/apply |
| Admin configuration | Terraform emits provider config | Assemble pins and complete desired sites; choose secrets and environment policy |
| Shared workflows | `registry setup` generates four local files with bundled pins and checks drift | Select running CLI, review output and arrange GitHub settings; generator does not create app deploy or team callers |
| App, registry, first site | CLI, Actions and dry-runs | Review complete desired registry, credentials, app workflow and caller wiring; approve actual writes and verify reader access |
| Preview | Generated shared workflow and CLI/Action | Configure caller and same-repository trust; approve external operations |

The operator must decide audience, trusted publishers and identity policy. Dry-runs can require real credentials and read existing provider state. An agent can inventory, explain and prepare changes, but cannot infer authorization or replace these decisions.

## Options

| Option | User burden and implementation | Safety, repeatability and maintenance |
| --- | --- | --- |
| Agent-neutral guide plus existing CLI and modules | One URL/prompt; modest documentation; operator still supplies decisions | Same deterministic generators and modules; explicit gates; guide must track released behavior |
| Product-specific agent plugin or skill | Potentially easier discovery in one agent; adds packaging and distribution | Additional versioning and platform coupling; no evidence yet that a wrapper improves outcomes |
| New setup CLI | Potentially fewer manual steps; substantial design and implementation | Duplicates orchestration and environment decisions, expands CLI contract; may hide permissions and changes |
| New templates alone | Easy to copy for one scenario | Risk of drift and overwriting existing installations; the CLI already generates shared workflows |

Owner decision 2026-10-31: provide a shared Agent Skills-format setup skill and first-class Claude Code and Codex entry points, plus an agent-neutral documentation path for users who do not install a plugin. The skill packages one shared setup reference and calls the existing modules and CLI; each plugin format supplies only its own metadata. Keep daily team publishing separate, while sharing existing workflows and trust rules. Plugin version 0.1.0 is a local candidate, not a published release. Verify how each distribution channel handles version selection and updates before release.

## Interaction and repository boundaries (owner, 2026-11-01)

Proceed conversationally, asking for inputs as they become necessary. A new admin repository is the default, but the operator chooses whether Terraform is maintained there or in an existing infrastructure repository and specifies the target directory. Inspect only chosen locations and the particular shared resources needed for the selected setup. Ask about existing ownership before investigating; never assume an empty registry or alter existing state or unrelated infrastructure. The agent accompanies the operator through the official steps rather than performing an organization-wide discovery by default.

## Evaluation

A local simulation built the current source CLI and ran `registry setup` and `registry setup --check` with the Cloudflare example in a disposable directory. The original example's account/zone placeholders were rejected by config validation; replacing them with syntactically valid fictitious IDs produced four files and the check passed. This demonstrates local generation and validation, not real provider access or deployment. Existing `registrysetup` and CLI command tests passed. No independent first-time agent session, AWS simulation, Terraform plan/apply, GitHub settings, browser check or real cloud operation was performed. Thus reduced orientation and handoff effort is a hypothesis; there is no measured reduction in decisions or elapsed time. The operator still makes the same security and ownership decisions.

Claude Code local marketplace registration and plugin installation succeeded with an isolated CLAUDE_CONFIG_DIR; the installed package contained the skill and reference. Claude manifest and marketplace validation passed. Codex local marketplace registration and plugin installation also succeeded; the installed package contained the reference. The temporary Codex plugin and marketplace were removed after the check. Actual invocation by a fresh agent is not yet verified. Next validate both entry points with clean-room agent sessions and isolated provider fixtures, measure completion and incorrect assumptions, then test an approved disposable cloud setup. Public documentation can introduce AI-generated, finished artifacts more prominently after reader-facing review; AI should remain an example of how artifacts are produced, not a requirement for using the product.
