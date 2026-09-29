import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const source = await readFile(fileURLToPath(new URL('./main.tf', import.meta.url)), 'utf8')
const variables = await readFile(fileURLToPath(new URL('./variables.tf', import.meta.url)), 'utf8')
const exampleRoot = fileURLToPath(new URL('../../../examples/cloudflare/terraform', import.meta.url))
const exampleMain = await readFile(`${exampleRoot}/main.tf`, 'utf8')
const exampleVariables = await readFile(`${exampleRoot}/variables.tf`, 'utf8')
const exampleTerraformVars = await readFile(`${exampleRoot}/terraform.tfvars.example`, 'utf8')
const deploymentYaml = await readFile(fileURLToPath(new URL('../../../examples/cloudflare/deployment.yaml.example', import.meta.url)), 'utf8')

function localBlock(name, nextName) {
  const start = source.indexOf(`  ${name} =`)
  const end = source.indexOf(`\n  ${nextName} =`, start)
  assert.notEqual(start, -1, `Terraform local ${name} must exist`)
  assert.notEqual(end, -1, `Terraform local ${nextName} must follow ${name}`)
  return source.slice(start, end)
}

test('Cloudflare delivery reserves raw preview keys from logical SPA rewrites', () => {
  assert.match(source, /normalized_path\s*=\s*"lower\(url_decode\(http\.request\.uri\.path, \\"r\\"\)\)"/u)
  const exclusions = localBlock('reserved_path_exclusions', 'logical_route_rule')
  assert.match(exclusions, /normalized_path\} ne \\"\/_previews\\"/u, 'the namespace root must not resolve to the SPA')
  assert.match(exclusions, /not starts_with\(\$\{local\.normalized_path\}, \\"\/_previews\/\\"\)/u, 'catalog, manifest, and bundle paths must reach R2 unchanged')

  const route = localBlock('logical_route_rule', 'projection_cache_paths')
  assert.match(route, /\$\{local\.reserved_path_exclusions\}/u)
  assert.match(route, /action\s*=\s*"rewrite"/u)
  assert.match(route, /value\s*=\s*"\/index\.html"/u)
  assert.match(source, /cloudflare_r2_custom_domain" "public"/u, 'the reserved request path must retain its R2 origin lookup')
})

