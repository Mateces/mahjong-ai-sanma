import { createGame, getValidActions, applyAction } from '../src/game/engine'
import { chooseAction } from '../src/ai/ai-controller'
import { scoreDiscardActions } from '../src/ai/evaluate-discard'
import { scoreCallActions } from '../src/ai/evaluate-call'
import { ActionKind } from '../src/game/types'
import type { Action } from '../src/game/types'

const DIFFICULTIES = [0, 0.3, 0.6, 1.0]

function actionLabel(a: Action): string {
  switch (a.kind) {
    case ActionKind.Discard: return `Discard(${a.tile})`
    case ActionKind.Riichi: return `Riichi(${a.tile})`
    case ActionKind.Chi: return `Chi(${a.called})`
    case ActionKind.Pon: return `Pon(${a.called})`
    case ActionKind.Ankan: return `Ankan(${a.tile})`
    case ActionKind.Kakan: return `Kakan(${a.tile})`
    case ActionKind.Daiminkan: return `Daiminkan(${a.called})`
    case ActionKind.Tsumo: return 'Tsumo'
    case ActionKind.Ron: return 'Ron'
    case ActionKind.Kyushukyuhai: return 'Kyushu'
    case ActionKind.Pass: return 'Pass'
  }
}

// Play one round, log AI decisions for P0
let state = createGame()

for (let turn = 0; turn < 200; turn++) {
  const actions = getValidActions(state)
  if (actions.length === 0) break

  const player = state.currentPlayer
  const difficulty = DIFFICULTIES[player]

  // Decide action ONCE so logging matches what is actually played
  const action = chooseAction(state, actions, difficulty)

  // Log P0 decisions in detail
  if (player === 0 && state.phase === 'discard' && actions.length > 1) {
    const callScores = scoreCallActions(state, actions, player)
    const discardScores = scoreDiscardActions(state, actions, player)

    console.log(`Turn ${turn}: phase=${state.phase} hand=${state.players[0].hand}`)
    console.log(`  Actions: ${actions.map((a, i) => `${actionLabel(a)}(d=${discardScores[i].toFixed(1)},c=${callScores[i].toFixed(1)})`).join(' ')}`)
    console.log(`  Chosen: ${actionLabel(action)}`)
  }

  state = applyAction(state, action)

  if (state.phase === 'tsumo_win' || state.phase === 'ron_win' || state.phase === 'ryukyoku') {
    console.log(`End: ${state.phase} winner=P${state.currentPlayer}`)
    break
  }
}
