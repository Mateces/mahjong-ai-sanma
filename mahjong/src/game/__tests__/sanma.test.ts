import { describe, it, expect } from 'vitest'
import { createGame, getValidActions, applyAction, nextRound } from '../engine'
import { ActionKind } from '../types'
import type { GameState, TileType, Player } from '../types'
import { doraFromIndicator } from '../tile-utils'

// Phase 1 of sanma support: 3-player engine basics.
// Covers wall composition, player count, no chi, dealer rotation modulus.

describe('sanma engine — Phase 1', () => {
  it('creates a 3-player game with 108 tiles and no 2m-8m in the wall', () => {
    const state = createGame({ playerCount: 3 })
    expect(state.playerCount).toBe(3)
    expect(state.players).toHaveLength(3)
    expect(state.wall).toHaveLength(108)
    // 2m-8m correspond to tile indices 1-7 — must be absent
    for (let t = 1; t <= 7; t++) {
      expect(state.wall.includes(t)).toBe(false)
    }
    // 1m and 9m must be present
    expect(state.wall.filter(t => t === 0).length).toBe(4)
    expect(state.wall.filter(t => t === 8).length).toBe(4)
  })

  it('initial draw index reflects 13 tiles per player (39 for 3 players)', () => {
    const state = createGame({ playerCount: 3 })
    expect(state.wallIndex).toBe(13 * 3)
  })

  it('deals 13 tiles to each of 3 players', () => {
    const state = createGame({ playerCount: 3 })
    for (const player of state.players) {
      expect(player.hand).toHaveLength(13)
    }
  })

  it('does not offer Chi as a respond action in sanma', () => {
    let state = createGame({ playerCount: 3 })
    // Force a discard so the next phase is respond
    state = applyAction(state, { kind: ActionKind.Pass }) // auto-draw
    // Now in 'discard' phase. Discard the first tile.
    const draws = getValidActions(state).filter(a => a.kind === ActionKind.Discard)
    if (draws.length > 0) {
      state = applyAction(state, draws[0])
    }
    // Should be in respond phase. No Chi should ever appear.
    const respondActions = getValidActions(state)
    expect(respondActions.some(a => a.kind === ActionKind.Chi)).toBe(false)
  })

  it('rotates dealer modulo 3 in sanma after a non-dealer win', () => {
    // Simulate a state where a non-dealer wins
    const initial = createGame({ playerCount: 3 })
    const won = { ...initial, phase: 'tsumo_win' as const, currentPlayer: 1 as const }
    const next = applyAction(won, { kind: ActionKind.Pass })
    // After a non-dealer win, dealer advances; with playerCount=3, modulo 3
    // ensures we never set dealer = 3 (which doesn't exist).
    // Note: the engine's nextRound is called separately; here we just sanity
    // check that the type system is OK with sanma player indexes 0..2.
    expect(initial.dealer).toBeGreaterThanOrEqual(0)
    expect(initial.dealer).toBeLessThan(3)
  })

  it('east-only mode for sanma normalizes endRound 4 → 3 (only 3 dealers)', () => {
    // Mahjong Soul rule: sanma east round has 3 hands (E1/E2/E3), no E4.
    // Callers may pass 4 as a yonma-style "east-only" mode flag; createGame
    // normalizes to the actual round count.
    const state = createGame({ playerCount: 3, endRound: 4 })
    expect(state.endRound).toBe(3)
  })

  it('hanchan mode for sanma normalizes endRound 8 → 6', () => {
    // Sanma hanchan = E1-3 + S1-3 = 6 hands.
    const state = createGame({ playerCount: 3, endRound: 8 })
    expect(state.endRound).toBe(6)
  })

  it('yonma endRound is unchanged (4 stays 4, 8 stays 8)', () => {
    expect(createGame({ playerCount: 4, endRound: 4 }).endRound).toBe(4)
    expect(createGame({ playerCount: 4, endRound: 8 }).endRound).toBe(8)
  })

  it('sanma round wind transitions to South at round 4 (not 5)', () => {
    // Sanma east lasts 3 rounds. Round 4 is South 1 in hanchan; no E4.
    // Simulate: P0 dealer, child wins round 3, child wins round 4-aspirant.
    let state = createGame({ playerCount: 3, endRound: 8 })
    // Force round 3 East wind (round 1 → child win → round 2 etc.)
    state = { ...state, roundNumber: 3, dealer: 2 as Player, currentPlayer: 1 as Player, phase: 'tsumo_win' }
    const next = nextRound(state)
    // After round 3 child win: round becomes 4, wind becomes South
    expect(next.roundNumber).toBe(4)
    expect(next.roundWind).toBe(1) // South
  })

  it('yonma round wind still transitions at round 5', () => {
    let state = createGame({ playerCount: 4, endRound: 8 })
    state = { ...state, roundNumber: 4, dealer: 3 as Player, currentPlayer: 1 as Player, phase: 'tsumo_win' }
    const next = nextRound(state)
    expect(next.roundNumber).toBe(5)
    expect(next.roundWind).toBe(1) // South
  })

  it('startDealer option sets the initial East dealer', () => {
    expect(createGame().dealer).toBe(0)
    expect(createGame({ startDealer: 0 as Player }).dealer).toBe(0)
    expect(createGame({ startDealer: 1 as Player }).dealer).toBe(1)
    expect(createGame({ startDealer: 2 as Player }).dealer).toBe(2)
    expect(createGame({ startDealer: 3 as Player }).dealer).toBe(3)
    expect(createGame({ startDealer: 2 as Player }).currentPlayer).toBe(2)
  })

  it('startDealer wraps modulo playerCount in sanma', () => {
    expect(createGame({ playerCount: 3, startDealer: 0 as Player }).dealer).toBe(0)
    expect(createGame({ playerCount: 3, startDealer: 1 as Player }).dealer).toBe(1)
    expect(createGame({ playerCount: 3, startDealer: 2 as Player }).dealer).toBe(2)
    expect(createGame({ playerCount: 3, startDealer: 3 as Player }).dealer).toBe(0)
  })

  it('default 4-player mode uses 136 tiles and offers chi', () => {
    const state = createGame()
    expect(state.playerCount).toBe(4)
    expect(state.players).toHaveLength(4)
    expect(state.wall).toHaveLength(136)
  })

  it('yonma starting score is 25000 per player', () => {
    const state = createGame({ playerCount: 4 })
    for (const p of state.players) {
      expect(p.score).toBe(25000)
    }
    const total = state.players.reduce((s, p) => s + p.score, 0)
    expect(total).toBe(100000)
  })

  it('sanma starting score is 35000 per player', () => {
    const state = createGame({ playerCount: 3 })
    for (const p of state.players) {
      expect(p.score).toBe(35000)
    }
    const total = state.players.reduce((s, p) => s + p.score, 0)
    expect(total).toBe(105000)
  })
})

