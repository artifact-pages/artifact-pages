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

test('site sync requires an explicit site and source before building', { skip: !available }, () => {
  for (const vars of [[], ['SITE=guide'], ['SOURCE=docs/public/sites/guide']]) {
    const result = run(['cli:site:sync', ...vars]);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /missing required variables/);
    assert.doesNotMatch(result.output, /go build/);
  }
});

test('Cloudflare tasks use the fixed base-then-overlay config stack', { skip: !available }, () => {
  for (const [task, vars] of [
    ['site:sync', ['SITE=guide', 'SOURCE=docs/public/sites/guide']],
    ['registry:sync', []],
    ['app:remove', []],
    ['preview:remove', ['SITE=guide', 'GROUP=pr:42']],
    ['app:deploy', []],
    ['preview:publish', ['SITE=guide', 'SOURCE=docs/public/sites/guide', 'BASE_URL=https://artifact-pages.dev']],
  ]) {
    const result = run(['--dry', `cli:${task}:cloudflare`, ...vars, 'DRY_RUN=true']);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /--config artifact-pages.yaml --config artifact-pages.cloudflare.yaml --dry-run/);
    assert.match(result.output, /go build -o artifact-pages/);
  }
});

test('ordinary site sync preserves quoting and optional config', { skip: !available }, () => {
  const result = run(['--dry', 'cli:site:sync', 'SITE=guide', 'SOURCE=docs/path with spaces', 'CONFIG=config with spaces.yaml', 'DRY_RUN=true']);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /--source 'docs\/path with spaces'/);
  assert.match(result.output, /--config 'config with spaces.yaml'/);
  const normal = run(['--dry', 'cli:site:sync', 'SITE=guide', 'SOURCE=docs/public/sites/guide']);
  assert.equal(normal.status, 0, normal.output);
  assert.doesNotMatch(normal.output, /--config|--dry-run/);
});

test('deployment input and dry-run values are validated', { skip: !available }, () => {
  const pinned = run(['--dry', 'cli:app:deploy', 'DRY_RUN=true']);
  assert.equal(pinned.status, 0, pinned.output);
  assert.doesNotMatch(pinned.output, /--version|--archive/);
  const archive = run(['--dry', 'cli:app:deploy', 'ARCHIVE=a.tar.gz', 'DRY_RUN=true']);
  assert.equal(archive.status, 0, archive.output);
  assert.match(archive.output, /--archive a.tar.gz/);
  const result = run(['cli:site:sync', 'SITE=guide', 'SOURCE=docs/public/sites/guide', 'DRY_RUN=maybe']);
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

test('every CLI subcommand has a corresponding task', { skip: !available }, () => {
  const result = run(['--list-all']);
  assert.equal(result.status, 0, result.output);
  for (const name of ['site:sync', 'app:deploy', 'app:remove', 'registry:sync', 'preview:publish', 'preview:remove', 'index:build', 'config:set-default', 'lock:inspect', 'lock:recover']) {
    assert.ok(result.output.includes(`cli:${name}:`), `${name} is missing`);
  }
});

test('new tasks validate required inputs without running the CLI', { skip: !available }, () => {
  for (const [name, vars] of [
    ['preview:remove', ['SITE=guide']],
    ['preview:publish', ['SITE=guide', 'SOURCE=docs/public/sites/guide']],
    ['index:build', ['SITE=guide', 'SOURCE=docs/public/sites/guide']],
    ['config:set-default', []],
    ['lock:inspect', []],
    ['lock:inspect', ['SITE=guide', 'SCOPE=registry']],
    ['lock:recover', ['SITE=guide']],
    ['lock:recover', ['SITE=guide', 'OBSERVED_ETAG=abc', 'DRY_RUN=true']],
    ['index:build', ['SITE=guide', 'SOURCE=docs/public/sites/guide', 'OUT=.local/index', 'DRY_RUN=true']],
    ['config:set-default', ['LOCATOR=artifact-pages.yaml', 'DRY_RUN=true']],
  ]) {
    const result = run([`cli:${name}`, ...vars]);
    assert.notEqual(result.status, 0, result.output);
    assert.doesNotMatch(result.output, /go build|task: \[.*\] .\/artifact-pages/);
  }
});

test('new tasks map variables onto CLI arguments safely', { skip: !available }, () => {
  for (const [name, vars, expected] of [
    ['registry:sync', ['DRY_RUN=true'], /registry sync.*--dry-run/],
    ['preview:remove', ['SITE=guide', 'GROUP=pr:42', 'DRY_RUN=true'], /preview remove --site guide --group pr:42.*--dry-run/],
    ['app:remove', ['DRY_RUN=true'], /app remove.*--dry-run/],
    ['preview:publish', ['SITE=guide', 'SOURCE=docs/public/sites/guide', 'BASE_URL=https://artifact-pages.dev', 'PULL_REQUEST=42', 'HEAD=feature', 'DEFAULT_REF=origin/main', 'INCLUDE=assets/*.css', 'DRY_RUN=true'], /preview publish.*--head feature.*--default-ref origin\/main.*--pull-request 42.*--include 'assets\/\*.css'.*--dry-run/],
    ['index:build', ['SITE=guide', 'SOURCE=docs/path with spaces', 'OUT=.local/index output'], /index build --site guide --source 'docs\/path with spaces' --out '.local\/index output'/],
    ['config:set-default', ['LOCATOR=github://acme/admin/config.yaml?ref=main'], /config set-default 'github:\/\/acme\/admin\/config.yaml\?ref=main'/],
    ['lock:inspect', ['SITE=guide'], /lock inspect --scope site --site guide/],
    ['lock:inspect:cloudflare', ['SCOPE=registry'], /lock inspect --scope registry.*--config artifact-pages.yaml --config artifact-pages.cloudflare.yaml/],
    ['lock:recover:cloudflare', ['SCOPE=registry', 'OBSERVED_ETAG="abc"'], /lock recover --scope registry.*--observed-etag '"abc"'.*--config artifact-pages.yaml --config artifact-pages.cloudflare.yaml/],
  ]) {
    const result = run(['--dry', `cli:${name}`, ...vars]);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, expected);
  }
});
