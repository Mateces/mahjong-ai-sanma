import { createGame, getValidActions, applyAction, nextRound } from '../src/game/engine'
import { chooseAction } from '../src/ai/ai-controller'

function runBatch(label: string, difficulties: number[], games: number) {
  const wins = [0, 0, 0, 0]
  let totalRounds = 0

  for (let g = 0; g < games; g++) {
    let state = createGame()

    for (let safety = 0; safety < 5000; safety++) {
      const actions = getValidActions(state)
      if (actions.length === 0) break

      const difficulty = difficulties[state.currentPlayer]
      const action = chooseAction(state, actions, difficulty)
      state = applyAction(state, action)

      if (state.phase === 'tsumo_win' || state.phase === 'ron_win') {
        wins[state.currentPlayer]++
        totalRounds++
        state = nextRound(state)
        if (state.phase === 'game_over') break
      } else if (state.phase === 'ryukyoku') {
        totalRounds++
        state = nextRound(state)
        if (state.phase === 'game_over') break
      }
    }
  }

  console.log(`\n=== ${label} (${games} games, ${totalRounds} rounds) ===`)
  for (let i = 0; i < 4; i++) {
    const pct = totalRounds > 0 ? (wins[i] / totalRounds * 100).toFixed(1) : '0.0'
    console.log(`  P${i} (diff=${difficulties[i]}): ${wins[i]} wins (${pct}%)`)
  }
}

// Test 1: All players at difficulty 0 (should be ~25% each)
runBatch('All difficulty=0', [0, 0, 0, 0], 20)

// Test 2: All at difficulty 1 (should also be ~25% each)
runBatch('All difficulty=1', [1, 1, 1, 1], 20)

// Test 3: Mixed difficulties as in the actual game
runBatch('Mixed difficulties', [0, 0.3, 0.6, 1.0], 20)
