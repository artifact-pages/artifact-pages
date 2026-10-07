import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// Pure console evaluation: no plan, provider configuration, refresh or AWS calls.
// Run after backend-free init; TERRAFORM_BIN selects floor/current binaries.
const root = fileURLToPath(new URL('..', import.meta.url))
const terraform = process.env.TERRAFORM_BIN || 'terraform'
const base = {
  aws_region: 'us-west-2', preview_retention_days: 1,
  github_oidc_provider_arn: 'arn:aws:iam::000000000000:oidc-provider/token.actions.githubusercontent.com',
  admin_github_subjects: ['repo:test/admin:ref:refs/heads/main'],
}
const arn = (kind) => `arn:aws:wafv2:us-east-1:000000000000:global/${kind}/example/00000000-0000-0000-0000-000000000000`
const geo = { geo_match_statement: { country_codes: ['JP'] } }
const transform = [{ priority: 0, type: 'NONE' }]
const match = { field_to_match: { uri_path: {} }, text_transformation: transform }
const rule = (statement = geo, action = { count: {} }) => ({ name: 'example', priority: 1, statement, action })
const policy = (r = rule()) => ({ rules: [r] })
function evaluate(waf, expression = 'jsonencode({ errors = local.waf_errors, enabled = local.waf_enabled, ready = local.waf_ready, cidrs = local.waf_family_cidrs })', extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'artifact-pages-waf-console-'))
  try {
    const vars = join(dir, 'test.tfvars.json')
    writeFileSync(vars, JSON.stringify({ ...base, waf_custom_rules: waf, ...extra }))
    const result = spawnSync(terraform, ['console', '-no-color', `-state=${join(dir, 'terraform.tfstate')}`, `-var-file=${vars}`], {
      cwd: root, input: `${expression}\n`, encoding: 'utf8', timeout: 30000,
      env: { ...process.env, AWS_EC2_METADATA_DISABLED: 'true' },
    })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.equal(result.stderr.trim(), '', result.stderr)
    return JSON.parse(JSON.parse(result.stdout.trim()))
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
function valid(name, waf) {
  test(name, () => { assert.deepEqual(evaluate(waf).errors, []) })
}
function invalid(name, waf, diagnostic, extra = {}) {
  test(name, () => {
    const result = evaluate(waf, undefined, extra)
    assert.ok(result.errors.some((error) => error.includes(diagnostic)), JSON.stringify(result))
    assert.equal(result.ready, false)
    assert.equal(result.enabled, true, 'invalid input must not silently disable the resource ownership mode')
  })
}
test('null policy preserves disabled mode and creates no CIDRs', () => {
  assert.deepEqual(evaluate(null), { errors: [], enabled: false, ready: false, cidrs: { IPV4: [], IPV6: [] } })
})
valid('preset-only IPv4 and IPv6 policy', { presets: { ip_allowlist: ['192.0.2.10/32', '2001:db8::/128'] } })
test('CIDRs canonicalize host bits and IPv6 spellings per family', () => {
  assert.deepEqual(evaluate({ presets: { ip_allowlist: ['192.0.2.123/24', '2001:0DB8:0000:0000:0000:0000:0000:0001/64'] } }).cidrs,
    { IPV4: ['192.0.2.0/24'], IPV6: ['2001:db8::/64'] })
})
const statements = {
  geo, ip: { ip_set_reference_statement: { arn: arn('ipset') } },
  label: { label_match_statement: { scope: 'LABEL', key: 'awswaf:example:label' } },
  byte: { byte_match_statement: { ...match, search_string: '/private', positional_constraint: 'STARTS_WITH' } },
  regex: { regex_match_statement: { ...match, regex_string: '^/private' } },
  regexSet: { regex_pattern_set_reference_statement: { ...match, arn: arn('regexpatternset') } },
  size: { size_constraint_statement: { ...match, comparison_operator: 'GT', size: 100 } },
  sqli: { sqli_match_statement: { ...match, sensitivity_level: 'HIGH' } },
  xss: { xss_match_statement: match },
  and: { and_statement: { statement: [geo, { ip_set_reference_statement: { arn: arn('ipset') } }] } },
  or: { or_statement: { statement: [geo, { not_statement: { statement: geo } }] } },
  not: { not_statement: { statement: geo } },
  rate: { rate_based_statement: { aggregate_key_type: 'IP', limit: 2000, evaluation_window_sec: 60, scope_down_statement: { not_statement: { statement: geo } } } },
}
for (const [name, statement] of Object.entries(statements)) valid(`native ${name} statement`, policy(rule(statement)))
for (const field of ['method', 'uri_path', 'query_string', 'all_query_arguments', 'single_header', 'single_query_argument']) {
  valid(`supported field ${field}`, policy(rule({ xss_match_statement: { ...match, field_to_match: { [field]: field.startsWith('single_') ? { name: 'accept' } : {} } } })))
}
const managed = { name: 'group', priority: 1, statement: { managed_rule_group_statement: {
  name: 'AWSManagedRulesCommonRuleSet', vendor_name: 'AWS', scope_down_statement: geo,
  rule_action_override: [{ name: 'SizeRestrictions_QUERYSTRING', action_to_use: { count: {} } }, { name: 'NoUserAgent_HEADER', action_to_use: { block: { custom_response: { response_code: 403 } } } }],
} }, override_action: { none: {} } }
valid('managed group with heterogeneous overrides and scope down', policy(managed))
valid('caller-owned rule group', policy({ name: 'group', priority: 1, statement: { rule_group_reference_statement: { arn: arn('rulegroup') } }, override_action: { count: {} } }))
valid('explicit default Block with ordinary admission rule', { ...policy(rule(geo, { allow: {} })), default_action: { block: { custom_response: { response_code: 403 } } } })
valid('custom default/rule response body and headers', { ...policy(rule(geo, { block: { custom_response: { response_code: 403, custom_response_body_key: 'denied', response_header: [{ name: 'x-denied', value: 'yes' }] } } })), custom_response_bodies: { denied: { content: 'Denied', content_type: 'TEXT_PLAIN' } } })
invalid('empty policy', {}, 'at least one')
invalid('both ownership modes', policy(), 'mutually exclusive', { web_acl_arn: arn('webacl') })
invalid('HTTPS is not a WAF preset', { presets: { https_only: true } }, 'only ip_allowlist')
invalid('empty IP list', { presets: { ip_allowlist: [] } }, 'non-empty CIDR')
invalid('malformed IP', { presets: { ip_allowlist: ['not-a-cidr'] } }, 'malformed CIDR')
invalid('IP /0', { presets: { ip_allowlist: ['0.0.0.0/0'] } }, '/0')
invalid('duplicate canonical IPv4', { presets: { ip_allowlist: ['192.0.2.1/24', '192.0.2.2/24'] } }, 'duplicate canonical')
invalid('duplicate canonical IPv6', { presets: { ip_allowlist: ['2001:db8::/64', '2001:0DB8::1/64'] } }, 'duplicate canonical')
invalid('rules must be array', { rules: { first: rule() } }, 'expected a list')
invalid('missing rule name', policy({ priority: 1, statement: geo, action: { count: {} } }), 'missing required')
invalid('unknown rule key', policy({ ...rule(), enabled: true }), 'invalid keys')
invalid('reserved rule name', policy({ ...rule(), name: 'artifact-pages-ip-allowlist' }), 'non-reserved')
invalid('priority zero reserved', policy({ ...rule(), priority: 0 }), 'integer 1..')
invalid('priority string rejected', policy({ ...rule(), priority: '1' }), 'integer 1..')
invalid('priority fractional rejected', policy({ ...rule(), priority: 1.5 }), 'integer 1..')
invalid('duplicate rule names', { rules: [rule(), { ...rule(), priority: 2 }] }, 'names must be unique')
invalid('duplicate priorities', { rules: [rule(), { ...rule(), name: 'second' }] }, 'priorities must be unique')
invalid('default Block without admission', { ...policy(), default_action: { block: {} } }, 'requires an Allow')
invalid('unknown statement', policy(rule({ body_match_statement: {} })), 'one supported statement')
invalid('multiple statements in one node', policy(rule({ ...geo, ...statements.ip })), 'one supported statement')
invalid('unknown nested payload key', policy(rule({ geo_match_statement: { country_codes: ['JP'], forwarded_ip_config: {} } })), 'unsupported keys')
invalid('too deep', policy(rule({ not_statement: { statement: { not_statement: { statement: { not_statement: { statement: geo } } } } } })), 'maximum depth')
invalid('nested rate', policy(rule({ not_statement: { statement: statements.rate } })), 'root-only')
invalid('and with one child', policy(rule({ and_statement: { statement: [geo] } })), 'at least two')
invalid('rate limit string', policy(rule({ rate_based_statement: { aggregate_key_type: 'IP', limit: '2000' } })), 'rate requires')
invalid('unsupported aggregation', policy(rule({ rate_based_statement: { aggregate_key_type: 'FORWARDED_IP', limit: 2000 } })), 'rate requires')
invalid('invalid field', policy(rule({ xss_match_statement: { ...match, field_to_match: { body: {} } } })), 'select one supported')
invalid('uppercase field name', policy(rule({ xss_match_statement: { ...match, field_to_match: { single_header: { name: 'Accept' } } } })), 'lowercase')
invalid('empty transformations', policy(rule({ xss_match_statement: { ...match, text_transformation: [] } })), 'non-empty list')
invalid('unknown transform', policy(rule({ xss_match_statement: { ...match, text_transformation: [{ priority: 0, type: 'BASE64_DECODE' }] } })), 'unsupported transform')
invalid('malformed optional sensitivity', policy(rule({ sqli_match_statement: { ...match, sensitivity_level: {} } })), 'sensitivity_level')
invalid('regional reference ARN', policy(rule({ ip_set_reference_statement: { arn: arn('ipset').replace('global/', 'regional/') } })), 'global ARN')
invalid('group ordinary action', policy({ ...managed, action: { count: {} } }), 'group rules require')
invalid('malformed group override list', policy({ ...managed, statement: { managed_rule_group_statement: { name: 'group', vendor_name: 'AWS', rule_action_override: 5 } } }), 'expected list')
invalid('unknown action member', policy(rule(geo, { count: { custom_request_handling: {} } })), 'one supported action')
invalid('missing custom response body', policy(rule(geo, { block: { custom_response: { response_code: 403, custom_response_body_key: 'missing' } } })), 'must reference')
invalid('malformed optional headers', policy(rule(geo, { block: { custom_response: { response_code: 403, response_header: 5 } } })), 'at most 10')
invalid('reserved content-type header', policy(rule(geo, { block: { custom_response: { response_code: 403, response_header: [{ name: 'Content-Type', value: 'text/plain' }] } } })), 'content-type is reserved')
invalid('invalid rule visibility boolean', policy({ ...rule(), visibility_config: { sampled_requests_enabled: 'false' } }), 'boolean flags')
invalid('invalid response byte size', { ...policy(), custom_response_bodies: { too_big: { content: 'あ'.repeat(4000), content_type: 'TEXT_PLAIN' } } }, 'UTF-8 bytes')
test('resource ownership cardinality does not depend on validation/unknown reference ARNs', () => {
  const source = readFileSync(join(root, 'waf.tf'), 'utf8')
  assert.match(source, /count\s*=\s*local\.waf_enabled \? 1 : 0/u)
  assert.match(source, /for_each\s*=\s*local\.waf_enabled \? toset\(\["IPV4", "IPV6"\]\)/u)
  assert.doesNotMatch(source, /local\.waf_ready/u)
})

test('computed caller reference keeps mode, rule identity and statement kind known without a plan', () => {
  const dir = mkdtempSync(join(tmpdir(), 'artifact-pages-waf-unknown-'))
  try {
    const validation = readFileSync(join(root, 'waf-validation.tf'), 'utf8')
      .replaceAll('var.waf_custom_rules', 'local.policy')
      .replaceAll('var.web_acl_arn', 'null')
      .replaceAll('aws_wafv2_web_acl.viewer[0].arn', 'terraform_data.reference.output')
    writeFileSync(join(dir, 'validation.tf'), validation)
    writeFileSync(join(dir, 'main.tf'), `
resource "terraform_data" "reference" { input = "${arn('ipset')}" }
locals {
  aws_account_id = "000000000000"
  policy = {
    presets = {}
    default_action = { allow = {} }
    custom_response_bodies = {}
    visibility_config = {}
    rules = [{
      name = "computed-reference"
      priority = 1
      statement = { ip_set_reference_statement = { arn = tostring(terraform_data.reference.output) } }
      action = { count = {} }
    }]
  }
}
`)
    const init = spawnSync(terraform, ['init', '-backend=false', '-input=false', '-no-color'], { cwd: dir, encoding: 'utf8', timeout: 30000 })
    assert.equal(init.status, 0, init.stderr)
    const result = spawnSync(terraform, ['console', '-no-color'], {
      cwd: dir, encoding: 'utf8', timeout: 30000,
      input: 'jsonencode({enabled=local.waf_enabled, indices=keys(local.waf_rule_values), name=local.waf_rule_values["0"].name, kinds=keys(local.waf_rule_values["0"].statement)})\n',
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr.trim(), '', result.stderr)
    assert.deepEqual(JSON.parse(JSON.parse(result.stdout.trim())), { enabled: true, indices: ['0'], name: 'computed-reference', kinds: ['ip_set_reference_statement'] })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
for (const [name, extra, diagnostic] of [
  ['unsupported viewer transport', { viewer_protocol_policy: 'allow-all' }, 'viewer_protocol_policy must be'],
  ['regional caller ACL', { web_acl_arn: arn('webacl').replace('global/', 'regional/') }, 'web_acl_arn must be'],
  ['empty caller ACL', { web_acl_arn: '' }, 'web_acl_arn must be'],
]) {
  test(name, () => {
    const dir = mkdtempSync(join(tmpdir(), 'artifact-pages-waf-variable-'))
    try {
      const vars = join(dir, 'test.tfvars.json')
      writeFileSync(vars, JSON.stringify({ ...base, ...extra }))
      const result = spawnSync(terraform, ['console', '-no-color', `-state=${join(dir, 'terraform.tfstate')}`, `-var-file=${vars}`], { cwd: root, input: 'var.web_acl_arn\n', encoding: 'utf8', timeout: 30000 })
      assert.ok(result.stderr.includes(diagnostic), result.stderr)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
}

invalid('byte search limit counts UTF-8 bytes', policy(rule({ byte_match_statement: { ...match, search_string: 'あ'.repeat(67), positional_constraint: 'CONTAINS' } })), 'UTF-8 bytes')
valid('heterogeneous free rules preserve native shapes', { rules: [
  rule(),
  { ...rule(statements.rate, { block: { custom_response: { response_code: 403 } } }), name: 'rate', priority: 2 },
  { ...managed, name: 'managed', priority: 3 },
] })
