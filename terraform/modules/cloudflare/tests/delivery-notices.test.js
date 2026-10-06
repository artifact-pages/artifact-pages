import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const delivery = await readFile(new URL('../modules/delivery/main.tf', import.meta.url), 'utf8')
const exclusions = delivery.slice(delivery.indexOf('reserved_path_exclusions ='), delivery.indexOf('logical_route_rule ='))
const cachePaths = delivery.slice(delivery.indexOf('projection_cache_paths ='), delivery.indexOf('origin_cache_rule ='))

test('project and dependency notices bypass SPA fallback and honor origin cache policy', () => {
  for (const path of ['/license', '/third_party_notices.txt']) {
    assert.ok(exclusions.includes(`\u0024{local.normalized_path} ne \\"${path}\\"`), `${path} must bypass SPA rewriting`)
    assert.ok(cachePaths.includes(`\u0024{local.normalized_path} eq \\"${path}\\"`), `${path} must honor the published cache policy`)
  }
  assert.match(delivery, /normalized_path\s*=\s*"lower\(url_decode\(/u)
  assert.doesNotMatch(delivery, /control_block_rule/u)
  assert.doesNotMatch(exclusions, /\/_control/u)
})
