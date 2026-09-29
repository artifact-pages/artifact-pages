# Make site purpose understandable before users open it

- Status: Open
- Priority: P2
- Area: Site discovery and site selection

## Problem

People choosing among multiple sites can see each site's name, but a name alone may not explain what the site contains or who it is for. The site picker and site search do not yet show descriptions, making it harder to choose the right site. The configuration and discovery-metadata path is being added under IMP-40; this issue remains open for the reviewed and implemented user-facing hierarchy.

## Evidence and reproduction

1. Open `/` or the command palette's site search in an environment with multiple sites.
2. Compare sites whose names do not make their scope or purpose obvious.
3. The current site rows and search entries do not provide a description to distinguish them.

At the time this issue was filed, the registered-site YAML defined `name`, `repository`, and `sourcePath`; its strict schema did not accept a `description` field.

## Expected outcome

Visitors can understand a site's purpose before opening it. A description is optional, user-facing metadata, distinct from the site's name and technical source details.

## Progress

[IMP-40](../implementation/IMP-40-unified-deployment-config.md) implements the unified config and optional-description path through deployed discovery metadata. Go tests, Action parity, registered-flow and clean-room walkthroughs, all local browser tests, and the Storybook build passed. A Storybook-only concept demonstrates the proposed hierarchy; production site-picker/search placement is awaiting owner review. Keep this issue Open until the hierarchy is reviewed, implemented in the product UI, and its remaining acceptance criteria are verified.

## Acceptance criteria

- [x] The site configuration and published discovery metadata can carry an optional description without weakening strict validation of other fields.
- [ ] The intended UI surfaces and hierarchy for the description are decided and shown in a design or Storybook example before implementation; the site name remains primary.
- [ ] Descriptions help distinguish sites in the relevant selection/search flow, remain readable at narrow widths and with longer text, and do not create empty placeholders when omitted.
- [x] Existing sites without descriptions continue to work, and repository/source-path details are not used as substitute descriptions.
