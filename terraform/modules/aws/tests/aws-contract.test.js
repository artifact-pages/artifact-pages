import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
const main = await readFile(new URL('../main.tf', import.meta.url), 'utf8')
const variables = await readFile(new URL('../variables.tf', import.meta.url), 'utf8')
const outputs = await readFile(new URL('../outputs.tf', import.meta.url), 'utf8')
const versions = await readFile(new URL('../versions.tf', import.meta.url), 'utf8')
const cloudflareComposition = await readFile(new URL('../modules/cloudflare-dns-acm/main.tf', import.meta.url), 'utf8')
const cloudflareVariables = await readFile(new URL('../modules/cloudflare-dns-acm/variables.tf', import.meta.url), 'utf8')
const cloudflareOutputs = await readFile(new URL('../modules/cloudflare-dns-acm/outputs.tf', import.meta.url), 'utf8')
const cloudflareVersions = await readFile(new URL('../modules/cloudflare-dns-acm/versions.tf', import.meta.url), 'utf8')

function block(source, header) {
  const start = source.indexOf(header)
  assert.notEqual(start, -1, `Terraform block is missing: ${header}`)
  const open = source.indexOf('{', start + header.length - 1)
  assert.notEqual(open, -1, `Terraform block has no opening brace: ${header}`)

  let depth = 0
  let quote = false
  let escape = false
  let lineComment = false
  let hashComment = false
  let blockComment = false
  for (let index = open; index < source.length; index += 1) {
    const character = source[index]
    const next = source[index + 1]

    if (lineComment || hashComment) {
      if (character === '\n') {
        lineComment = false
        hashComment = false
      }
      continue
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false
        index += 1
      }
      continue
    }
    if (quote) {
      if (escape) escape = false
      else if (character === '\\') escape = true
      else if (character === '"') quote = false
      continue
    }

    if (character === '"') quote = true
    else if (character === '#') hashComment = true
    else if (character === '/' && next === '/') {
      lineComment = true
      index += 1
    } else if (character === '/' && next === '*') {
      blockComment = true
      index += 1
    } else if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }

  assert.fail(`Terraform block is not closed: ${header}`)
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function actionLists(source) {
  return [...source.matchAll(/Action\s*=\s*\[([^\]]*)\]/gu)].map(([, actions]) =>
    [...actions.matchAll(/"([^"]+)"/gu)].map(([, action]) => action),
  )
}

function localStatement(source, sid) {
  const match = new RegExp(`Sid\\s*=\\s*"${escapeRegExp(sid)}"`, 'u').exec(source)
  assert.ok(match, `Terraform statement is missing: ${sid}`)
  const end = source.indexOf('\n    },', match.index)
  assert.notEqual(end, -1, `Terraform statement is not closed: ${sid}`)
  return source.slice(match.index, end)
}

test('AWS deployment keeps the S3 origin private behind signed CloudFront OAC', () => {
  const publicAccess = block(main, 'resource "aws_s3_bucket_public_access_block" "origin"')
  for (const setting of ['block_public_acls', 'block_public_policy', 'ignore_public_acls', 'restrict_public_buckets']) {
    assert.match(publicAccess, new RegExp(`${setting}\\s*=\\s*true`, 'u'))
  }

  assert.match(block(main, 'resource "aws_s3_bucket_ownership_controls" "origin"'), /object_ownership\s*=\s*"BucketOwnerEnforced"/u)

  const oac = block(main, 'resource "aws_cloudfront_origin_access_control" "origin"')
  assert.match(oac, /origin_access_control_origin_type\s*=\s*"s3"/u)
  assert.match(oac, /signing_behavior\s*=\s*"always"/u)
  assert.match(oac, /signing_protocol\s*=\s*"sigv4"/u)

  const bucketPolicy = block(main, 'resource "aws_s3_bucket_policy" "origin"')
  assert.match(bucketPolicy, /Principal\s*=\s*\{\s*Service\s*=\s*"cloudfront\.amazonaws\.com"\s*\}/u)
  assert.match(bucketPolicy, /Action\s*=\s*\["s3:GetObject"\]/u)
  assert.match(bucketPolicy, /"AWS:SourceArn"\s*=\s*aws_cloudfront_distribution\.site\.arn/u)
  assert.doesNotMatch(bucketPolicy, /Principal\s*=\s*"\*"/u)
})

