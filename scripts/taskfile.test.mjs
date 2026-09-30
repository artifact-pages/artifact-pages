import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const available = spawnSync('task', ['--version']).status === 0;
function run(args, cwd = root) {
  const result = spawnSync('task', ['--color=false', ...args], { cwd, encoding: 'utf8' });
  return { status: result.status, output: result.stdout + result.stderr };
}

test('publish requires an explicit site and source before building', { skip: !available }, () => {
  for (const vars of [[], ['SITE=guide'], ['SOURCE=docs/public/sites/guide']]) {
    const result = run(['cli:publish', ...vars]);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /missing required variables/);
    assert.doesNotMatch(result.output, /go build/);
  }
});

test('Cloudflare tasks use the fixed base-then-overlay config stack', { skip: !available }, () => {
  for (const [task, vars] of [
    ['publish', ['SITE=guide', 'SOURCE=docs/public/sites/guide']],
    ['registry', []],
    ['deploy', ['VERSION=1.2.3']],
  ]) {
    const result = run(['--dry', `cli:${task}:cloudflare`, ...vars, 'DRY_RUN=true']);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /--config artifact-pages.yaml --config artifact-pages.cloudflare.yaml --dry-run/);
    assert.match(result.output, /go build -o artifact-pages/);
  }
});

test('ordinary publish preserves quoting and optional config', { skip: !available }, () => {
  const result = run(['--dry', 'cli:publish', 'SITE=guide', 'SOURCE=docs/path with spaces', 'CONFIG=config with spaces.yaml', 'DRY_RUN=true']);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /--source 'docs\/path with spaces'/);
  assert.match(result.output, /--config 'config with spaces.yaml'/);
  const normal = run(['--dry', 'cli:publish', 'SITE=guide', 'SOURCE=docs/public/sites/guide']);
  assert.equal(normal.status, 0, normal.output);
  assert.doesNotMatch(normal.output, /--config|--dry-run/);
});

test('deployment input and dry-run values are validated', { skip: !available }, () => {
  for (const vars of [[], ['ARCHIVE=a.tar.gz', 'VERSION=1.2.3']]) {
    const result = run(['cli:deploy', ...vars]);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /Specify exactly one/);
    assert.doesNotMatch(result.output, /go build/);
  }
  const result = run(['cli:publish', 'SITE=guide', 'SOURCE=docs/public/sites/guide', 'DRY_RUN=maybe']);
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.output, /go build/);
});

test('package Taskfiles expose build tasks directly', { skip: !available }, () => {
  const cli = run(['--dry', 'build'], fileURLToPath(new URL('../cli/', import.meta.url)));
  assert.equal(cli.status, 0, cli.output);
  assert.match(cli.output, /go build -o artifact-pages .\/cli\/cmd\/artifact-pages/);
  const web = run(['--dry', 'serve'], fileURLToPath(new URL('../web/', import.meta.url)));
  assert.equal(web.status, 0, web.output);
  assert.match(web.output, /npm run build/);
  assert.match(web.output, /docker compose up/);
});
