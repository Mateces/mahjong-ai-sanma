import type { GameState, Player, TileType } from '../game/types'
import { modelOpponent } from './opponent-model'

/**
 * Compute the deal-in expected value for discarding `tile`, summed across
 * all opponents. For each opponent:
 *
 *   contribution = pTenpai × dangerByTile[tile] × estHandValue
 *
 * Σ across opponents (independent approximation — overcount when multiple
 * opponents are tenpai on the same tile, but that's rare and the overcount
 * skews toward more conservative defense, which is the right side to err on).
 *
 * Signature matches v1's `DealinEvaluator` type so it plugs into
 * `calcMixedRoundPoint` via the injection point.
 */
export function computeDealinEV(
  state: GameState,
  selfPlayer: Player,
  tile: TileType,
): number {
  let total = 0
  for (let p = 0; p < state.playerCount; p++) {
    if (p === selfPlayer) continue
    const opp = modelOpponent(state, p as Player, selfPlayer)
    total += opp.pTenpai * opp.dangerByTile[tile] * opp.estHandValue
  }
  return total
}
