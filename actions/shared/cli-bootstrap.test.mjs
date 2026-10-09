import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { requireCliRange } from './cli-range.mjs'
import { installPrebuilt } from './prebuilt-cli.mjs'
import { renderSummary } from './summary.mjs'

test('bootstrap outside range and foreign repository fail before any download', async () => {
  let calls = 0
  for (const release of [
    { bootstrapCli: '0.2.0', cliRange: '>=0.1.0 <0.2.0', repository: 'artifact-pages/artifact-pages' },
    { bootstrapCli: '0.1.0', cliRange: '>=0.1.0 <0.2.0', repository: 'evil/repo' },
  ]) await assert.rejects(installPrebuilt({ release, runnerOs: 'Linux', runnerArch: 'X64', fetchImpl: () => { calls++; throw Error('network') } }))
  assert.equal(calls, 0)
  assert.equal(requireCliRange('0.1.0', '>=0.1.0 <0.2.0'), '0.1.0')
  assert.equal(requireCliRange('0.1.99', '>=0.1.0 <0.2.0'), '0.1.99')
  for (const version of ['0.0.9', '0.2.0', '1.0.0', '0.1.0-rc', '00.1.0']) assert.throws(() => requireCliRange(version, '>=0.1.0 <0.2.0'))
})

test('wrapper preserves environment precedence, publishes only range/download token and reports failed actual execution', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cli-bootstrap-'))
  try {
    const cli = path.join(dir, 'cli'), capture = path.join(dir, 'capture.json'), summary = path.join(dir, 'summary')
    writeFileSync(cli, `#!/usr/bin/env node\nconst fs=require('fs');fs.writeFileSync(process.env.CAPTURE,JSON.stringify(process.env));fs.writeFileSync(process.env.ARTIFACT_PAGES_CLI_METADATA,JSON.stringify({schemaVersion:1,cliVersion:'0.1.0',configVersion:'0.1.1',override:false,overrideRequested:process.env.ARTIFACT_PAGES_CLI_VERSION,overrideSource:'environment',resolved:false}));console.log(JSON.stringify({operation:'registry sync',outcome:'failed',error:'test failure'}));process.exit(2)\n`)
    chmodSync(cli, 0o755)
    writeFileSync(path.join(dir, 'release.json'), JSON.stringify({schemaVersion:2,actionVersion:'0.9.0',bootstrapCli:'0.1.0',cliRange:'>=0.1.0 <0.2.0',repository:'artifact-pages/artifact-pages'}))
    const env = {...process.env, GITHUB_ACTION_PATH:dir, ARTIFACT_PAGES_CLI:cli, ARTIFACT_PAGES_ACTION_KIND:'registry', CAPTURE:capture, GITHUB_STEP_SUMMARY:summary, ARTIFACT_PAGES_INPUT_CLI_VERSION:'0.1.2', ARTIFACT_PAGES_CLI_VERSION:'0.1.3', ARTIFACT_PAGES_DOWNLOAD_TOKEN:'workflow', GITHUB_TOKEN:'private-config', ARTIFACT_PAGES_TEST_CLI:cli, ARTIFACT_PAGES_CLI_SKIP_RESOLUTION:'1'}
    const run=()=>spawnSync('node',[new URL('./invoke-cli.mjs',import.meta.url).pathname],{env,encoding:'utf8'})
    assert.equal(run().status,2)
    let actual=JSON.parse(readFileSync(capture))
    assert.equal(actual.ARTIFACT_PAGES_CLI_VERSION,'0.1.3')
    assert.equal(actual.ARTIFACT_PAGES_CLI_SKIP_RESOLUTION,'')
    assert.equal(actual.ARTIFACT_PAGES_TEST_CLI,undefined)
    assert.equal(actual.ARTIFACT_PAGES_DOWNLOAD_TOKEN,'workflow')
    assert.equal(actual.ARTIFACT_PAGES_CLI_RANGE,'>=0.1.0 <0.2.0')
    assert.match(readFileSync(summary,'utf8'),/CLI executed.*0.1.0/)
    assert.match(readFileSync(summary,'utf8'),/CLI override requested.*0.1.3/)
    assert.doesNotMatch(readFileSync(summary,'utf8'),/\*\*CLI override:\*\*/)
    env.ARTIFACT_PAGES_CLI_VERSION='';assert.equal(run().status,2)
    actual=JSON.parse(readFileSync(capture));assert.equal(actual.ARTIFACT_PAGES_CLI_VERSION,'0.1.2')
    rmSync(path.join(dir,'release.json'));assert.equal(run().status,2)
    actual=JSON.parse(readFileSync(capture));assert.equal(actual.ARTIFACT_PAGES_CLI_SKIP_RESOLUTION,'1')
  } finally {rmSync(dir,{recursive:true,force:true})}
})