test('AWS deployment maps the logical app and content paths to bounded cache policies', async () => {
  const behaviors = block(main, '  cache_behaviors = {')
  for (const [name, path, policy] of [
    ['indexes', '/_indexes/*', 'indexes'],
    ['artifacts', '/_artifacts/*', 'artifacts'],
    ['previews', '/_previews/*', 'no_store'],
    ['assets', '/assets/*', 'immutable_assets'],
    ['errors', '/_errors/*', 'no_store'],
  ]) {
    const behavior = block(behaviors, `    ${name} = {`)
    assert.match(behavior, new RegExp(`path_pattern\\s*=\\s*"${escapeRegExp(path)}"`, 'u'))
    assert.match(behavior, new RegExp(`cache_policy_id\\s*=\\s*aws_cloudfront_cache_policy\\.${policy}\\.id`, 'u'))
  }

  const distribution = block(main, 'resource "aws_cloudfront_distribution" "site"')
  assert.match(distribution, /cache_policy_id\s*=\s*aws_cloudfront_cache_policy\.no_store\.id/u)
  assert.match(distribution, /for_each\s*=\s*local\.cache_behaviors/u)
  assert.match(distribution, /viewer_protocol_policy\s*=\s*var\.viewer_protocol_policy/u)

  for (const [name, ttl] of [['no_store', 0], ['indexes', 60], ['artifacts', 300], ['immutable_assets', 31536000]]) {
    const cachePolicy = block(main, `resource "aws_cloudfront_cache_policy" "${name}"`)
    for (const field of ['min_ttl', 'default_ttl', 'max_ttl']) {
      const expected = name === 'no_store' || (name === 'immutable_assets' && field === 'default_ttl') ? 0 : field === 'min_ttl' ? 0 : ttl
      assert.match(cachePolicy, new RegExp(`${field}\\s*=\\s*${expected}(?:\\s|$)`, 'u'), `${name}.${field} must be ${expected}`)
    }
  }

  const routeFunction = await readFile(new URL('../routes.js', import.meta.url), 'utf8')
  assert.doesNotMatch(routeFunction, /uri === "\/_control"|uri\.indexOf\("\/_control\/"\)/u)
  assert.match(routeFunction, /request\.uri = "\/index\.html"/u)
})

