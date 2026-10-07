import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

// IMP-66: the CLI's _control/ key layout (tests/fixtures/control-keys.json, pinned to the CLI by
// cli/internal/publisher/control_keys_test.go) must be covered by the module's IAM policies, and a
// satellite role must reach only its own site's control records.

const main = await readFile(new URL('../main.tf', import.meta.url), 'utf8')
const fixture = JSON.parse(await readFile(new URL('./fixtures/control-keys.json', import.meta.url), 'utf8'))

// Flip to false in the module release that drops the pre-prefix exact keys (IMP-66 step 3); the
// legacy assertions below then require that no legacy key is granted any more.
const TRANSITIONAL_LEGACY_GRANTS = true

const ACTIONS = { get: 's3:GetObject', put: 's3:PutObject', delete: 's3:DeleteObject', list: 's3:ListBucket' }

function stripComments(source) {
  return source.split('\n').filter((line) => !/^\s*#/u.test(line)).join('\n')
}

function braceBlock(source, header) {
  const start = source.indexOf(header)
  assert.notEqual(start, -1, `missing ${header}`)
  const open = source.indexOf('{', start + header.length - 1)
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    if (source[index] === '}') depth -= 1
    if (depth === 0) return source.slice(open, index + 1)
  }
  throw new assert.AssertionError({ message: `unterminated ${header}` })
}

// Returns { 's3:GetObject': ['_control/*', ...], ... } of object-key patterns (Get/Put/Delete) and
// s3:prefix patterns (ListBucket) with ${local.bucket_arn}/ stripped.
function statementPatterns(text) {
  const result = {}
  for (const chunk of text.split(/Sid\s*=/u).slice(1)) {
    const action = /Action\s*=\s*\["(s3:[A-Za-z]+)"\]/u.exec(chunk)?.[1]
    if (!action) continue
    const patterns = action === ACTIONS.list
      ? [...chunk.slice(chunk.indexOf('"s3:prefix"')).matchAll(/"([^"]+)"/gu)].slice(1).map((match) => match[1])
      : [...chunk.matchAll(/"\$\{local\.bucket_arn\}\/([^"]+)"/gu)].map((match) => match[1])
    result[action] = [...(result[action] ?? []), ...patterns]
  }
  return result
}

const adminPatterns = statementPatterns(stripComments(braceBlock(main, 'locals {')))
const satellitePatterns = statementPatterns(stripComments(braceBlock(main, 'resource "aws_iam_role_policy" "satellite"')))

function allows(patterns, action, key, site) {
  return (patterns[action] ?? []).some((pattern) => {
    const expanded = pattern.replaceAll('${each.key}', site)
    const matcher = new RegExp(`^${expanded.replace(/[.+?^$()|[\]\\]/gu, '\\$&').replaceAll('*', '.*')}$`, 'u')
    return matcher.test(key)
  })
}

const concrete = (template, site) => template.replaceAll('{site}', site)

test('admin role covers every control key the CLI uses', () => {
  for (const row of [...fixture.site, ...fixture.global]) {
    for (const op of row.ops) {
      assert.ok(allows(adminPatterns, ACTIONS[op], concrete(row.key, 'alpha'), 'alpha'), `admin ${ACTIONS[op]} must cover ${row.key}`)
    }
  }
  for (const action of [ACTIONS.get, ACTIONS.put, ACTIONS.delete, ACTIONS.list]) {
    assert.ok(adminPatterns[action].includes('_control/*'), `${action} grants _control/* by prefix`)
    assert.deepEqual(adminPatterns[action].filter((pattern) => pattern.startsWith('_control/') && pattern !== '_control/*'), [], `${action}: no enumerated _control entries`)
  }
})

test('a satellite role covers its own site control records and nothing else under _control', () => {
  for (const row of fixture.site) {
    for (const op of row.ops) {
      assert.ok(allows(satellitePatterns, ACTIONS[op], concrete(row.key, 'alpha'), 'alpha'), `satellite ${ACTIONS[op]} must cover ${row.key}`)
    }
  }
  for (const row of fixture.global) {
    for (const action of Object.values(ACTIONS)) {
      assert.equal(allows(satellitePatterns, action, row.key, 'alpha'), (row.satelliteOps ?? []).some((op) => ACTIONS[op] === action), `satellite must not ${action} global record ${row.key}`)
    }
  }
  for (const other of ['beta', 'alpha-beta', 'alph']) {
    for (const row of [...fixture.site, ...(TRANSITIONAL_LEGACY_GRANTS ? [] : fixture.legacySite)]) {
      for (const action of Object.values(ACTIONS)) {
        assert.ok(!allows(satellitePatterns, action, concrete(row.key, other), 'alpha'), `satellite alpha must not ${action} ${concrete(row.key, other)}`)
      }
    }
  }
  for (const action of Object.values(ACTIONS)) {
    for (const pattern of satellitePatterns[action]) {
      assert.ok(!/^_control\/(?:\*|sites\/\*|sites\/\$\{each\.key\}\*)/u.test(pattern), `satellite ${action} pattern ${pattern} must not span other sites`)
    }
  }
})

test('transitional legacy grants follow the fixture exactly', () => {
  for (const row of fixture.legacySite) {
    for (const op of row.ops) {
      const granted = allows(satellitePatterns, ACTIONS[op], concrete(row.key, 'alpha'), 'alpha')
      assert.equal(granted, TRANSITIONAL_LEGACY_GRANTS, `legacy ${row.key} ${ACTIONS[op]}: granted=${granted}`)
    }
    for (const other of ['beta', 'alpha-beta']) {
      for (const action of Object.values(ACTIONS)) {
        assert.ok(!allows(satellitePatterns, action, concrete(row.key, other), 'alpha'), `legacy ${row.key}: alpha must not ${action} site ${other}`)
      }
    }
  }
})

test('the CLI never needs the legacy lock to be writable by delete', () => {
  const legacyLock = fixture.legacySite.find((row) => row.id === 'site-lock')
  assert.ok(!allows(satellitePatterns, ACTIONS.delete, concrete(legacyLock.key, 'alpha'), 'alpha'))
})
