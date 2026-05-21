import type { GameState, Player, TileType } from '../game/types'
import { calculateShanten } from '../game/shanten'
import { getVisibleTiles } from '../ai/tile-analysis'
import { estimatePoints } from '../ai/evaluate-discard'
import { evaluateWinForHand } from './yaku-on-win'

/**
 * Path-enumerated point estimator. Used by v2 ('ev' strategy) to replace
 * v1's heuristic `estimatePoints` inside the shared decision pipeline.
 *
 * For a 13-tile tenpai hand: enumerate every potential winning tile.
 * For each one with a real yaku (via `evaluateWinForHand`), compute the
 * exact ron payment. Average across waits weighted by remaining count.
 *
 * For non-tenpai hands or 14-tile inputs: fall back to v1 `estimatePoints`
 * — the precision benefit only matters at tenpai where the hand's exact
 * yaku set is determinable. The mahjong-helper decision pipeline already
 * zeroes `mixedRoundPoint` at non-tenpai (shanten > 0), so this fallback
 * has no decision impact at non-tenpai anyway.
 *
 * Signature is identical to `estimatePoints` so it plugs into the
 * `PointsEstimator` injection point in `scoreDiscardActions`.
 */
export function pathEnumeratedPoints(
  hand: TileType[],
  state: GameState,
  selfPlayer: Player,
  bonusHan: number = 0,
): number {
  if (hand.length !== 13) {
    return estimatePoints(hand, state, selfPlayer, bonusHan)
  }
  const shanten = calculateShanten(hand)
  if (shanten !== 0) {
    return estimatePoints(hand, state, selfPlayer, bonusHan)
  }

  const assumeRiichi = bonusHan >= 1
  const visible = getVisibleTiles(state, selfPlayer)
  const isDealer = state.dealer === selfPlayer
  const melds = state.players[selfPlayer].melds

  let totalWeight = 0
  let weightedPoints = 0

  for (let t = 0 as TileType; t < 34; t++) {
    const remainingCount = Math.max(0, 4 - visible[t])
    if (remainingCount === 0) continue

    // Use ron payment as the canonical "single payer" value (matches
    // estimatePoints which returns ron payment). For dealer wins it's
    // already 1.5x via the engine's scoring multiplier.
    let bestRonPayment = 0
    const ronEval = evaluateWinForHand(hand, t, melds, state, selfPlayer, false, assumeRiichi)
    if (ronEval) {
      bestRonPayment = ronEval.scoreResult.ronPayment
    }
    const tsumoEval = evaluateWinForHand(hand, t, melds, state, selfPlayer, true, assumeRiichi)
    if (tsumoEval) {
      // For consistency with estimatePoints, prefer the ron payment value
      // even when only tsumo is available — same magnitude scale.
      bestRonPayment = Math.max(bestRonPayment, tsumoEval.scoreResult.ronPayment)
    }
    if (bestRonPayment === 0) continue

    weightedPoints += remainingCount * bestRonPayment
    totalWeight += remainingCount
  }

  // No yaku-bearing wait found at this tenpai. Strict interpretation: 0
  // (hand is unwinnable). Empirically the strict 0 makes the AI fold too
  // aggressively — other strategies' baseline-1500 lets them blindly
  // explore future-yaku paths and occasionally find one. Fall back to
  // v1's estimate so v2 keeps exploring weak hands the same way v1 does;
  // the v2 win comes specifically from CORRECT scoring of hands that
  // DO have detectable yaku (the path-enum precision), not from
  // out-rejecting v1 on hands where we can't tell.
  void isDealer
  if (totalWeight === 0) {
    return estimatePoints(hand, state, selfPlayer, bonusHan)
  }
  return weightedPoints / totalWeight
}