test('trusted production and preview HTML receive the enforced HTTPS CSP without CORS', () => {
  const policy = block(main, 'resource "aws_cloudfront_response_headers_policy" "artifact_csp"')
  assert.match(policy, /content_security_policy\s*=\s*join\("; ",/u)
  assert.match(policy, /default-src https: data: blob:/u)
  assert.match(policy, /content_type_options\s*\{\s*override\s*=\s*true/u)
  assert.doesNotMatch(policy, /\bhttp:/iu)
  assert.match(main, /response_headers_policy_id\s*=\s*contains\(\["artifacts",\s*"errors",\s*"previews"\],\s*ordered_cache_behavior\.key\)\s*\?\s*aws_cloudfront_response_headers_policy\.artifact_csp\.id\s*:\s*null/u)
  assert.doesNotMatch(main, /aws_cloudfront_function" "trusted_html_policy|Access-Control-Allow-Origin|cors_config/u)
})

test('provider configuration stays in callers so the module remains composable', async () => {
  assert.doesNotMatch(versions, /provider\s+"aws"/u)
  const localVersions = await readFile(new URL('../examples/local-consumer/versions.tf', import.meta.url), 'utf8')
  const registryVersions = await readFile(new URL('../examples/registry-consumer/versions.tf', import.meta.url), 'utf8')
  for (const source of [localVersions, registryVersions]) {
    assert.match(source, /provider\s+"aws"\s*\{\s*region\s*=\s*var\.aws_region/u)
  }
})

test('README lists every public input and output and explains root-state migration', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
  for (const name of [
    'name_prefix', 'aws_region', 'bucket_name', 'preview_retention_days',
    'github_oidc_provider_arn', 'github_oidc_issuer_url', 'admin_github_subjects',
    'satellite_github_subjects', 'aliases', 'acm_certificate_arn', 'web_acl_arn', 'price_class', 'tags',
  ]) {
    assert.ok(readme.includes(`| \`${name}\` |`), `README input table must include ${name}`)
  }
  for (const name of [
    'bucket_name', 'distribution_id', 'distribution_domain_name',
    'admin_role_arn', 'satellite_role_arns', 'aws_deployment_config_yaml',
  ]) {
    assert.ok(readme.includes(`| \`${name}\` |`), `README output table must include ${name}`)
  }
  assert.match(block(outputs, 'output "bucket_name"'), /value\s*=\s*aws_s3_bucket\.origin\.bucket/u)
  assert.match(readme, /former OSS `infra\/aws` directory was a root Terraform configuration/u)
  assert.match(readme, /module\.artifact_pages\.aws_s3_bucket\.origin/u)
  assert.match(readme, /terraform state mv/u)
  assert.match(readme, /artifact-pages-<AWS provider account ID>-<AWS region>/u)
  assert.match(readme, /read-only AWS identity lookup/u)
})

test('default bucket name is deterministic from the AWS provider account and region', () => {
  assert.match(variables, /variable "bucket_name"\s*\{[\s\S]*?default\s*=\s*null/u)
  assert.match(variables, /variable "github_oidc_provider_arn"[\s\S]*?12-digit account ID/u)
  assert.match(main, /data "aws_caller_identity" "current"/u)
  assert.match(main, /aws_account_id\s*=\s*data\.aws_caller_identity\.current\.account_id/u)
  assert.match(main, /github_oidc_provider_account_id\s*=\s*split\(":"\s*,\s*var\.github_oidc_provider_arn\)\[4\]/u)
  assert.match(main, /bucket_name\s*=\s*coalesce\(var\.bucket_name,\s*"artifact-pages-\$\{local\.aws_account_id\}-\$\{var\.aws_region\}"\)/u)
  const guard = block(main, 'resource "terraform_data" "target_account_guard"')
  assert.match(guard, /condition\s*=\s*local\.aws_account_id\s*==\s*local\.github_oidc_provider_account_id/u)
  assert.match(guard, /must match the account ID in github_oidc_provider_arn/u)
  const bucket = block(main, 'resource "aws_s3_bucket" "origin"')
  assert.match(bucket, /depends_on\s*=\s*\[terraform_data\.target_account_guard\]/u)
  assert.match(bucket, /bucket\s*=\s*local\.bucket_name/u)
  assert.match(outputs, /accountId\s*=\s*local\.aws_account_id/u)
  for (const declaration of main.matchAll(/^resource "[^"]+" "[^"]+" \{[\s\S]*?^\}/gmu)) {
    if (declaration[0].startsWith('resource "terraform_data"')) continue
    assert.match(declaration[0], /depends_on\s*=\s*\[[^\]]*terraform_data\.target_account_guard/u, `${declaration[0].split("\n", 1)[0]} must wait for the account guard`)
  }
})

test('preview lifecycle is prefix-scoped and accounts for current, noncurrent, and incomplete objects', () => {
  const versioning = block(main, 'resource "aws_s3_bucket_versioning" "origin"')
  assert.match(versioning, /status\s*=\s*"Suspended"/u)

  const lifecycle = block(main, 'resource "aws_s3_bucket_lifecycle_configuration" "origin"')
  const rules = [...lifecycle.matchAll(/rule\s*\{([\s\S]*?)\n  \}/gu)].map((match) => match[1])
  assert.equal(rules.length, 4, 'expected current, noncurrent, delete-marker, and multipart-upload lifecycle rules')
  for (const rule of rules) assert.match(rule, /prefix\s*=\s*"_previews\/"/u)
  assert.ok(rules.some((rule) => /expiration\s*\{\s*days\s*=\s*var\.preview_retention_days/u.test(rule)))
  assert.ok(rules.some((rule) => /noncurrent_version_expiration\s*\{\s*noncurrent_days\s*=\s*var\.preview_retention_days/u.test(rule)))
  assert.ok(rules.some((rule) => /expired_object_delete_marker\s*=\s*true/u.test(rule)))
  assert.ok(rules.some((rule) => /abort_incomplete_multipart_upload\s*\{\s*days_after_initiation\s*=\s*7/u.test(rule)))
  assert.match(variables, /variable "preview_retention_days"\s*\{[\s\S]*?condition\s*=\s*var\.preview_retention_days\s*>=\s*1/u)
})

test('admin and satellite OIDC roles have separate exact-subject trust and scoped S3 operations', () => {
  const adminTrust = block(main, 'data "aws_iam_policy_document" "admin_trust"')
  assert.match(adminTrust, /"sts:AssumeRoleWithWebIdentity"/u)
  assert.match(adminTrust, /:aud"[\s\S]*?"sts\.amazonaws\.com"/u)
  assert.match(adminTrust, /test\s*=\s*"StringEquals"[\s\S]*?values\s*=\s*var\.admin_github_subjects/u)

  const satelliteTrust = block(main, 'data "aws_iam_policy_document" "satellite_trust"')
  assert.match(satelliteTrust, /for_each\s*=\s*var\.satellite_github_subjects/u)
  assert.match(satelliteTrust, /:aud"[\s\S]*?"sts\.amazonaws\.com"/u)
  assert.match(satelliteTrust, /values\s*=\s*each\.value/u)
  assert.match(block(main, 'resource "aws_iam_role" "satellite"'), /for_each\s*=\s*var\.satellite_github_subjects/u)
  assert.match(block(main, 'resource "aws_iam_role_policy" "satellite"'), /for_each\s*=\s*var\.satellite_github_subjects/u)
  const satelliteRoleNames = block(main, '  satellite_role_names = {')
  assert.match(satelliteRoleNames, /length\("\$\{var\.name_prefix\}-\$\{site_id\}-publisher"\)\s*<=\s*64/u)
  assert.match(satelliteRoleNames, /substr\(sha256\(site_id\),\s*0,\s*20\)/u)
  assert.match(block(main, 'resource "aws_iam_role" "satellite"'), /name\s*=\s*local\.satellite_role_names\[each\.key\]/u)
  assert.match(block(main, 'resource "aws_iam_role_policy" "satellite"'), /name\s*=\s*local\.satellite_role_names\[each\.key\]/u)

  const adminStatements = block(main, 'locals {')
  assert.deepEqual(actionLists(adminStatements), [
    ['s3:ListBucket'], ['s3:GetObject'], ['s3:PutObject'], ['s3:DeleteObject'], ['cloudfront:CreateInvalidation'],
  ])
  assert.match(adminStatements, /"s3:ListBucket"/u)
  assert.match(adminStatements, /"s3:GetObject"/u)
  assert.match(adminStatements, /"s3:PutObject"/u)
  assert.match(adminStatements, /"s3:DeleteObject"/u)
  assert.match(adminStatements, /"cloudfront:CreateInvalidation"/u)
  assert.match(adminStatements, /"_control\/\*"/u)
  assert.doesNotMatch(adminStatements, /_control\/(?:locks|site-cache|publish-state|preview-cleanup|registry-cleanup|app-cache)/u, 'admin control access is prefix-level (IMP-66)')
  assert.doesNotMatch(adminStatements, /Action\s*=\s*"\*"/u)
  assert.doesNotMatch(adminStatements, /"s3:\*"/u)

  const satellitePolicy = block(main, 'resource "aws_iam_role_policy" "satellite"')
  assert.deepEqual(actionLists(satellitePolicy), [
    ['s3:GetObject'], ['s3:ListBucket'], ['s3:PutObject'], ['s3:DeleteObject'], ['cloudfront:CreateInvalidation'],
  ])
  assert.match(satellitePolicy, /"_indexes\/\$\{each\.key\}\/\*"/u)
  assert.match(satellitePolicy, /"_artifacts\/\$\{each\.key\}\/\*"/u)
  assert.match(satellitePolicy, /"_previews\/\$\{each\.key\}\/\*"/u)
  assert.match(satellitePolicy, /"_control\/sites\/\$\{each\.key\}\/\*"/u, 'satellite list scope is its own control prefix')
  assert.match(satellitePolicy, /"\$\{local\.bucket_arn\}\/_control\/sites\/\$\{each\.key\}\/\*"/u)
  assert.doesNotMatch(satellitePolicy, /_control\/(?:\*|sites\/\*)/u, 'a satellite never gets another site or the whole control prefix')
  assert.match(satellitePolicy, /"_control\/locks\/sites\/\$\{each\.key\}\.json"/u, 'transitional legacy exact key (IMP-66 step 3 removes it)')
  assert.match(satellitePolicy, /"\$\{local\.bucket_arn\}\/_indexes\/sites\.json"/u)
  assert.doesNotMatch(satellitePolicy, /\/index\.html|\/assets\/\*/u)
  assert.doesNotMatch(satellitePolicy, /"s3:\*"/u)
  const satelliteWriteStart = satellitePolicy.indexOf('Sid    = "WriteSelectedSiteAndLock"')
  const satelliteDeleteStart = satellitePolicy.indexOf('Sid    = "DeleteSelectedSiteStaleObjects"')
  assert.notEqual(satelliteWriteStart, -1)
  assert.notEqual(satelliteDeleteStart, -1)
  const satelliteWrite = satellitePolicy.slice(satelliteWriteStart, satelliteDeleteStart)
  assert.doesNotMatch(satelliteWrite, /_indexes\/sites\.json|\/index\.html|\/assets/u)
  const satelliteDelete = satellitePolicy.slice(satelliteDeleteStart)
  assert.match(satelliteDelete, /"s3:DeleteObject"/u)
  assert.match(satelliteDelete, /_artifacts\/\$\{each\.key\}\/\*/u)
  // Selected-site scopes only (index and preview deletion, exact control records); never the registry or locks.
  assert.doesNotMatch(satelliteDelete, /sites\.json|_control\/locks|registry-cleanup|app-cache/u)
  assert.doesNotMatch(satelliteDelete, /_(?:indexes|previews)\/\*|_control\/(?:site-cache|publish-state|preview-cleanup)\/\*/u)
  assert.match(variables, /satellite_github_subjects"[\s\S]*?type\s*=\s*map\(list\(string\)\)/u)
  assert.match(outputs, /satellite_role_arns/u)
})

test('admin role permits the supported application-plane paths only', () => {
  const adminStatements = block(main, 'locals {')
  const list = localStatement(adminStatements, 'ListProjectionPrefixes')
  const read = localStatement(adminStatements, 'ReadRegistryAppAndControlState')
  const write = localStatement(adminStatements, 'WriteApplicationRegistryAndControlState')
  const appRootPaths = ['index.html', 'preview-bridge.js', 'LICENSE', 'THIRD_PARTY_NOTICES.txt']

  for (const filePath of appRootPaths) {
    assert.match(list, new RegExp(`"${escapeRegExp(filePath)}"`, 'u'), `ListBucket must cover ${filePath}`)
    assert.ok(read.includes(`/${filePath}"`), `GetObject must cover ${filePath}`)
    assert.ok(write.includes(`/${filePath}"`), `PutObject must cover ${filePath}`)
  }
  assert.match(list, /"assets\/\*"/u, 'ListBucket must cover every generated asset')
  assert.ok(read.includes('/assets/*'), 'GetObject must cover every generated asset')
  assert.ok(write.includes('/assets/*'), 'PutObject must cover every generated asset')
  assert.doesNotMatch(write, /"\$\{local\.bucket_arn\}\/\*"/u, 'app writes must not include arbitrary root keys')
})

test('deployment output remains compatible with the CLI AWS target contract', () => {
  const targetOutput = block(outputs, 'output "aws_deployment_config_yaml"')
  assert.match(targetOutput, /schemaVersion\s*=\s*1/u)
  assert.match(targetOutput, /provider\s*=\s*"aws"/u)
  assert.doesNotMatch(targetOutput, /previewRetentionDays/u)
  assert.match(targetOutput, /accountId\s*=\s*local\.aws_account_id/u)
  assert.match(targetOutput, /region\s*=\s*var\.aws_region/u)
  assert.match(targetOutput, /bucket\s*=\s*aws_s3_bucket\.origin\.bucket/u)
  assert.match(targetOutput, /distributionId\s*=\s*aws_cloudfront_distribution\.site\.id/u)
})

test('module and clean caller examples use distinct local and Registry sources', async () => {
  const local = await readFile(new URL('../examples/local-consumer/main.tf', import.meta.url), 'utf8')
  const localVariables = await readFile(new URL('../examples/local-consumer/variables.tf', import.meta.url), 'utf8')
  const registry = await readFile(new URL('../examples/registry-consumer/main.tf', import.meta.url), 'utf8')
  const registryVariables = await readFile(new URL('../examples/registry-consumer/variables.tf', import.meta.url), 'utf8')
  const registryReadme = await readFile(new URL('../examples/registry-consumer/README.md', import.meta.url), 'utf8')
  assert.match(local, /source\s*=\s*"\.\.\/\.\."/u)
  assert.match(localVariables, /variable "bucket_name"[\s\S]*?default\s*=\s*null/u)
  assert.match(registry, /source\s*=\s*"tasuku43\/artifact-pages\/aws"/u)
  assert.match(registry, /version\s*=\s*"0\.1\.0"/u)
  assert.match(registryVariables, /variable "bucket_name"[\s\S]*?default\s*=\s*null/u)
  assert.match(registryReadme, /has not been approved or published/u)
})

test('optional Cloudflare composition leaves the root AWS module and caller-managed path independent', async () => {
  assert.match(versions, /source\s*=\s*"hashicorp\/aws"/u)
  assert.doesNotMatch(versions, /cloudflare\/cloudflare/u)
  assert.doesNotMatch(versions, /configuration_aliases/u)
  const compositionVariables = await readFile(new URL('../modules/cloudflare-dns-acm/variables.tf', import.meta.url), 'utf8')
  const compositionExampleVariables = await readFile(new URL('../examples/cloudflare-dns-acm-consumer/variables.tf', import.meta.url), 'utf8')
  assert.match(compositionVariables, /variable "bucket_name"[\s\S]*?default\s*=\s*null/u)
  assert.match(compositionExampleVariables, /variable "bucket_name"[\s\S]*?default\s*=\s*null/u)
  assert.match(variables, /variable "aliases"[\s\S]*?default\s*=\s*\[\]/u)
  assert.match(variables, /variable "acm_certificate_arn"[\s\S]*?default\s*=\s*null/u)
  assert.match(variables, /length\(var\.aliases\) == 0 \|\| var\.acm_certificate_arn != null/u)

  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
  assert.match(readme, /root AWS module remains AWS-only/u)
  assert.match(readme, /manage DNS and the `us-east-1` certificate in your own Terraform configuration/u)
  assert.match(readme, /does not create a Route 53 zone or records/u)
})

test('optional composition validates an ACM certificate in us-east-1 before wiring its alias into CloudFront', () => {
  assert.match(cloudflareVersions, /configuration_aliases\s*=\s*\[aws\.us_east_1\]/u)
  assert.match(cloudflareVersions, /source\s*=\s*"cloudflare\/cloudflare"/u)

  const certificate = block(cloudflareComposition, 'resource "aws_acm_certificate" "viewer"')
  assert.match(certificate, /provider\s*=\s*aws\.us_east_1/u)
  assert.match(certificate, /domain_name\s*=\s*local\.hostname/u)
  assert.match(certificate, /validation_method\s*=\s*"DNS"/u)
  assert.match(certificate, /create_before_destroy\s*=\s*true/u)

  const validation = block(cloudflareComposition, 'resource "aws_acm_certificate_validation" "viewer"')
  assert.match(validation, /provider\s*=\s*aws\.us_east_1/u)
  assert.match(validation, /certificate_arn\s*=\s*aws_acm_certificate\.viewer\.arn/u)
  assert.match(validation, /validation_record_fqdns\s*=\s*\[for record in cloudflare_dns_record\.acm_validation : record\.name\]/u)

  const awsModule = block(cloudflareComposition, 'module "artifact_pages"')
  assert.match(awsModule, /aws\s*=\s*aws/u)
  assert.match(awsModule, /aliases\s*=\s*\[local\.hostname\]/u)
  assert.match(awsModule, /acm_certificate_arn\s*=\s*aws_acm_certificate_validation\.viewer\.certificate_arn/u)
  assert.doesNotMatch(cloudflareComposition, /provider\s+"(?:aws|cloudflare)"/u)
})

test('Cloudflare records are DNS-only, scoped to the supplied zone, and never create Route 53 resources', () => {
  const validationRecord = block(cloudflareComposition, 'resource "cloudflare_dns_record" "acm_validation"')
  assert.match(validationRecord, /for_each\s*=\s*\{[\s\S]*?domain_validation_options/u)
  assert.match(validationRecord, /zone_id\s*=\s*var\.cloudflare_domain\.zone_id/u)
  assert.match(validationRecord, /type\s*=\s*each\.value\.resource_record_type/u)
  assert.match(validationRecord, /content\s*=\s*trimsuffix\(each\.value\.resource_record_value, "\."\)/u)
  assert.match(validationRecord, /ttl\s*=\s*1/u)
  assert.match(validationRecord, /proxied\s*=\s*false/u)

  const distributionRecord = block(cloudflareComposition, 'resource "cloudflare_dns_record" "distribution"')
  assert.match(distributionRecord, /zone_id\s*=\s*var\.cloudflare_domain\.zone_id/u)
  assert.match(distributionRecord, /name\s*=\s*local\.hostname/u)
  assert.match(distributionRecord, /type\s*=\s*"CNAME"/u)
  assert.match(distributionRecord, /content\s*=\s*module\.artifact_pages\.distribution_domain_name/u)
  assert.match(distributionRecord, /ttl\s*=\s*1/u)
  assert.match(distributionRecord, /proxied\s*=\s*false/u)
  assert.doesNotMatch(cloudflareComposition, /aws_route53_|cloudflare_zone\s/u)
})

test('composition docs include a real-plan review checklist and preserve live proof as T15', async () => {
  const readme = await readFile(new URL('../modules/cloudflare-dns-acm/README.md', import.meta.url), 'utf8')
  assert.match(readme, /## Real-plan review checklist/u)
  assert.match(readme, /accepts any valid non-apex hostname beneath the supplied Cloudflare zone/u)
  assert.match(readme, /cloudflare_domain\.hostname/u)
  assert.match(readme, /certificate validation waiter completes before the CloudFront distribution/u)
  assert.match(readme, /no Route 53 resources, apex record, unrelated Cloudflare records/u)
  assert.match(readme, /live T15 proof/u)
  assert.match(readme, /local validation script does not perform them/u)
})

test('Cloudflare hostname validation requires a valid non-apex name under the declared zone', async () => {
  const domain = block(cloudflareVariables, 'variable "cloudflare_domain"')
  assert.match(domain, /zone_id\s*=\s*string/u)
  assert.match(domain, /zone_name\s*=\s*string/u)
  assert.match(domain, /hostname\s*=\s*string/u)
  assert.match(domain, /lower\(var\.cloudflare_domain\.hostname\) != lower\(var\.cloudflare_domain\.zone_name\)/u)
  assert.match(domain, /endswith\(lower\(var\.cloudflare_domain\.hostname\), "\.\$\{lower\(var\.cloudflare_domain\.zone_name\)\}"\)/u)

  const example = await readFile(new URL('../examples/cloudflare-dns-acm-consumer/main.tf', import.meta.url), 'utf8')
  const providerConfig = await readFile(new URL('../examples/cloudflare-dns-acm-consumer/versions.tf', import.meta.url), 'utf8')
  assert.match(example, /aws\.us_east_1\s*=\s*aws\.us_east_1/u)
  assert.match(example, /cloudflare\s*=\s*cloudflare/u)
  assert.match(example, /zone_name\s*=\s*var\.cloudflare_zone_name/u)
  assert.match(example, /hostname\s*=\s*var\.aws_hostname/u)
  assert.match(providerConfig, /provider\s+"aws"\s*\{\s*region\s*=\s*var\.aws_region/u)
  assert.match(providerConfig, /alias\s*=\s*"us_east_1"\s+region\s*=\s*"us-east-1"/u)
  assert.match(providerConfig, /provider\s+"cloudflare"/u)
  assert.match(cloudflareOutputs, /certificate_arn/u)
})
