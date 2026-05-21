import { createGame, getValidActions, applyAction, nextRound } from '../src/game/engine'
import { chooseAction } from '../src/ai/ai-controller'

const DIFFICULTIES = [0, 0.3, 0.6, 1.0]

const wins = [0, 0, 0, 0]
const games = 20

for (let g = 0; g < games; g++) {
  let state = createGame()
  let roundWins = [0, 0, 0, 0]

  for (let safety = 0; safety < 5000; safety++) {
    const actions = getValidActions(state)
    if (actions.length === 0) break

    const difficulty = DIFFICULTIES[state.currentPlayer]
    const action = chooseAction(state, actions, difficulty)
    state = applyAction(state, action)

    if (state.phase === 'tsumo_win') {
      roundWins[state.currentPlayer]++
      wins[state.currentPlayer]++
      state = nextRound(state)
      if (state.phase === 'game_over') break
    } else if (state.phase === 'ron_win') {
      roundWins[state.currentPlayer]++
      wins[state.currentPlayer]++
      state = nextRound(state)
      if (state.phase === 'game_over') break
    } else if (state.phase === 'ryukyoku') {
      state = nextRound(state)
      if (state.phase === 'game_over') break
    }
  }

  const totalRounds = roundWins.reduce((a, b) => a + b, 0)
  console.log(`Game ${g + 1}: rounds won = P0:${roundWins[0]} P1:${roundWins[1]} P2:${roundWins[2]} P3:${roundWins[3]} (total ${totalRounds} rounds)`)
}

console.log('\n=== Summary ===')
const totalWins = wins.reduce((a, b) => a + b, 0)
for (let i = 0; i < 4; i++) {
  console.log(`P${i} (difficulty=${DIFFICULTIES[i]}): ${wins[i]} round wins (${(wins[i] / totalWins * 100).toFixed(1)}%)`)
}
console.log(`Total round wins: ${totalWins}`)
