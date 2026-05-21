import { describe, expect, it } from 'vitest'
import { selectAction, selectByDifficulty } from '../difficulty'
import type { Action } from '../../game/types'

describe('selectByDifficulty', () => {
  it('always picks index 0 when difficulty is 0', () => {
    const scores = [10, 8, 6, 4, 2]
    for (let i = 0; i < 50; i++) {
      expect(selectByDifficulty(scores, 0)).toBe(0)
    }
  })

  it('always returns a valid index for various difficulty values', () => {
    const scores = [10, 8, 6, 4, 2]
    for (let d = 0; d <= 1; d = Math.round((d + 0.1) * 10) / 10) {
      for (let i = 0; i < 20; i++) {
        const idx = selectByDifficulty(scores, d)
        expect(idx).toBeGreaterThanOrEqual(0)
        expect(idx).toBeLessThan(scores.length)
      }
    }
  })

  it('picks index 0 most often at low difficulty', () => {
    const scores = [10, 8, 6, 4, 2]
    let countBest = 0
    const trials = 200
    for (let i = 0; i < trials; i++) {
      if (selectByDifficulty(scores, 0.3) === 0) countBest++
    }
    expect(countBest / trials).toBeGreaterThan(0.9)
  })

  it('allows suboptimal picks at high difficulty', () => {
    const scores = [10, 8, 6, 4, 2]
    const picks = new Set<number>()
    for (let i = 0; i < 500; i++) {
      picks.add(selectByDifficulty(scores, 1.0))
    }
    // At high difficulty we should see at least some non-zero picks
    expect(picks.size).toBeGreaterThan(1)
  })

  it('handles single-element array', () => {
    expect(selectByDifficulty([42], 0.5)).toBe(0)
    expect(selectByDifficulty([42], 0)).toBe(0)
    expect(selectByDifficulty([42], 1)).toBe(0)
  })

  it('handles two-element array', () => {
    for (let i = 0; i < 50; i++) {
      const idx = selectByDifficulty([5, 3], 0.5)
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(idx).toBeLessThan(2)
    }
  })
})

describe('selectAction', () => {
  it('returns the action corresponding to the selected score', () => {
    const actions: Action[] = [
      { kind: 'discard', tile: 0 },
      { kind: 'discard', tile: 1 },
      { kind: 'discard', tile: 2 },
    ]
    const scores = [10, 5, 1]
    // With difficulty 0, always picks the best action
    for (let i = 0; i < 20; i++) {
      const action = selectAction(actions, scores, 0)
      expect(action).toBe(actions[0])
    }
  })

  it('returns a valid action for any difficulty', () => {
    const actions: Action[] = [
      { kind: 'pass' },
      { kind: 'ron', called: 5 },
    ]
    const scores = [8, 3]
    for (let i = 0; i < 50; i++) {
      const action = selectAction(actions, scores, 0.5)
      expect(actions).toContain(action)
    }
  })
})
