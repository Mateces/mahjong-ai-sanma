import { ActionKind } from '../game/types'
import type { Action, GameState, Player } from '../game/types'
import { scoreDiscardActions, type PointsEstimator, type DealinEvaluator } from './evaluate-discard'
import { scoreCallActions } from './evaluate-call'
import { selectByDifficulty } from './difficulty'

/**
 * Default per-seat decision pipeline used by chooseAction when no Strategy
 * is supplied. This is the same logic that used to live inside chooseAction;
 * exposing it as its own export lets Strategy implementations call it as a
 * fallback (e.g. "ベタオリ unless I can call defaultDecide for a winning
 * action").
 *
 * `asPlayer` overrides which seat the AI is acting as. Defaults to
 * state.currentPlayer (correct for discard phase, wrong for respond phase
 * since the responder isn't the discarder).
 */
export function defaultDecide(
  state: GameState,
  actions: Action[],
  difficulty: number = 0,
  asPlayer?: Player,
  pointsEstimator?: PointsEstimator,
  dealinEvaluator?: DealinEvaluator,
): Action {
  if (actions.length === 0) {
    throw new Error('No actions available')
  }
  if (actions.length === 1) {
    return actions[0]
  }

  // Always take winning actions immediately.
  const tsumo = actions.find(a => a.kind === ActionKind.Tsumo)
  if (tsumo) return tsumo

  const ron = actions.find(a => a.kind === ActionKind.Ron)
  if (ron) return ron

  const selfPlayer = asPlayer ?? state.currentPlayer
  const phase = state.phase

  if (phase === 'draw') {
    return actions[0] // only Pass available
  }

  if (phase === 'discard') {
    const callScores = scoreCallActions(state, actions, selfPlayer)
    const discardScores = scoreDiscardActions(state, actions, selfPlayer, pointsEstimator, dealinEvaluator)

    const scores = actions.map((action, i) => {
      if (action.kind === ActionKind.Discard || action.kind === ActionKind.Riichi) {
        return discardScores[i]
      }
      return callScores[i]
    })

    const idx = selectByDifficulty(scores, difficulty)
    return actions[idx]
  }

  if (phase === 'respond') {
    const scores = scoreCallActions(state, actions, selfPlayer)
    const idx = selectByDifficulty(scores, difficulty)
    return actions[idx]
  }

  return actions[0]
}
