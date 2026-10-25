# Published AWS module retains retired invalidation permissions and TTL caps

- Status: Open
- Priority: P2
- Area: Terraform module distribution / AWS cache policy and IAM

## Problem

The published AWS module has not adopted the monorepo's IMP-82 no-invalidation contract. Consumers still receive unnecessary CloudFront invalidation permissions and index/artifact cache policies capped at 60/300 seconds rather than the CLI-owned policy. These ceilings can shorten the freshness of immutable objects; they do not establish a stale-content failure.

## Evidence and reproduction

Read-only comparison on 2026-10-26:

1. Workspace `terraform-aws-artifact-pages/` origin/main is
   `dd0fcded012f8d73187ae2c616b0071bc1aaeae9`:
   `main.tf:120–123`, `:311–312`, `:336–337` retain the admin
   invalidation grant and 60/300-second policies.
2. GitHub main is newer, `40b0ed7f7f4462005993b4ee9197ff54309a9a75`
   (generated v0.1.1), but still grants `cloudfront:CreateInvalidation`
   to admin and satellite roles (`main.tf:119`, `:649`) and caps
   indexes/artifacts at 60/300 seconds (`:320–321`, `:345–346`).
3. Monorepo origin/main `685f7b1b9092f0b6fc46be1efa71d9bb7de3db1c`
   uses an origin-respecting policy (0/0/31536000), removes those
   grants, and documents the compatible no-invalidation CLI requirement
   in `terraform/modules/aws/README.md`.
4. Cloudflare is not a confirmed outstanding distribution defect:
   local origin/main `6fcd1de5` lacks the 4xx no-store override and
   retains README purge-propagation wording, but public main and
   v0.2.0 resolve to `b75940ad949656fec34013edf97d32cd9521c9f0`.
   Its release.json names monorepo tag terraform-cloudflare/v0.2.0
   at `4acfb9aa27289545a926681e312eef2a45edb115`.
   All 50 source-derived package files match that tag under the
   generator's exclusions and transformations, including both fixes.
   Registry 0.2.0 availability and clean retrieval remain UNVERIFIED.

GitHub state was checked through the connector after gh/git network
access failed. No live AWS behavior, Terraform apply, or Registry
consumer initialization was performed.

## Expected outcome

Registry consumers can select a generated AWS release that implements
IMP-82 and clearly identifies the compatible CLI version and migration
order. Published package contents and provenance match the reviewed
monorepo release source.

This is the distribution follow-up to
[IMP-38](../implementation/IMP-38-terraform-registry-publication.md) and
[IMP-82](../implementation/IMP-82-cli-owned-cache-policy.md).
[IMP-39](../implementation/IMP-39-aws-cloudflare-dns-acm.md) is historical
AWS packaging context; its removed DNS/ACM composition stays closed.
Cloudflare requires publication verification, not a duplicate repair.

## Acceptance criteria

- [ ] A reviewed generated AWS candidate removes admin/satellite
  CreateInvalidation and honors CLI Cache-Control with the common
  0/0/31536000 policy, preserving error handling, routing, storage
  scope and OIDC boundaries. Module/package checks pass.
- [ ] Upgrade guidance identifies the exact compatible CLI floor
  (the IMP-82 CLI 0.6 line), writer/module migration order and rollback
  permission requirements; older invalidating writers are not
  presented as compatible.
- [ ] After owner-approved publication, record AWS monorepo tag/SHA,
  generated package tag/SHA and release.json provenance, compare the
  generated payload, and verify exact-version clean Registry retrieval.
- [ ] Record Cloudflare Registry 0.2.0 metadata/download resolution
  and clean retrieval against the verified GitHub tag; retain
  UNVERIFIED explicitly until checked.

Tagging, publication, settings changes and real-account applies require
separate owner approval. Live cache and credential-retirement proof
remain in IMP-82/T30; package parity alone does not establish them.
