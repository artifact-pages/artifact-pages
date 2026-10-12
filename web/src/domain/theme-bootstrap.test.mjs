import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1])

function themeAfterBootstrap({ stored, prefersDark, storageThrows = false }) {
  const document = { documentElement: { dataset: {} } }
  const context = {
    document,
    localStorage: {
      getItem(key) {
        if (storageThrows) throw new Error('blocked')
        assert.equal(key, 'git-artifact-pages-theme')
        return stored
      },
    },
    matchMedia: (query) => {
      assert.equal(query, '(prefers-color-scheme: dark)')
      return { matches: prefersDark }
    },
  }
  vm.runInNewContext(scripts[0], context)
  return document.documentElement.dataset.theme
}

test('index.html has one inline classic bootstrap script before the module script', () => {
  assert.equal(scripts.length, 1)
  assert.ok(html.indexOf('<script>') < html.indexOf('type="module"'))
})

test('stored dark sets the dark theme regardless of the system', () => {
  assert.equal(themeAfterBootstrap({ stored: 'dark', prefersDark: false }), 'dark')
})

test('stored light sets the light theme regardless of the system', () => {
  assert.equal(themeAfterBootstrap({ stored: 'light', prefersDark: true }), 'light')
})

test('system, missing and unknown values follow the dark media query', () => {
  for (const stored of ['system', null, 'bogus']) {
    assert.equal(themeAfterBootstrap({ stored, prefersDark: true }), 'dark')
    assert.equal(themeAfterBootstrap({ stored, prefersDark: false }), 'light')
  }
})

test('unavailable storage leaves the theme to the app', () => {
  assert.equal(themeAfterBootstrap({ stored: 'dark', prefersDark: true, storageThrows: true }), undefined)
})