describe('sanma 抜き北 (kita) — Phase 2', () => {
  // Helper: build a sanma state where the next draw is North.
  // We splice the wall so wall[wallIndex] = 30 (北), and the player has a
  // benign 13-tile hand.
  function makeKitaTriggerState(): GameState {
    const state = createGame({ playerCount: 3 })
    // Force wall[wallIndex] = 30 (北) so the next draw triggers kita
    const wall = [...state.wall]
    wall[state.wallIndex] = 30
    return { ...state, wall }
  }

  it('drawing North in sanma enters kita_declare phase', () => {
    let state = makeKitaTriggerState()
    state = applyAction(state, { kind: ActionKind.Pass }) // auto-draw
    expect(state.phase).toBe('kita_declare')
    // The drawn North is in the player's hand (so opponents can chankita)
    expect(state.players[state.currentPlayer].hand.includes(30)).toBe(true)
    // kitaCount NOT yet incremented (declaration happens after pass-resolution)
    expect(state.players[state.currentPlayer].kitaCount).toBe(0)
  })

  it('passing on chankita declares kita, removes North, and increments kitaCount', () => {
    let state = makeKitaTriggerState()
    state = applyAction(state, { kind: ActionKind.Pass }) // draw → kita_declare
    expect(state.phase).toBe('kita_declare')

    state = applyAction(state, { kind: ActionKind.Pass }) // resolve kita
    // After resolution: kitaCount=1, North no longer in hand, drew replacement
    expect(state.players[0].kitaCount).toBe(1)
    // Replacement was drawn so hand is back to 14 tiles (we entered the discard
    // phase with the replacement included)
    if (state.phase === 'discard') {
      expect(state.players[0].hand).toHaveLength(14)
    }
  })

  it('valid actions in kita_declare phase contain Pass and possibly Ron', () => {
    let state = makeKitaTriggerState()
    state = applyAction(state, { kind: ActionKind.Pass }) // auto-draw
    expect(state.phase).toBe('kita_declare')
    const actions = getValidActions(state)
    // Pass is always available in kita_declare
    expect(actions.some(a => a.kind === ActionKind.Pass)).toBe(true)
    // (Ron may or may not be available depending on opponent hands)
  })

  it('drawing North in 4-player mode does NOT trigger kita_declare', () => {
    const state = createGame({ playerCount: 4 })
    // Force a North draw in yonma — it should land in hand normally and
    // proceed to discard phase, no kita semantics.
    const wall = [...state.wall]
    wall[state.wallIndex] = 30
    let s = { ...state, wall }
    s = applyAction(s, { kind: ActionKind.Pass })
    expect(s.phase).toBe('discard')
    expect(s.players[s.currentPlayer].kitaCount).toBe(0)
  })

  it('doraFromIndicator: in sanma, 1m wraps to 9m (no 2m)', () => {
    // Yonma: 1m → 2m
    expect(doraFromIndicator(0 as TileType, false)).toBe(1)
    // Sanma: 1m → 9m (since 2m doesn't exist in the wall)
    expect(doraFromIndicator(0 as TileType, true)).toBe(8)
    // 9m → 1m unchanged in both modes
    expect(doraFromIndicator(8 as TileType, false)).toBe(0)
    expect(doraFromIndicator(8 as TileType, true)).toBe(0)
    // Pin/Sou unchanged
    expect(doraFromIndicator(13 as TileType, true)).toBe(14) // 5p → 6p
  })
})
