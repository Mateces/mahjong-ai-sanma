import type { Action, GameState, Player } from '../game/types'
import { defaultDecide } from '../ai/default-decide'
import { pathEnumeratedPoints } from './path-points'
import { computeDealinEV } from './dealin-ev'

/**
 * v2 ('ev' strategy) main entry.
 *
 * v2 keeps v1's multi-criteria sort structure (it's robust to formula
 * noise) and injects two improvements at the right places:
 *
 *   1. `pointsEstimator` — per-wait precise yaku/han/fu/points via
 *      `pathEnumeratedPoints`, replacing v1's heuristic estimatePoints.
 *
 *   2. `dealinEvaluator` — opponent-model-backed deal-in EV. mixedRoundPoint
 *      becomes `pWin × points - dealinEV`, baking push-fold into the
 *      primary sort criterion (Phase 3). v1's `assessDanger` is still
 *      used as the final-tier tiebreaker.
 *
 * Earlier single-EV-scalar variants (broken) are abandoned: they removed
 * v1's tiebreakers and made decisions brittle to formula noise.
 */
export function evDecide(
  state: GameState,
  actions: Action[],
  asPlayer: Player,
): Action {
  return defaultDecide(state, actions, 0, asPlayer, pathEnumeratedPoints, computeDealinEV)
}
