import type { Action } from '../game/types'

/**
 * Per-action expected-value evaluation. EV is in points (the same scale
 * used by estimatePoints) — a value of, say, 4000 means "averaged over the
 * remaining round, this action is expected to gain 4000 points net".
 *
 * `breakdown` retains the constituent terms so we can debug a decision
 * after the fact and so the diagnostic UI can explain "AI chose this
 * because winEV beat dealInEV by 1500".
 */
export interface ActionEV {
  action: Action
  ev: number
  breakdown: EvBreakdown
}

export interface EvBreakdown {
  /** Probability-weighted points if this play leads to a win. */
  winEV: number
  /** Probability-weighted points lost if this play deals in. */
  dealInEV: number
  /** Future phases: opportunity / fold value / rank utility. */
  otherEV: number
}
