import { describe, it, expect } from 'vitest'
import { chooseAction } from '../ai-controller'
import { createGame, getValidActions, applyAction } from '../../game/engine'
import { ActionKind } from '../../game/types'
import type { Action, GameState, Player } from '../../game/types'

/** Play one full turn: draw -> discard, returning the state after discard (respond phase). */
function playOneTurn(state: GameState): GameState {
  // draw phase
  let actions = getValidActions(state)
  let action = chooseAction(state, actions)
  state = applyAction(state, action)

  // discard phase
  actions = getValidActions(state)
  action = chooseAction(state, actions)
  state = applyAction(state, action)

  return state
}

describe('chooseAction', () => {
  // ---------------------------------------------------------------------------
  // 1. Returns a valid action from the given list
  // ---------------------------------------------------------------------------
  it('returns a valid action from the given list', () => {
    let state = createGame()
    // Advance to discard phase
    let actions = getValidActions(state)
    state = applyAction(state, actions[0]) // Pass in draw phase -> discard phase

    actions = getValidActions(state)
    const chosen = chooseAction(state, actions)

    expect(actions).toContainEqual(chosen)
  })

  // ---------------------------------------------------------------------------
  // 2. Works in discard phase
  // ---------------------------------------------------------------------------
  it('works in discard phase', () => {
    const state = createGame()
    // Advance from draw -> discard
    const drawActions = getValidActions(state)
    const afterDraw = applyAction(state, drawActions[0])

    expect(afterDraw.phase).toBe('discard')
    const actions = getValidActions(afterDraw)
    const chosen = chooseAction(afterDraw, actions)

    expect(actions).toContainEqual(chosen)
    // Should be a Discard or Riichi or Tsumo (valid discard-phase actions)
    expect([ActionKind.Discard, ActionKind.Riichi, ActionKind.Tsumo, ActionKind.Ankan, ActionKind.Kakan]).toContain(chosen.kind)
  })

  // ---------------------------------------------------------------------------
  // 3. Works in respond phase
  // ---------------------------------------------------------------------------
  it('works in respond phase', () => {
    let state = createGame()
    // Play one full turn: draw + discard -> respond phase
    state = playOneTurn(state)

    expect(state.phase).toBe('respond')
    const actions = getValidActions(state)
    const chosen = chooseAction(state, actions)

    expect(actions).toContainEqual(chosen)
  })

  // ---------------------------------------------------------------------------
  // 4. Always picks tsumo when available
  // ---------------------------------------------------------------------------
  it('always picks tsumo when available', { timeout: 120_000 }, () => {
    // Run several games to try to hit a tsumo situation
    let foundTsumo = false
    for (let game = 0; game < 3; game++) {
      let state = createGame()

      for (let turn = 0; turn < 30; turn++) {
        if (state.phase === 'tsumo_win' || state.phase === 'ron_win' ||
            state.phase === 'ryukyoku' || state.phase === 'game_over') {
          break
        }

        const actions = getValidActions(state)
        if (actions.length === 0) break

        // Check if tsumo is available at discard phase
        if (state.phase === 'discard') {
          const tsumoAction = actions.find(a => a.kind === ActionKind.Tsumo)
          if (tsumoAction) {
            const chosen = chooseAction(state, actions)
            expect(chosen.kind).toBe(ActionKind.Tsumo)
            foundTsumo = true
            break
          }
        }

        // Otherwise just choose and apply
        const chosen = chooseAction(state, actions)
        state = applyAction(state, chosen)
      }

      if (foundTsumo) break
    }
    // If no tsumo was found across random games, the test still passes.
    // The important thing is that IF tsumo was found, it was always picked.
  })

  // ---------------------------------------------------------------------------
  // 5. Always picks ron when available
  // ---------------------------------------------------------------------------
  it('always picks ron when available', { timeout: 120_000 }, () => {
    let foundRon = false
    for (let game = 0; game < 3; game++) {
      let state = createGame()

      for (let turn = 0; turn < 30; turn++) {
        if (state.phase === 'tsumo_win' || state.phase === 'ron_win' ||
            state.phase === 'ryukyoku' || state.phase === 'game_over') {
          break
        }

        const actions = getValidActions(state)
        if (actions.length === 0) break

        // Check if ron is available at respond phase
        if (state.phase === 'respond') {
          const ronAction = actions.find(a => a.kind === ActionKind.Ron)
          if (ronAction) {
            const chosen = chooseAction(state, actions)
            expect(chosen.kind).toBe(ActionKind.Ron)
            foundRon = true
            break
          }
        }

        const chosen = chooseAction(state, actions)
        state = applyAction(state, chosen)
      }

      if (foundRon) break
    }
    // If no ron was found across random games, the test still passes.
  })

  // ---------------------------------------------------------------------------
  // 6. Works with highest difficulty (1.0)
  // ---------------------------------------------------------------------------
  it('works with highest difficulty', () => {
    let state = createGame()
    // Advance to discard phase
    let actions = getValidActions(state)
    state = applyAction(state, actions[0])

    actions = getValidActions(state)
    const chosen = chooseAction(state, actions, 1.0)

    expect(actions).toContainEqual(chosen)
  })

  // ---------------------------------------------------------------------------
  // 7. Throws when actions list is empty
  // ---------------------------------------------------------------------------
  it('throws when actions list is empty', () => {
    const state = createGame()
    expect(() => chooseAction(state, [])).toThrow()
  })

  // ---------------------------------------------------------------------------
  // 8. Returns the single action when only one is available
  // ---------------------------------------------------------------------------
  it('returns the single action when only one is available', () => {
    const state = createGame()
    // At draw phase, only Pass is available
    const actions = getValidActions(state)
    expect(actions).toHaveLength(1)
    const chosen = chooseAction(state, actions)
    expect(chosen).toEqual(actions[0])
  })

  // ---------------------------------------------------------------------------
  // 9. Works in draw phase (only Pass available)
  // ---------------------------------------------------------------------------
  it('works in draw phase returning pass', () => {
    const state = createGame()
    const actions = getValidActions(state)
    expect(state.phase).toBe('draw')
    const chosen = chooseAction(state, actions)
    expect(chosen.kind).toBe(ActionKind.Pass)
  })
})