test('trusted base fetch preserves shallow manual preview and never chooses checked-out head', async () => {
  const { ensureTrustedBase } = await import('./verify-preview-pr.mjs')
  const dir = mkdtempSync(path.join(tmpdir(), 'trusted-base-'))
  try {
    const remote=path.join(dir,'remote'), checkout=path.join(dir,'checkout')
    const git=(cwd,...args)=>{const r=spawnSync('git',args,{cwd,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim()}
    git(dir,'init','--initial-branch=main',remote)
    writeFileSync(path.join(remote,'config.yaml'),'cli:\n  version: 0.1.0\n')
    git(remote,'add','.');git(remote,'-c','user.name=test','-c','user.email=test@example.test','commit','-m','base')
    const base=git(remote,'rev-parse','HEAD')
    git(remote,'checkout','-b','head');writeFileSync(path.join(remote,'config.yaml'),'cli:\n  version: 0.1.9\n')
    git(remote,'add','.');git(remote,'-c','user.name=test','-c','user.email=test@example.test','commit','-m','head')
    git(remote,'checkout','main')
    git(dir,'clone','--depth=1','--single-branch','--branch','head',`file://${remote}`,checkout)
    assert.notEqual(git(checkout,'rev-parse','HEAD'),base)
    assert.equal(ensureTrustedBase(checkout,'origin/HEAD'),base)
    assert.equal(ensureTrustedBase(checkout,'origin/main',{...process.env,GITHUB_TOKEN:'private-config-token',ARTIFACT_PAGES_FETCH_TOKEN:'workflow-token'}),base)
    assert.match(git(checkout,'show',`${base}:config.yaml`),/0.1.0/)
    assert.match(readFileSync(path.join(checkout,'config.yaml'),'utf8'),/0.1.9/)
    assert.throws(()=>ensureTrustedBase(checkout,'origin/../main'),/trusted config base/)
  } finally {rmSync(dir,{recursive:true,force:true})}
})

test('trusted base fetch uses workflow authentication without forwarding private config tokens or duplicating checkout headers', async () => {
  const { ensureTrustedBase } = await import('./verify-preview-pr.mjs')
  const dir=mkdtempSync(path.join(tmpdir(),'trusted-base-env-')), previousPath=process.env.PATH
  const previousCapture=process.env.FAKE_CAPTURE, previousHeader=process.env.FAKE_HEADER
  try {
    const capture=path.join(dir,'capture'), marker=path.join(dir,'fetched')
    const script=path.join(dir,'git')
    writeFileSync(script,`#!/usr/bin/env node\nconst fs=require('fs'),p=require('path');const args=process.argv.slice(2), marker=p.join(p.dirname(process.env.FAKE_CAPTURE),'fetched');if(args[0]==='rev-parse'){if(fs.existsSync(marker)){console.log('${'a'.repeat(40)}');process.exit(0)}process.exit(1)}if(args[0]==='remote'){console.log('https://github.com/example/repo.git');process.exit(0)}if(args[0]==='config'){console.log(process.env.FAKE_HEADER||'');process.exit(0)}if(args[0]==='fetch'){fs.writeFileSync(process.env.FAKE_CAPTURE,JSON.stringify(process.env));fs.writeFileSync(marker,'yes');process.exit(0)}process.exit(1)\n`)
    chmodSync(script,0o755);process.env.PATH=dir+path.delimiter+previousPath;process.env.FAKE_CAPTURE=capture
    for(const existing of ['', 'AUTHORIZATION: basic already-configured']) {
      process.env.FAKE_HEADER=existing;rmSync(marker,{force:true})
      assert.equal(ensureTrustedBase(dir,'origin/main',{...process.env,GITHUB_TOKEN:'private',GH_TOKEN:'private-gh',ARTIFACT_PAGES_FETCH_TOKEN:'workflow'}),'a'.repeat(40))
      const child=JSON.parse(readFileSync(capture))
      assert.equal(child.GITHUB_TOKEN,undefined);assert.equal(child.GH_TOKEN,undefined)
      assert.equal(child.GIT_CONFIG_COUNT,existing?'0':'1')
      if(!existing)assert.equal(child.GIT_CONFIG_VALUE_0,`AUTHORIZATION: basic ${Buffer.from('x-access-token:workflow').toString('base64')}`)
    }
  } finally {
    process.env.PATH=previousPath
    if(previousCapture===undefined)delete process.env.FAKE_CAPTURE;else process.env.FAKE_CAPTURE=previousCapture
    if(previousHeader===undefined)delete process.env.FAKE_HEADER;else process.env.FAKE_HEADER=previousHeader
    rmSync(dir,{recursive:true,force:true})
  }
})
