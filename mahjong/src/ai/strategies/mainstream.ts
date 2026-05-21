import type { Strategy } from '../strategy'
import { DefenseFirst } from './defense-first'
import { filterRiichiByValue } from './_helpers'

/**
 * "Mainstream" composite: smart-riichi gating (ダマ for already-valuable
 * yaku hands) layered on top of defense-first. Applied in that order:
 * the filter prunes 立直 candidates first, then defense-first decides
 * what to do with the surviving action set (push / 回し / ベタオリ).
 *
 * This is the closest single-strategy approximation of conservative
 * mainstream Japanese riichi play we currently have.
 */
export const Mainstream: Strategy = {
  name: 'mainstream',
  decide(state, actions, asPlayer) {
    const filtered = filterRiichiByValue(actions, state, asPlayer)
    return DefenseFirst.decide(state, filtered, asPlayer)
  },
}
