# Unregistered preview routes look like registered sites with no previews

- Status: Open
- Priority: P2
- Area: Preview discovery and missing-resource presentation

## Problem

An unregistered site's preview-list route displays an empty preview explanation and links back to that nonexistent site. Normal artifact routes for the same site correctly display `Page not found`. This confuses a missing site with a valid site that has not published previews; storage withdrawal itself is not failing.

## Evidence and reproduction

The owner-authorized Cloudflare smoke on October 1, 2026 registered, published and then unregistered the disposable `release-smoke` site. The deployed catalog afterward contained only `guide`, and authenticated listings showed no smoke artifact/index/preview objects. See [T15](../verification/T15-provider-delivery.md#disposable-cloudflare-site--october-1-2026-jst).

1. Open `/release-smoke/_previews` after unregistering the site and reload normally.
2. Observe `Previews`, `No available previews`, and a `Back to site home` link to `/release-smoke`.
3. Open `/release-smoke/index.html`: it displays `Page not found` and `All sites`.
4. The former raw preview HTML returns a real HTTP 404, not preview content.

These are browser and provider observations, not a confirmed implementation cause. A missing registered site's preview catalog can legitimately mean no previews; the defect is applying that state to an absent registration. This differs from [ISSUE-051](ISSUE-051-empty-preview-entry-control.md), which concerns an empty entry control on a registered site.

## Expected outcome

Unknown/unregistered preview routes use the common missing-page presentation with a usable return to All sites. Valid registered sites with no preview catalog keep their empty state. Registry/network failures must remain distinguishable from confirmed absence.

## Acceptance criteria

- [ ] An absent site's preview list, group and document routes display `Page not found` with an All sites action, without links implying a valid site home.
- [ ] A registered site without previews still shows the intended empty-preview explanation and its valid site-home link.
- [ ] Registry loading/fetch failures do not become a false not-found or empty-preview result.
- [ ] Browser regression tests distinguish unknown-site preview routes from registered-empty routes, including a reload after unregister.
- [ ] Raw preview storage misses still return real HTTP 404s; no edge rewrite, WAF or product identity model is introduced for this presentation fix.
