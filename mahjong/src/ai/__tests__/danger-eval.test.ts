import { describe, it, expect } from 'vitest'
import { assessDanger } from '../danger-eval'
import type { GameState, Player, PlayerState, TileType, Meld } from '../../game/types'

function makeState(overrides: Partial<{
  players: PlayerState[]
  doraMarkers: TileType[]
}> = {}): GameState {
  const defaultPlayer = (): PlayerState => ({
    hand: [], melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true,
    kitaCount: 0,
  })

  return {
    playerCount: 4, endRound: 8,
    wall: [], wallIndex: 0, rinshanIndex: 0,
    doraMarkers: overrides.doraMarkers ?? [],
    players: [
      overrides.players?.[0] ?? defaultPlayer(),
      overrides.players?.[1] ?? defaultPlayer(),
      overrides.players?.[2] ?? defaultPlayer(),
      overrides.players?.[3] ?? defaultPlayer(),
    ],
    currentPlayer: 0, dealer: 0, roundWind: 0, roundNumber: 1, honba: 0, kyotaku: 0,
    phase: 'discard', turnCount: 1,
    lastDiscard: null, lastDiscardPlayer: null, lastDrawnTile: null, ippatsu: false,
  }
}

function chiMeld(suit: number, startRank: number, calledFrom: Player = 1 as Player): Meld {
  const base = suit === 0 ? 0 : suit === 1 ? 9 : 18
  return {
    type: 'chi',
    tiles: [base + startRank - 1, base + startRank, base + startRank + 1],
    calledFrom,
  }
}

function ponMeld(tile: TileType, calledFrom: Player = 1 as Player): Meld {
  return { type: 'pon', tiles: [tile, tile, tile], calledFrom }
}

describe('assessDanger', () => {
  it('returns low danger when opponents have no melds and no discards', () => {
    const state = makeState()
    const danger = assessDanger(state, 0 as Player, 4 as TileType)
    expect(danger).toBeLessThan(0.3)
  })

  it('returns zero danger for tiles with no remaining copies (wall)', () => {
    const selfHand: TileType[] = [4, 0, 1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12]
    const state = makeState({
      players: [
        { hand: selfHand, melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
        { hand: [], melds: [], discards: [{ tile: 4 as TileType, tsumogiri: false }], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
        { hand: [], melds: [], discards: [{ tile: 4 as TileType, tsumogiri: false }], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
        { hand: [], melds: [], discards: [{ tile: 4 as TileType, tsumogiri: false }], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
      ],
    })
    // 5m (index 4): 1 in hand + 3 discards = 4 visible → 0 remaining → danger = 0
    const danger = assessDanger(state, 0 as Player, 4 as TileType)
    expect(danger).toBe(0)
  })

  it('returns zero danger for genbutsu against ALL opponents', () => {
    // After audit fix D, genbutsu is per-opponent. A tile is danger=0 only
    // if EVERY non-self opponent has discarded it (each is in furiten on it).
    const selfHand: TileType[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
    const drop5 = [{ tile: 5 as TileType, tsumogiri: false }]
    const state = makeState({
      players: [
        { hand: selfHand, melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
        { hand: [], melds: [], discards: drop5, riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
        { hand: [], melds: [], discards: drop5, riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
        { hand: [], melds: [], discards: drop5, riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
      ],
    })
    const danger = assessDanger(state, 0 as Player, 5 as TileType)
    expect(danger).toBe(0)
  })

  it('reduces danger for suji tiles relative to opponent discards', () => {
    // For per-opponent suji to actually lower the max risk, the suji
    // information must apply to the worst-case opponent. We give all three
    // opponents the same discard pattern (1m discarded). 4m is suji from 1m
    // for every opponent → suji lowers risk uniformly. 5m has no suji
    // relation, so its risk stays at the no-suji baseline.
    const selfHand: TileType[] = [0, 1, 2, 5, 6, 7, 8, 9, 10, 11, 12, 18, 19]
    const drop1m = [{ tile: 0 as TileType, tsumogiri: false }]
    const opp = (): PlayerState => ({
      hand: [], melds: [], discards: [...drop1m],
      riichi: false, riichiTurn: -1, score: 25000, isMenzen: true,
    })
    const state = makeState({
      players: [
        { hand: selfHand, melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
        opp(), opp(), opp(),
      ],
    })
    const dangerSuji = assessDanger(state, 0 as Player, 3 as TileType)    // 4m, suji of 1m
    const dangerNonSuji = assessDanger(state, 0 as Player, 4 as TileType) // 5m, not suji
    expect(dangerSuji).toBeLessThan(dangerNonSuji)
  })

  it('returns higher danger at later turns', () => {
    const selfHand: TileType[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
    const discards10 = Array.from({ length: 10 }, (_, i) => ({ tile: (i + 18) as TileType, tsumogiri: false }))
    const discards1 = [{ tile: 18 as TileType, tsumogiri: false }]

    const stateEarly = makeState({
      players: [
        { hand: selfHand, melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
        { hand: [], melds: [], discards: discards1, riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
        { hand: [], melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
        { hand: [], melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
      ],
    })
    const stateLate = makeState({
      players: [
        { hand: selfHand, melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
        { hand: [], melds: [], discards: discards10, riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
        { hand: [], melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
        { hand: [], melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
      ],
    })

    const dangerEarly = assessDanger(stateEarly, 0 as Player, 4 as TileType)
    const dangerLate = assessDanger(stateLate, 0 as Player, 4 as TileType)
    expect(dangerLate).toBeGreaterThan(dangerEarly)
  })

  it('reduces danger for honor tiles with few remaining copies', () => {
    const selfHand: TileType[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
    const state = makeState({
      players: [
        { hand: selfHand, melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
        { hand: [], melds: [chiMeld(1, 1), chiMeld(1, 4)], discards: [{ tile: 27 as TileType, tsumogiri: false }], riichi: false, riichiTurn: -1, score: 25000, isMenzen: false },
        { hand: [], melds: [], discards: [{ tile: 27 as TileType, tsumogiri: false }], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
        { hand: [], melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
      ],
    })
    // East wind with 2 discards (2 remaining) → lower danger
    const danger = assessDanger(state, 0 as Player, 27 as TileType)
    expect(danger).toBeLessThan(0.1)
  })

  it('returns higher danger for no-suji tiles vs suji tiles at same turn', () => {
    const selfHand: TileType[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
    // Opponent discarded 4m (index 3) → 1m (index 0) and 7m (index 6) are suji
    const state = makeState({
      players: [
        { hand: selfHand, melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
        { hand: [], melds: [], discards: [{ tile: 3 as TileType, tsumogiri: false }], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
        { hand: [], melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
        { hand: [], melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
      ],
    })
    // 1m (index 0) is suji from 4m (index 3) — should be safer
    const dangerSuji = assessDanger(state, 0 as Player, 0 as TileType)
    // 2m (index 1) is NOT suji from 4m — should be more dangerous
    const dangerNoSuji = assessDanger(state, 0 as Player, 1 as TileType)
    expect(dangerSuji).toBeLessThan(dangerNoSuji)
  })
})
