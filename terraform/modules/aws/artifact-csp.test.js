import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const mainTf = readFileSync(new URL("./main.tf", import.meta.url), "utf8");

const policyStart = mainTf.indexOf(
  'resource "aws_cloudfront_response_headers_policy" "artifact_csp"',
);
assert.notEqual(policyStart, -1, "artifact response headers policy is declared");
const policyEnd = mainTf.indexOf("\nresource ", policyStart + 1);
const policy = mainTf.slice(policyStart, policyEnd === -1 ? undefined : policyEnd);

test("AWS artifact response policy enforces the trusted HTML resource policy", () => {
  assert.match(policy, /content_security_policy\s*\{/);
  assert.match(policy, /override\s*=\s*true/);
  assert.match(policy, /default-src https: data: blob:/);
  assert.match(
    policy,
    /script-src https: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' data: blob:/,
  );
  assert.match(policy, /style-src https: 'unsafe-inline' data: blob:/);
  assert.doesNotMatch(policy, /\bhttp:/i);
  assert.doesNotMatch(policy, /'self'/);
  assert.doesNotMatch(mainTf, /aws_cloudfront_function" "artifact_csp/);
});

test("AWS attaches the policy to artifact and custom error behaviors over HTTPS", () => {
  assert.match(
    mainTf,
    /artifacts\s*=\s*\{\s*path_pattern\s*=\s*"\/_artifacts\/\*"/,
  );
  assert.match(
    mainTf,
    /errors\s*=\s*\{\s*path_pattern\s*=\s*"\/_errors\/\*"/,
  );
  assert.match(
    mainTf,
    /response_headers_policy_id\s*=\s*contains\(\["artifacts",\s*"errors"\],\s*ordered_cache_behavior\.key\)\s*\?\s*aws_cloudfront_response_headers_policy\.artifact_csp\.id\s*:\s*null/,
  );

  const errorResponses = Array.from(
    mainTf.matchAll(/custom_error_response\s*\{([^}]*)\}/g),
    (match) => match[1],
  );
  assert.deepEqual(
    errorResponses.map((response) => response.match(/error_code\s*=\s*(\d+)/)?.[1]).sort(),
    ["403", "404"],
    "both missing-object status codes must remain mapped",
  );
  for (const response of errorResponses) {
    assert.match(response, /response_page_path\s*=\s*"\/_errors\/not-found\.html"/);
  }

  const behaviorStart = mainTf.indexOf('dynamic "ordered_cache_behavior"');
  assert.notEqual(behaviorStart, -1, "ordered cache behavior is declared");
  const behaviorEnd = mainTf.indexOf("\nresource ", behaviorStart + 1);
  const behavior = mainTf.slice(
    behaviorStart,
    behaviorEnd === -1 ? undefined : behaviorEnd,
  );
  assert.match(behavior, /viewer_protocol_policy\s*=\s*"redirect-to-https"/);
});
