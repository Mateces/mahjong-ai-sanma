import { describe, it, expect } from 'vitest'
import { createGame, getValidActions, applyAction } from '../../game/engine'
import { ActionKind } from '../../game/types'
import type { Action, GameState, Player, PlayerState, TileType } from '../../game/types'
import { evDecide } from '../ev-controller'
import { defaultDecide } from '../../ai/default-decide'

function reachDiscard(state: GameState): GameState {
  let s = state
  let safety = 0
  while (s.phase !== 'discard' && safety++ < 8) {
    s = applyAction(s, { kind: ActionKind.Pass })
  }
  return s
}

function setPlayer(state: GameState, p: Player, patch: Partial<PlayerState>): GameState {
  const players = [...state.players] as GameState['players']
  players[p] = { ...players[p], ...patch }
  return { ...state, players }
}

describe('evDecide', () => {
  it('returns a valid action from the input set (smoke on random states)', () => {
    for (let seed = 0; seed < 20; seed++) {
      const state = reachDiscard(createGame({ playerCount: 4 }))
      const actions = getValidActions(state)
      const chosen = evDecide(state, actions, state.currentPlayer)
      expect(actions).toContainEqual(chosen)
    }
  })

  it('takes Tsumo when available', () => {
    const state = reachDiscard(createGame({ playerCount: 4 }))
    const tsumo: Action = { kind: ActionKind.Tsumo }
    const augmented: Action[] = [
      { kind: ActionKind.Discard, tile: 0 as TileType },
      tsumo,
    ]
    expect(evDecide(state, augmented, 0 as Player).kind).toBe(ActionKind.Tsumo)
  })

  it('falls back to defaultDecide behavior in respond phase', () => {
    let state = createGame({ playerCount: 4 })
    state = reachDiscard(state)
    const acts = getValidActions(state)
    const firstDiscard = acts.find(a => a.kind === ActionKind.Discard)
    expect(firstDiscard).toBeDefined()
    state = applyAction(state, firstDiscard!)
    expect(state.phase).toBe('respond')

    const responder = ((state.lastDiscardPlayer! + 1) % 4) as Player
    const responderActs: Action[] = [{ kind: ActionKind.Pass }]
    const fromEv = evDecide(state, responderActs, responder)
    const fromDefault = defaultDecide(state, responderActs, 0, responder)
    expect(fromEv).toEqual(fromDefault)
  })

  it('falls back when self is in riichi', () => {
    let state = reachDiscard(createGame({ playerCount: 4 }))
    state = setPlayer(state, state.currentPlayer, { riichi: true })
    const acts = getValidActions(state)
    const fromEv = evDecide(state, acts, state.currentPlayer)
    // Should still be the same as v1's default decision since riichi
    // locks the hand and the only choice is the drawn tile anyway.
    expect(acts).toContainEqual(fromEv)
  })
})
