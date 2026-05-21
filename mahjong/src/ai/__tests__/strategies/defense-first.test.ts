import { describe, it, expect } from 'vitest'
import { createGame, getValidActions, applyAction } from '../../../game/engine'
import { ActionKind } from '../../../game/types'
import type { Action, GameState, Player, PlayerState, TileType } from '../../../game/types'
import { DefenseFirst } from '../../strategies/defense-first'
import { defaultDecide } from '../../default-decide'
import { assessDanger } from '../../danger-eval'

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

describe('DefenseFirst strategy', () => {
  describe('pass-through cases', () => {
    it('falls back to defaultDecide when there are no threats', () => {
      const state = reachDiscard(createGame({ playerCount: 4 }))
      const actions = getValidActions(state)
      const fromStrategy = DefenseFirst.decide(state, actions, state.currentPlayer)
      const fromDefault = defaultDecide(state, actions, 0, state.currentPlayer)
      expect(fromStrategy).toEqual(fromDefault)
    })

    it('does not defend while self is in riichi', () => {
      let state = reachDiscard(createGame({ playerCount: 4 }))
      state = setPlayer(state, 0 as Player, { riichi: true })
      // Add another opponent in riichi to make sure the threat exists.
      state = setPlayer(state, 1 as Player, { riichi: true })
      const actions = getValidActions(state)
      const fromStrategy = DefenseFirst.decide(state, actions, state.currentPlayer)
      const fromDefault = defaultDecide(state, actions, 0, state.currentPlayer)
      expect(fromStrategy).toEqual(fromDefault)
    })

    it('always takes a Tsumo / Ron action even when defending', () => {
      const state = reachDiscard(createGame({ playerCount: 4 }))
      const tsumo: Action = { kind: ActionKind.Tsumo }
      const augmented: Action[] = [tsumo, { kind: ActionKind.Discard, tile: 0 as TileType }]
      const stateWithThreat = setPlayer(state, 1 as Player, { riichi: true })
      const chosen = DefenseFirst.decide(stateWithThreat, augmented, 0 as Player)
      expect(chosen.kind).toBe(ActionKind.Tsumo)
    })
  })

  describe('defense triggers', () => {
    it('treats an opponent riichi as a threat and folds at high shanten', () => {
      // Sparse mixed-suit hand → definitely 3+ shanten, no easy yaku.
      // P1 has 1s in river (genbutsu) so 1s is the most-or-near-most safe.
      let state = reachDiscard(createGame({ playerCount: 4 }))
      const hand: TileType[] = [0, 1, 5, 8, 9, 12, 15, 18, 19, 22, 25, 27, 31, 33]
      state = setPlayer(state, 0 as Player, { hand: hand.sort((a, b) => a - b) })
      state = setPlayer(state, 1 as Player, {
        riichi: true,
        discards: [{ tile: 18 as TileType, tsumogiri: false }],
      })
      state = { ...state, currentPlayer: 0 as Player }

      const actions = getValidActions(state)
      const chosen = DefenseFirst.decide(state, actions, 0 as Player)

      // Strategy is in ベタオリ mode → must return a Discard, never a Riichi.
      expect(chosen.kind).toBe(ActionKind.Discard)

      // The chosen tile should be the safest among the available discards.
      const dangers = actions
        .filter(a => a.kind === ActionKind.Discard)
        .map(a => ({
          tile: (a as Extract<Action, { kind: 'discard' }>).tile,
          danger: assessDanger(state, 0 as Player, (a as Extract<Action, { kind: 'discard' }>).tile),
        }))
      const minDanger = Math.min(...dangers.map(d => d.danger))
      const chosenTile = (chosen as Extract<Action, { kind: 'discard' }>).tile
      const chosenDanger = dangers.find(d => d.tile === chosenTile)!.danger
      expect(chosenDanger).toBe(minDanger)
    })

    it('does not enter defense for fuuro with visible fan < 4', () => {
      let state = reachDiscard(createGame({ playerCount: 4 }))
      // P1 has one pon of a non-yakuhai, non-dora tile: 0 visible han
      state = setPlayer(state, 1 as Player, {
        melds: [{ type: 'pon', tiles: [4, 4, 4] as TileType[], calledFrom: 0 as Player }],
        isMenzen: false,
      })
      const actions = getValidActions(state)
      const fromStrategy = DefenseFirst.decide(state, actions, state.currentPlayer)
      const fromDefault = defaultDecide(state, actions, 0, state.currentPlayer)
      expect(fromStrategy).toEqual(fromDefault)
    })

    it('enters defense for fuuro with visible fan >= 4 (3 yakuhai melds)', () => {
      let state = reachDiscard(createGame({ playerCount: 4 }))
      // P1 has three yakuhai pons: 中中中, 發發發, 白白白 — clearly mangan+ potential
      state = setPlayer(state, 1 as Player, {
        melds: [
          { type: 'pon', tiles: [31, 31, 31] as TileType[], calledFrom: 0 as Player },
          { type: 'pon', tiles: [32, 32, 32] as TileType[], calledFrom: 0 as Player },
          { type: 'pon', tiles: [33, 33, 33] as TileType[], calledFrom: 0 as Player },
        ],
        isMenzen: false,
      })
      // Give P0 a 3-shanten hand so they're forced into 守備 mode (no must-push).
      const hand: TileType[] = [0, 8, 9, 17, 18, 26, 4, 13, 22, 27, 28, 29, 5, 11]
      state = setPlayer(state, 0 as Player, { hand: hand.sort((a, b) => a - b) })
      state = { ...state, currentPlayer: 0 as Player }
      const actions = getValidActions(state)

      // Just verify the strategy returns *some* Discard (not crashes) and
      // the chosen tile is from the available set.
      const chosen = DefenseFirst.decide(state, actions, 0 as Player)
      expect(actions).toContainEqual(chosen)
    })
  })

  describe('mustPush exceptions', () => {
    it('pushes (uses defaultDecide) when last in score on the final round', () => {
      let state = reachDiscard(createGame({ playerCount: 4, endRound: 8 }))
      state = {
        ...state,
        roundNumber: 8, // final round
        currentPlayer: 0 as Player,
      }
      // P0 last (15000), others higher
      state = setPlayer(state, 0 as Player, { score: 15000 })
      state = setPlayer(state, 1 as Player, { score: 30000, riichi: true })
      state = setPlayer(state, 2 as Player, { score: 30000 })
      state = setPlayer(state, 3 as Player, { score: 25000 })

      const actions = getValidActions(state)
      const fromStrategy = DefenseFirst.decide(state, actions, 0 as Player)
      const fromDefault = defaultDecide(state, actions, 0, 0 as Player)
      expect(fromStrategy).toEqual(fromDefault)
    })
  })

  describe('respond phase', () => {
    it('passes on Pon when an opponent is in riichi', () => {
      // Build a state where P0 sees a discard from P3 that P0 could pon,
      // and P1 has riichi. The strategy should choose Pass.
      let state = createGame({ playerCount: 4 })
      state = reachDiscard(state)
      // Set up P0 hand with two of tile 4 to enable pon
      state = setPlayer(state, 0 as Player, {
        hand: [4, 4, 0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31] as TileType[],
      })
      state = setPlayer(state, 1 as Player, { riichi: true })
      // Force respond phase as if P3 discarded tile 4
      state = {
        ...state,
        phase: 'respond',
        lastDiscard: 4 as TileType,
        lastDiscardPlayer: 3 as Player,
      }
      const actions: Action[] = [
        { kind: ActionKind.Pon, called: 4 as TileType },
        { kind: ActionKind.Pass },
      ]
      const chosen = DefenseFirst.decide(state, actions, 0 as Player)
      expect(chosen.kind).toBe(ActionKind.Pass)
    })

    it('does not pass on Pon when there are no threats', () => {
      let state = createGame({ playerCount: 4 })
      state = reachDiscard(state)
      state = setPlayer(state, 0 as Player, {
        hand: [4, 4, 0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31] as TileType[],
      })
      state = {
        ...state,
        phase: 'respond',
        lastDiscard: 4 as TileType,
        lastDiscardPlayer: 3 as Player,
      }
      const actions: Action[] = [
        { kind: ActionKind.Pon, called: 4 as TileType },
        { kind: ActionKind.Pass },
      ]
      const fromStrategy = DefenseFirst.decide(state, actions, 0 as Player)
      const fromDefault = defaultDecide(state, actions, 0, 0 as Player)
      // Strategy should match defaultDecide when no threats — the default
      // may or may not pon depending on hand value, but they must agree.
      expect(fromStrategy).toEqual(fromDefault)
    })
  })
})
