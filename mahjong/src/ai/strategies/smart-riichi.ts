import type { Strategy } from '../strategy'
import { defaultDecide } from '../default-decide'
import { filterRiichiByValue } from './_helpers'

/**
 * Skip 立直 when the hand is already valuable enough on its own (役あり +
 * ≥ 5200 点 ダマ estimate). Otherwise delegate entirely to the default
 * scoring pipeline. No defensive behavior — this strategy only changes
 * the riichi-vs-damaten decision.
 */
export const SmartRiichi: Strategy = {
  name: 'smart-riichi',
  decide(state, actions, asPlayer) {
    const filtered = filterRiichiByValue(actions, state, asPlayer)
    return defaultDecide(state, filtered, 0, asPlayer)
  },
}
