import assert from 'node:assert/strict'
import test from 'node:test'
import { sameScrollEdges, scrollEdges } from './scroll-edges.ts'

test('content that fits shows no edge', () => {
  assert.deepEqual(scrollEdges({ scrollLeft: 0, clientWidth: 300, scrollWidth: 300 }), { overflows: false, left: false, right: false })
  assert.deepEqual(scrollEdges({ scrollLeft: 0, clientWidth: 300, scrollWidth: 301 }), { overflows: false, left: false, right: false })
})

test('at the start only the right edge has more content', () => {
  assert.deepEqual(scrollEdges({ scrollLeft: 0, clientWidth: 300, scrollWidth: 800 }), { overflows: true, left: false, right: true })
})

test('in the middle both edges have more content', () => {
  assert.deepEqual(scrollEdges({ scrollLeft: 200, clientWidth: 300, scrollWidth: 800 }), { overflows: true, left: true, right: true })
})

test('at the end only the left edge has more content', () => {
  assert.deepEqual(scrollEdges({ scrollLeft: 500, clientWidth: 300, scrollWidth: 800 }), { overflows: true, left: true, right: false })
  assert.deepEqual(scrollEdges({ scrollLeft: 499.4, clientWidth: 300, scrollWidth: 800 }), { overflows: true, left: true, right: false })
})

test('right-to-left regions with negative scrollLeft are measured from the start', () => {
  assert.deepEqual(scrollEdges({ scrollLeft: 0, clientWidth: 300, scrollWidth: 800 }), { overflows: true, left: false, right: true })
  assert.deepEqual(scrollEdges({ scrollLeft: -500, clientWidth: 300, scrollWidth: 800 }), { overflows: true, left: true, right: false })
})

test('sameScrollEdges compares every field', () => {
  const a = { overflows: true, left: false, right: true }
  assert.equal(sameScrollEdges(a, { ...a }), true)
  assert.equal(sameScrollEdges(a, { ...a, left: true }), false)
})
