import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('CLI contract validation follows the CLI internal-package boundary', async () => {
  const root = new URL('../', import.meta.url)
  const script = await readFile(new URL('scripts/validate.sh', root), 'utf8')
  const helper = await readFile(new URL('tests/cli-contract/validator.go', root), 'utf8')
  assert.ok(helper.includes('"github.com/artifact-pages/artifact-pages/cli/internal/config"'))
  assert.ok(!helper.includes('"github.com/artifact-pages/artifact-pages/internal/config"'))
  assert.ok(script.includes('"$apprepo_dir/cli/internal/config/config.go"'))
  assert.ok(helper.includes('//go:build ignore'), 'the helper must stay out of the monorepo Go build')
  assert.ok(script.includes('mktemp -d "$apprepo_dir/cli/.local/terraform-aws-contract.XXXXXX"'))
  assert.ok(script.includes('trap \'rm -r "$contract_helper_dir"\' EXIT'))
})
