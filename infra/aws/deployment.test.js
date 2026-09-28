import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { assertWebBundlePathsMatchDeploymentContract } from '../../scripts/web-bundle-paths.mjs'

const main = await readFile(new URL('./main.tf', import.meta.url), 'utf8')
const variables = await readFile(new URL('./variables.tf', import.meta.url), 'utf8')
const outputs = await readFile(new URL('./outputs.tf', import.meta.url), 'utf8')
const packageReleaseSource = await readFile(new URL('../../scripts/package-web-release.mjs', import.meta.url), 'utf8')

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
    ['control', '/_control/*', 'no_store'],
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
  assert.match(distribution, /viewer_protocol_policy\s*=\s*"redirect-to-https"/u)

  for (const [name, ttl] of [['no_store', 0], ['indexes', 60], ['artifacts', 300], ['immutable_assets', 31536000]]) {
    const cachePolicy = block(main, `resource "aws_cloudfront_cache_policy" "${name}"`)
    for (const field of ['min_ttl', 'default_ttl', 'max_ttl']) {
      const expected = name === 'no_store' ? 0 : field === 'min_ttl' ? 0 : ttl
      assert.match(cachePolicy, new RegExp(`${field}\\s*=\\s*${expected}(?:\\s|$)`, 'u'), `${name}.${field} must be ${expected}`)
    }
  }

  const routeFunction = await readFile(new URL('./routes.js', import.meta.url), 'utf8')
  assert.match(routeFunction, /uri === "\/_control" \|\| uri\.indexOf\("\/_control\/"\) === 0/u)
  assert.match(routeFunction, /statusCode: 404/u)
  assert.match(routeFunction, /"cache-control": \{ value: "no-store" \}/u)
  assert.match(routeFunction, /request\.uri = "\/index\.html"/u)
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
  assert.match(adminStatements, /"_control\/locks\/\*"/u)
  assert.match(adminStatements, /"_control\/registry-cleanup\.json"/u)
  assert.doesNotMatch(adminStatements, /Action\s*=\s*"\*"/u)
  assert.doesNotMatch(adminStatements, /"s3:\*"/u)

  const satellitePolicy = block(main, 'resource "aws_iam_role_policy" "satellite"')
  assert.deepEqual(actionLists(satellitePolicy), [
    ['s3:GetObject'], ['s3:ListBucket'], ['s3:PutObject'], ['s3:DeleteObject'],
  ])
  assert.match(satellitePolicy, /"_indexes\/\$\{each\.key\}\/\*"/u)
  assert.match(satellitePolicy, /"_artifacts\/\$\{each\.key\}\/\*"/u)
  assert.match(satellitePolicy, /"_previews\/\$\{each\.key\}\/\*"/u)
  assert.match(satellitePolicy, /"_control\/locks\/sites\/\$\{each\.key\}\.json"/u)
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
  assert.doesNotMatch(satelliteDelete, /_indexes|_previews|_control/u)
  assert.match(variables, /satellite_github_subjects"[\s\S]*?type\s*=\s*map\(list\(string\)\)/u)
  assert.match(outputs, /satellite_role_arns/u)
})

test('official web-bundle manifest paths fit the exact AWS admin list, read, and write scopes', () => {
  assert.match(packageReleaseSource, /const files = await listFiles\(distRoot\)/u)
  assert.match(packageReleaseSource, /assertWebBundlePathsMatchDeploymentContract\(files\)/u)
  assert.match(packageReleaseSource, /!files\.includes\('preview-bridge\.js'\)/u)
  assert.match(packageReleaseSource, /!files\.includes\('LICENSE'\)/u)
  assert.match(packageReleaseSource, /!files\.includes\('THIRD_PARTY_NOTICES\.txt'\)/u)
  assert.match(packageReleaseSource, /const manifest = \{[\s\S]*?files,/u)
  assert.doesNotThrow(() => assertWebBundlePathsMatchDeploymentContract([
    'index.html',
    'preview-bridge.js',
    'LICENSE',
    'THIRD_PARTY_NOTICES.txt',
    'assets/app.js',
    'assets/nested/chunk.js',
  ]))
  assert.throws(
    () => assertWebBundlePathsMatchDeploymentContract(['arbitrary-root.txt']),
    /outside the deployed application scope/u,
  )

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
  assert.match(targetOutput, /previewRetentionDays\s*=\s*var\.preview_retention_days/u)
  assert.match(targetOutput, /region\s*=\s*var\.aws_region/u)
  assert.match(targetOutput, /bucket\s*=\s*aws_s3_bucket\.origin\.id/u)
  assert.match(targetOutput, /distributionId\s*=\s*aws_cloudfront_distribution\.site\.id/u)
})