test('Cloudflare preview responses remain cache-eligible only under origin freshness', () => {
  const cachePaths = localBlock('projection_cache_paths', 'control_block_rule')
  assert.match(cachePaths, /normalized_path\} eq \\"\/_previews\\"/u)
  assert.match(cachePaths, /starts_with\(\$\{local\.normalized_path\}, \\"\/_previews\/\\"\)/u)

  const cacheRule = localBlock('origin_cache_rule', 'artifact_csp_expression')
  assert.match(cacheRule, /\$\{local\.projection_cache_paths\}/u)
  assert.match(cacheRule, /action\s*=\s*"set_cache_settings"/u)
  assert.match(cacheRule, /cache\s*=\s*true/u)
  assert.match(cacheRule, /edge_ttl\s*=\s*\{\s*mode\s*=\s*"respect_origin"/u)
  assert.match(cacheRule, /browser_ttl\s*=\s*\{\s*mode\s*=\s*"respect_origin"/u)
})

test('Cloudflare dynamically enforces the trusted artifact CSP only on artifact responses', () => {
  const cspStart = source.indexOf('  artifact_csp_expression =')
  const cspEnd = source.indexOf('\n  artifact_csp_rule =', cspStart)
  assert.notEqual(cspStart, -1, 'dynamic artifact CSP expression must exist')
  assert.notEqual(cspEnd, -1, 'artifact CSP rule must follow its expression')
  const cspExpression = source.slice(cspStart, cspEnd)
  assert.match(cspExpression, /split\(http\.request\.full_uri, ":", 2\)\[0\]/u, 'the path source must follow the incoming HTTP or HTTPS scheme')
  assert.match(cspExpression, /lower\(http\.host\)/u, 'the path source must follow the current public host')
  assert.match(cspExpression, /split\(http\.request\.uri\.path, "\/", 4\)\[2\]/u, 'the path source must use only the current site segment')
  for (const source of [
    'default-src ',
    ' https: data: blob:; script-src ',
    "'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' data: blob:; style-src ",
    "'unsafe-inline' data: blob:",
  ]) {
    assert.ok(cspExpression.includes(source), `the trusted artifact CSP must preserve ${source}`)
  }
  assert.doesNotMatch(cspExpression, /'self'|http:/u, 'the CSP must not broaden same-origin or insecure external access')

  const ruleStart = source.indexOf('  artifact_csp_rule =')
  const ruleEnd = source.indexOf('\n}\n\nresource ', ruleStart)
  assert.notEqual(ruleStart, -1, 'artifact CSP rule must exist')
  assert.notEqual(ruleEnd, -1, 'artifact CSP rule must be closed')
  const rule = source.slice(ruleStart, ruleEnd)
  const ruleExpression = rule.match(/expression\s*=\s*"(.+)"/u)?.[1]
  assert.ok(ruleExpression, 'artifact response matching expression must exist')
  const escapedQuote = '\\' + '"'
  const unescapedRuleExpression = ruleExpression.replaceAll(escapedQuote, '"')
  assert.ok(unescapedRuleExpression.includes('${local.host_match} and starts_with(http.request.uri.path, "/_artifacts/")'), 'the response transform must be scoped to the configured public host')
  assert.ok(unescapedRuleExpression.includes('starts_with(http.request.uri.path, "/_artifacts/")'), 'the rule must be scoped to artifacts')
  assert.ok(unescapedRuleExpression.includes('split(http.request.uri.path, "/", 4)[2] ne ""'), 'namespace roots without a site segment must not get a site CSP')
  assert.ok(unescapedRuleExpression.includes('starts_with(http.request.uri.path, concat("/_artifacts/", split(http.request.uri.path, "/", 4)[2], "/"))'), 'paths without a slash after the site ID are not artifact responses')
  assert.match(rule, /"content-security-policy"\s*=\s*\{\s*operation\s*=\s*"set"\s*expression\s*=\s*trimspace\(local\.artifact_csp_expression\)/u)

  const rulesetStart = source.indexOf('resource "cloudflare_ruleset" "artifact_response_policy"')
  assert.notEqual(rulesetStart, -1, 'artifact response policy ruleset must exist')
  const ruleset = source.slice(rulesetStart)
  assert.match(ruleset, /phase\s*=\s*"http_response_headers_transform"/u)
  assert.match(ruleset, /rules\s*=\s*concat\(var\.existing_response_header_rules, \[local\.artifact_csp_rule\]\)/u)
  assert.match(variables, /variable\s+"existing_response_header_rules"[\s\S]*?type\s*=\s*list\(any\)[\s\S]*?default\s*=\s*\[\]/u)
})

test('Cloudflare custom domain is explicit and the alternate r2.dev route is disabled', () => {
  assert.match(source, /resource\s+"cloudflare_r2_custom_domain"\s+"public"\s*\{/u)
  assert.match(source, /domain\s*=\s*lower\(var\.public_hostname\)/u)
  assert.match(source, /enabled\s*=\s*true\s+zone_id\s*=\s*var\.zone_id/su)
  assert.match(source, /min_tls\s*=\s*var\.minimum_tls_version/u)
  assert.match(source, /resource\s+"cloudflare_r2_managed_domain"\s+"development"\s*\{[\s\S]*?enabled\s*=\s*false/u)
  assert.match(variables, /variable\s+"connect_custom_domain"/u)
  assert.match(variables, /length\(var\.public_hostname\)\s*<=\s*253/u)
  assert.match(variables, /alltrue\(\[\s*for label in split\("\."\s*,\s*var\.public_hostname\)/u)
})

test('logical rewrites preserve every reserved object plane and block decoded control paths', () => {
  assert.match(source, /normalized_path\s*=\s*"lower\(url_decode\(http\.request\.uri\.path, \\"r\\"\)\)"/u)

  const exclusions = localBlock('reserved_path_exclusions', 'logical_route_rule')
  for (const path of ['/index.html', '/preview-bridge.js', '/license', '/third_party_notices.txt', '/assets', '/_indexes', '/_artifacts', '/_previews', '/_control']) {
    assert.ok(exclusions.includes(`\\"${path}\\"`), `logical routes must reserve ${path}`)
  }
  for (const prefix of ['/assets/', '/_indexes/', '/_artifacts/', '/_previews/', '/_control/']) {
    assert.ok(exclusions.includes(`\\"${prefix}\\"`), `logical routes must preserve ${prefix} objects`)
  }

  const route = localBlock('logical_route_rule', 'projection_cache_paths')
  assert.match(route, /expression\s*=\s*"\(\$\{local\.host_match\} and \(\$\{local\.reserved_path_exclusions\}\)\)"/u)
  assert.match(route, /action\s*=\s*"rewrite"/u)
  assert.match(route, /value\s*=\s*"\/index\.html"/u)

  const control = localBlock('control_block_rule', 'origin_cache_rule')
  assert.match(control, /expression\s*=\s*"\(\$\{local\.host_match\} and \(\$\{local\.normalized_path\} eq \\"\/_control\\" or starts_with\(\$\{local\.normalized_path\}, \\"\/_control\/\\"\)\)\)"/u)
  assert.match(control, /action\s*=\s*"block"/u)
})

test('origin cache rule covers only public projection paths and respects both origin TTLs', () => {
  const cachePaths = localBlock('projection_cache_paths', 'control_block_rule')
  for (const path of ['/index.html', '/preview-bridge.js', '/license', '/third_party_notices.txt', '/assets/', '/_indexes/', '/_artifacts/', '/_previews/']) {
    assert.ok(cachePaths.includes(`\\"${path}\\"`), `public projection cache rule must include ${path}`)
  }
  assert.equal(cachePaths.includes('/_control'), false, 'private control objects must never be cache-eligible')

  const cacheRule = localBlock('origin_cache_rule', 'artifact_csp_expression')
  assert.match(cacheRule, /action\s*=\s*"set_cache_settings"/u)
  assert.match(cacheRule, /cache\s*=\s*true/u)
  assert.match(cacheRule, /edge_ttl\s*=\s*\{\s*mode\s*=\s*"respect_origin"/u)
  assert.match(cacheRule, /browser_ttl\s*=\s*\{\s*mode\s*=\s*"respect_origin"/u)
  assert.doesNotMatch(cacheRule, /default|override_origin|"override"/u)
})

test('zone phase root rulesets retain caller-supplied existing rules in safe order', () => {
  assert.match(source, /rules\s*=\s*concat\(var\.existing_transform_rules, \[local\.logical_route_rule\]\)/u)
  assert.match(source, /rules\s*=\s*concat\(\[local\.control_block_rule\], var\.existing_firewall_rules\)/u)
  assert.match(source, /rules\s*=\s*concat\(var\.existing_cache_rules, \[local\.origin_cache_rule\]\)/u)
  assert.match(source, /rules\s*=\s*concat\(var\.existing_response_header_rules, \[local\.artifact_csp_rule\]\)/u)
  for (const name of ['existing_transform_rules', 'existing_firewall_rules', 'existing_cache_rules', 'existing_response_header_rules']) {
    assert.match(variables, new RegExp(`variable\\s+"${name}"`, 'u'))
  }
})

test('Cloudflare caller composes preview retention with delivery on the same bucket and policy value', () => {
  assert.match(exampleMain, /module\s+"artifact_pages_delivery"/u)
  assert.match(exampleMain, /module\s+"preview_retention"\s*\{[\s\S]*?source\s*=\s*"\.\.\/\.\.\/\.\.\/infra\/cloudflare\/retention"[\s\S]*?account_id\s*=\s*var\.cloudflare_account_id[\s\S]*?bucket_name\s*=\s*var\.r2_bucket_name[\s\S]*?preview_retention_days\s*=\s*var\.preview_retention_days/u)
  assert.match(exampleVariables, /variable\s+"preview_retention_days"[\s\S]*?floor\(var\.preview_retention_days\)\s*==\s*var\.preview_retention_days/u)
  assert.match(exampleTerraformVars, /preview_retention_days\s*=\s*30/u)
  assert.doesNotMatch(deploymentYaml, /previewRetentionDays:/u)
  assert.match(deploymentYaml, /accessKeyIdEnv:\s*CF_R2_ACCESS_KEY_ID/u)
  assert.match(deploymentYaml, /secretAccessKeyEnv:\s*CF_R2_SECRET_ACCESS_KEY/u)
  assert.match(deploymentYaml, /sessionTokenEnv:\s*CF_R2_SESSION_TOKEN/u)
  assert.match(deploymentYaml, /registryReaderAccessKeyIdEnv:\s*CF_R2_REGISTRY_READER_ACCESS_KEY_ID/u)
  assert.match(deploymentYaml, /registryReaderSecretAccessKeyEnv:\s*CF_R2_REGISTRY_READER_SECRET_ACCESS_KEY/u)
  assert.match(deploymentYaml, /registryReaderSessionTokenEnv:\s*CF_R2_REGISTRY_READER_SESSION_TOKEN/u)
  assert.match(deploymentYaml, /apiTokenEnv:\s*CF_API_TOKEN/u)
  assert.doesNotMatch(deploymentYaml, /(?:secretAccessKey|accessKeyId|apiToken):\s*[^\s<]/iu)
})
