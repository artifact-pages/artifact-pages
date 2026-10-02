# Cloudflare preview recovery and browser policy evidence — October 2, 2026

This is bounded live evidence for [T15](verification/T15-provider-delivery.md) and the parent's [release-proof gates](cloudflare-release-proof-gates.md), not completion of T15 or authorization to publish. The module candidate remains `208abf5eb6a7323e6161b7a798ba401dcf149c9f`; the tested CLI is compiled from clean source `f1ed001bf0a36a382d38c7bb314c6c920b90680a`. No product defect or source change has been established by these checks.

## Disposable preview scope and safety

The owner authorized unique disposable Site publication, interruption, lock recovery, retry and unregister using existing credentials. The local harness lives at `.local/t15-recovery/check.mjs`; it changes only its own random Site. It preserves every current registration, checks planned registry changes against that Site's namespace, rejects preexisting Site prefixes/locks or pending registry cleanup, and compares the existing non-control object bytes, ETags, modification times and expiration metadata before each mutation. Registry bytes are checked against the expected current registration state; its modification time necessarily changes during registration/unregistration. Origin guard requests require identity encoding, and retained-experiment ETags must equal the original strong values. A final comparison checks the full original non-control inventory and registry bytes. Free lock records under `_control/` may remain under the accepted lock contract.

The baseline contains registrations `guide` and `release-smoke` and 206 non-control objects. The seven objects in the separately owned `.local/cloudflare-release-smoke.LxCbo4` natural-expiration experiment were guarded and never modified. No Guide/app publication, Terraform apply, WAF change, credentials creation, tag, push or Terraform Registry publication/account operation is part of this test.

Two stopped harness attempts are retained as failures, not counted as recovery proof. `t15-recovery-4ce30539` stopped before registration because Node's default response compression weakened the ETag representation; a native read-only HEAD confirmed the original object metadata, then the harness required identity encoding. `t15-recovery-0a92e3cc` registered but stopped at preview dry-run because the harness omitted the mandatory `--base-url`; unregister and full guards passed. The corrected URL matches the configured `https://artifact-pages.dev` and was independently reviewed before rerunning.

Local deterministic recovery tests also passed under Go's race detector: distinct-group serialization, failure/retry, mutable catalog retry, concurrent-group isolation and rejection after lock loss. Log: `.local/imp38-cloudflare/recovery-local.log`. These tests supplement, and do not substitute for, the live run.

## Actual live preview results

The corrected run used disposable Site `t15-recovery-53779153` from `2026-10-02T10:39:01.689Z` through `2026-10-02T10:42:48.153Z`. Its final `result`, `cleanup` and `guards` were all `passed`; the harness exited 0.

| Check | Actual observation |
| --- | --- |
| Concurrent distinct new heads | Two CLI processes launched together; both returned `published`, exit 0. The catalog retained both groups. |
| Interrupted partial upload | Paused after one file object and before the manifest, then SIGKILL. The partial head was absent from the catalog. The lock remained held; recovery with its observed ETag and retry succeeded. |
| Lost lock ownership | Paused after two file objects, recovered that lock while the old process remained paused, then resumed it. The stale process exited 1 with `changed before catalog replacement: deployment object condition did not match`; its head was absent from the catalog. A subsequent retry succeeded. |
| Catalog completeness | Every advertised manifest matched the Site/head and every listed file existed with its SHA-256. The final catalog retained all four heads. |
| Unregister cleanup | CLI unregister succeeded; the disposable `_previews/`, `_indexes/` and `_artifacts/` Site prefixes were empty. |
| Preservation | Final original 206-object non-control inventory matched; all original non-registry bytes, ETags, modification times and expiration metadata matched; registry bytes exactly matched the baseline. |

Exact heads: race A `86161b86c6f8c3b65123378f16f30eaac1e0cd01`, race B `960bb5b21f4fa151a2127b702afbfe0c83710e09`, interrupted `e2659848fb6dc05bfaae3faabc0fbda6f29e2c0f`, lost-owner `1981635b9d248f9b999af1d6948b5f426cd7d0b4`. The synthetic satellite repository was local and never pushed. Evidence is retained at `.local/t15-recovery/run-baseurl.log` and `.local/t15-recovery/t15-recovery-53779153/`, including `proof.json`, baseline guards and individual CLI JSON results. This establishes the named Cloudflare/R2 race and recovery scenarios, not every interruption point or provider.

Independent reviewer `review_registry_package` checked the harness safeguards before live runs and independently verified the final result, CLI outputs, catalog assertions, content-hash assertions and preservation/cleanup guards. Its two final prose corrections concerning ETag checks and Terraform Registry scope were applied. HTTP/CSP and WAF claim boundaries were independently reviewed as well.

## Browser HTTP refusal

At `2026-10-02T10:35:43.726Z`, a separate headless Chromium browser received HTTP 200 for `https://artifact-pages.dev/_artifacts/guide/ja/what-is-git-artifact-pages.html` with enforced CSP. Browser evaluation constructed `http://example.com/t15-runtime-insecure-probe` at runtime and attempted `fetch`, so source HTML rewriting could not convert the test URL. The browser emitted a `SecurityPolicyViolationEvent` with that exact blocked URI, `effectiveDirective: connect-src`, `disposition: enforce`, and the delivered original policy. The fetch rejected with `TypeError: Failed to fetch`; the browser console explicitly attributed refusal to CSP.

The delivered policy's `default-src https://artifact-pages.dev/_artifacts/guide/ https: data: blob:` supplies the fallback for `connect-src`. This establishes refusal of this runtime HTTP fetch in this Chromium/raw Guide page. It does not establish all resource types, routes, browsers, WAF denial or packet-level absence of outbound traffic. The captured request-event array alone is not network proof. No source, uploaded object or policy was edited. Local procedure and evidence: `.local/t15-recovery/http-negative.mjs` and `http-negative.json`.

## Current optional WAF observations

Read-only Rulesets API inspection found the current `http_request_firewall_custom` entrypoint at version 1 with one enabled `block` rule, ref `artifact-pages-waf-presets`. Its expression scopes the selected hostname and combines `not ssl or cf.edge.server_port ne 443` with the IP-allowlist violation predicate. Operator IP values remain private in the mode-0600 local API evidence.

At `2026-10-02T10:39:15Z`, requests from the existing egress to the same raw Guide path returned:

| Connection | Result | Cloudflare Ray |
| --- | --- | --- |
| HTTPS, port 443 | 200 | `a443150a7c4514a3-KIX` |
| HTTP, port 80 | 403 | `a443150aadfd2b2f-KIX` |
| HTTPS, port 8443 | 403 | `a443150b0ede2b2f-KIX` |

No redirects were followed. These are observed edge responses consistent with the active preset; status and response headers do not independently identify the individual blocking rule. A read-only GraphQL firewall-events query was rejected because the existing token lacks `zone.analytics.read`. No new token or permission change was attempted. The nonallowlisted-IP branch remains untested because no separately authorized alternate egress was available. Rollout/rollback behavior was not exercised because this procedure made no policy changes. Raw response evidence is `.local/t15-recovery/waf-requests.json`; the failed attribution query is `waf-events.json`. The private Rulesets response must not be published.

## Remaining boundaries

Natural lifecycle disappearance remains with its separate observer. OIDC, retained-history deletion, universal delivery/WAF enforcement and module publication are not established by this record. The parent's matrix remains the source of release-scope decisions.
