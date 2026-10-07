import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { releaseSeries, checkPublishedActionVersion } from './release-series.mjs'

test('new Action versions advance only their own published inventory; existing 0.x rebuilds remain valid', () => {
  assert.throws(()=>checkPublishedActionVersion(releaseSeries('publish-action/v0.1.1'),['v0.2.0']),/must exceed/)
  assert.doesNotThrow(()=>checkPublishedActionVersion(releaseSeries('publish-action/v0.1.0'),['v0.1.0','v0.2.0']))
  assert.doesNotThrow(()=>checkPublishedActionVersion(releaseSeries('publish-action/v1.0.0'),['v1.0.0']))
  assert.doesNotThrow(()=>checkPublishedActionVersion(releaseSeries('preview-action/v0.1.0'),['bad','web/v9.0.0','publish-action/v9.0.0']))
  assert.doesNotThrow(()=>checkPublishedActionVersion(releaseSeries('publish-action/v0.2.1'),['v0.2.0']))
})

test('actual Action preflight reads fixed public inventory and fails closed on inventory errors', () => {
  const dir=mkdtempSync(path.join(tmpdir(),'release-inventory-'))
  try {
    const git=path.join(dir,'git')
    writeFileSync(git,`#!/usr/bin/env node\nconst args=process.argv.slice(2);if(args[0]==='ls-remote'){if(args[2]!==process.env.EXPECTED_REPO)process.exit(88);if(process.env.INVENTORY_FAILURE)process.exit(1);console.log('abc123\\trefs/tags/v0.2.0\\nabc123\\trefs/tags/v0.2.0^{}');process.exit(0)}if(args[0]==='rev-parse')console.log('${'a'.repeat(40)}');process.exit(0)\n`)
    chmodSync(git,0o755)
    const env={...process.env,PATH:dir+path.delimiter+process.env.PATH}
    const run=(tag,extra={})=>spawnSync('node',[new URL('./release-preflight.mjs',import.meta.url).pathname,'--tag',tag,'--main-ref','HEAD'],{env:{...env,EXPECTED_REPO:`https://github.com/artifact-pages/${tag.split('/')[0]}.git`,...extra},encoding:'utf8'})
    assert.match(run('publish-action/v0.1.1').stderr,/must exceed published 0.2.0/)
    for(const action of ['publish','preview','registry','app-deploy']) assert.equal(run(`${action}-action/v0.2.0`).status,0)
    assert.match(run('publish-action/v0.3.0',{INVENTORY_FAILURE:'1'}).stderr,/cannot read published/)
  } finally {rmSync(dir,{recursive:true,force:true})}
})
