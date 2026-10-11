import assert from 'node:assert/strict'
import test from 'node:test'
import { clampMatch, matchPositionLabel, stepMatch } from './match-navigator.ts'

test('stepping forward and back wraps around', () => {
  assert.equal(stepMatch(0, 5, 1), 1)
  assert.equal(stepMatch(4, 5, 1), 0)
  assert.equal(stepMatch(0, 5, -1), 4)
  assert.equal(stepMatch(2, 5, -1), 1)
})

test('stepping without matches stays at zero', () => {
  assert.equal(stepMatch(3, 0, 1), 0)
  assert.equal(stepMatch(0, 0, -1), 0)
})

test('a single match stays put', () => {
  assert.equal(stepMatch(0, 1, 1), 0)
  assert.equal(stepMatch(0, 1, -1), 0)
})

test('the position is clamped when the match count shrinks', () => {
  assert.equal(clampMatch(7, 3), 2)
  assert.equal(clampMatch(-1, 3), 0)
  assert.equal(clampMatch(4, 0), 0)
})

test('the label is one-based', () => {
  assert.equal(matchPositionLabel(1, 5), '2 / 5')
  assert.equal(matchPositionLabel(9, 5), '5 / 5')
})
