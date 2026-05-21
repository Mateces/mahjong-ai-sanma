import { createGame, getValidActions, applyAction } from '../src/game/engine'
import { chooseAction } from '../src/ai/ai-controller'
import type { GameState } from '../src/game/types'

const DIFFICULTIES = [0, 0.3, 0.6, 1.0]
const GAMES = 200

const wins = [0, 0, 0, 0]
let ryukyoku = 0

function playRound(state: GameState): GameState {
  while (true) {
    const actions = getValidActions(state)
    if (actions.length === 0) break

    const difficulty = DIFFICULTIES[state.currentPlayer]
    const action = chooseAction(state, actions, difficulty)
    state = applyAction(state, action)

    if (state.phase === 'tsumo_win') {
      wins[state.currentPlayer]++
      return state
    }
    if (state.phase === 'ron_win') {
      wins[state.currentPlayer]++
      return state
    }
    if (state.phase === 'ryukyoku') {
      ryukyoku++
      return state
    }
  }
  return state
}

const start = Date.now()

for (let i = 0; i < GAMES; i++) {
  let state = createGame()
  state = playRound(state)

  if ((i + 1) % 100 === 0) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1)
    process.stdout.write(`\r${i + 1}/${GAMES} (${elapsed}s)`)
  }
}

const elapsed = ((Date.now() - start) / 1000).toFixed(1)
const total = wins.reduce((a, b) => a + b, 0)

console.log(`\n\n=== ${GAMES}局统计 (${elapsed}s) ===`)
console.log(`和了: ${total}  流局: ${ryukyoku}  流局率: ${(ryukyoku / GAMES * 100).toFixed(1)}%\n`)
for (let p = 0; p < 4; p++) {
  const rate = (wins[p] / GAMES * 100).toFixed(1)
  console.log(`P${p} (難度${DIFFICULTIES[p]}): ${wins[p]}勝 (${rate}%)`)
}
