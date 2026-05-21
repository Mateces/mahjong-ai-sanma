import type { Action } from '../game/types'

/** Select an index from scored items using half-normal distribution */
export function selectByDifficulty(scores: number[], difficulty: number): number {
  // Build ranked list: sort indices by score descending
  const indexed = scores.map((score, idx) => ({ score, idx }))
  indexed.sort((a, b) => b.score - a.score)

  // c = difficulty^2 / 2
  const c = (difficulty * difficulty) / 2

  // If c === 0, always return index of highest score
  if (c === 0) {
    return indexed[0].idx
  }

  // Compute probabilities using half-normal distribution
  const probs = indexed.map((_, k) => Math.exp(-(k * k) / (2 * c * c)))
  const total = probs.reduce((sum, p) => sum + p, 0)

  // Weighted random selection
  const r = Math.random() * total
  let cumulative = 0
  for (let i = 0; i < probs.length; i++) {
    cumulative += probs[i]
    if (r < cumulative) {
      return indexed[i].idx
    }
  }

  // Fallback: return last element's original index
  return indexed[indexed.length - 1].idx
}

/** Convenience: select an Action from scored candidates */
export function selectAction(actions: Action[], scores: number[], difficulty: number): Action {
  const idx = selectByDifficulty(scores, difficulty)
  return actions[idx]
}
