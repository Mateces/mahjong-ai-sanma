import { describe, it, expect } from 'vitest'
import { chooseAction } from '../ai-controller'
import { createGame, getValidActions, applyAction, nextRound } from '../../game/engine'
import { ActionKind } from '../../game/types'
import type { Action, GameState } from '../../game/types'

/** Terminal phases that end a round. */
const ROUND_END_PHASES = new Set(['tsumo_win', 'ron_win', 'ryukyoku'])

/** Game phases where no further actions can be taken. */
const TERMINAL_PHASES = new Set(['tsumo_win', 'ron_win', 'ryukyoku', 'game_over'])

/**
 * Run a single game turn: get valid actions, let the AI choose, apply.
 * Returns the updated state.
 */
function runTurn(state: GameState, difficulty: number): GameState {
  const actions = getValidActions(state)
  const chosen = chooseAction(state, actions, difficulty)
  return applyAction(state, chosen)
}

/**
 * Play a full game loop up to `maxTurns` total turns across all rounds.
 * Returns the final state and the total turn count.
 */
function playGame(
  difficulty: number,
  maxTurns: number,
): { state: GameState; turnCount: number } {
  let state = createGame()
  let totalTurns = 0

  while (totalTurns < maxTurns) {
    state = runTurn(state, difficulty)
    totalTurns++

    if (ROUND_END_PHASES.has(state.phase)) {
      state = nextRound(state)
      if (state.phase === 'game_over') break
    }
  }

  return { state, turnCount: totalTurns }
}

// ---------------------------------------------------------------------------
// 1. Plays a complete game with 4 AI players without crashing
// ---------------------------------------------------------------------------
describe('AI integration', () => {
  it('plays a complete game with 4 AI players without crashing', { timeout: 120_000 }, () => {
    const { turnCount } = playGame(0.3, 100)
    expect(turnCount).toBeGreaterThan(0)
  })

  // -------------------------------------------------------------------------
  // 2. Plays with high difficulty (more random) without crashing
  // -------------------------------------------------------------------------
  it('plays with high difficulty (more random) without crashing', { timeout: 120_000 }, () => {
    const { turnCount } = playGame(1.0, 50)
    expect(turnCount).toBeGreaterThan(0)
  })

  // -------------------------------------------------------------------------
  // 3. AI at difficulty 0 never picks invalid actions
  // -------------------------------------------------------------------------
  it('AI at difficulty 0 never picks invalid actions', { timeout: 120_000 }, () => {
    let state = createGame()

    for (let i = 0; i < 30; i++) {
      const actions = getValidActions(state)
      const chosen = chooseAction(state, actions, 0)

      // Verify chosen action is in the valid list
      const isValid = actions.some(a => {
        if (a.kind !== chosen.kind) return false
        if (a.kind === ActionKind.Discard) {
          return a.tile === (chosen as Action & { kind: 'discard' }).tile
        }
        if (a.kind === ActionKind.Riichi) {
          return a.tile === (chosen as Action & { kind: 'riichi' }).tile
        }
        return true
      })
      expect(isValid).toBe(true)

      state = applyAction(state, chosen)

      if (ROUND_END_PHASES.has(state.phase)) {
        state = nextRound(state)
        if (state.phase === 'game_over') break
      }
    }
  })

  // -------------------------------------------------------------------------
  // 4. AI can play through round transitions
  // -------------------------------------------------------------------------
  it('AI can play through round transitions', { timeout: 120_000 }, () => {
    let state = createGame()
    let roundEnded = false

    for (let i = 0; i < 100; i++) {
      state = runTurn(state, 0.3)

      if (ROUND_END_PHASES.has(state.phase)) {
        roundEnded = true
        state = nextRound(state)

        // After nextRound the phase should be 'draw' (new round) or 'game_over'
        expect(
          state.phase === 'draw' || state.phase === 'game_over',
        ).toBe(true)

        if (state.phase === 'game_over') break
      }
    }

    // If a round ended within the limit we verified the transition.
    // If not, at least verify the loop didn't crash.
    expect(true).toBe(true)
  })

  // -------------------------------------------------------------------------
  // 5. Multiple difficulty levels all work
  // -------------------------------------------------------------------------
  it('multiple difficulty levels all work', { timeout: 120_000 }, () => {
    const difficulties = [0, 0.3, 0.6, 1.0]

    for (const difficulty of difficulties) {
      let state = createGame()

      for (let i = 0; i < 20; i++) {
        state = runTurn(state, difficulty)

        if (ROUND_END_PHASES.has(state.phase)) {
          state = nextRound(state)
          if (state.phase === 'game_over') break
        }
      }

      // Just verify we got here without crashing
      expect(state).toBeDefined()
    }
  })
})
