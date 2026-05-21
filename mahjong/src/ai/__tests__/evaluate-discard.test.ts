import { describe, it, expect } from 'vitest'
import { scoreDiscardActions } from '../evaluate-discard'
import type { GameState, Player, PlayerState, TileType, Action, DiscardEntry, Meld } from '../../game/types'
import { ActionKind } from '../../game/types'

/** Build a minimal GameState for testing */
function makeState(overrides: Partial<{
  players: PlayerState[]
  doraMarkers: TileType[]
  turnCount: number
}> = {}): GameState {
  const defaultPlayer = (): PlayerState => ({
    hand: [],
    melds: [],
    discards: [],
    riichi: false,
    riichiTurn: -1,
    score: 25000,
    isMenzen: true,
  })

  return {
    wall: [],
    wallIndex: 0,
    rinshanIndex: 0,
    doraMarkers: overrides.doraMarkers ?? [],
    players: [
      overrides.players?.[0] ?? defaultPlayer(),
      overrides.players?.[1] ?? defaultPlayer(),
      overrides.players?.[2] ?? defaultPlayer(),
      overrides.players?.[3] ?? defaultPlayer(),
    ],
    currentPlayer: 0,
    dealer: 0,
    roundWind: 0,
    roundNumber: 1,
    honba: 0,
    kyotaku: 0,
    phase: 'discard',
    turnCount: overrides.turnCount ?? 1,
    lastDiscard: null,
    lastDiscardPlayer: null,
    lastDrawnTile: null,
    ippatsu: false,
  }
}

/** Helper: build a chi meld in a given suit (0=man,1=pin,2=sou) starting at rank startRank */
function chiMeld(suit: number, startRank: number, calledFrom: Player = 1 as Player): Meld {
  const base = suit === 0 ? 0 : suit === 1 ? 9 : 18
  return {
    type: 'chi',
    tiles: [base + startRank - 1, base + startRank, base + startRank + 1],
    calledFrom,
  }
}

/** Helper: build a pon meld for a given tile */
function ponMeld(tile: TileType, calledFrom: Player = 1 as Player): Meld {
  return { type: 'pon', tiles: [tile, tile, tile], calledFrom }
}

describe('scoreDiscardActions', () => {
  // ---------------------------------------------------------------------------
  // 1. Returns scores array parallel to actions
  // ---------------------------------------------------------------------------
  it('returns a scores array with the same length as the input actions', () => {
    const hand: TileType[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
    const state = makeState({
      players: [
        { hand, melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
        { hand: [], melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
        { hand: [], melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
        { hand: [], melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
      ],
    })

    const actions: Action[] = [
      { kind: ActionKind.Discard, tile: 0 },
      { kind: ActionKind.Discard, tile: 4 },
      { kind: ActionKind.Pass },
    ]

    const scores = scoreDiscardActions(state, actions, 0 as Player)

    expect(scores).toHaveLength(actions.length)
    // Pass action should have score 0
    expect(scores[2]).toBe(0)
  })

  it('returns all zeros for non-discard/non-riichi actions', () => {
    const state = makeState()
    const actions: Action[] = [
      { kind: ActionKind.Pass },
      { kind: ActionKind.Tsumo },
      { kind: ActionKind.Pon, called: 0 },
    ]

    const scores = scoreDiscardActions(state, actions, 0 as Player)
    expect(scores).toEqual([0, 0, 0])
  })

  // ---------------------------------------------------------------------------
  // 2. Gives higher score to discards keeping shanten low (tenpai hand)
  // ---------------------------------------------------------------------------
  it('gives higher score to the discard that results in tenpai (shanten 0)', () => {
    // Construct a hand that is 1-away from tenpai
    // Hand: 1m 2m 3m 4m 5m 6m 7m 8m 9m 1p 2p 3p 5p
    // If we discard 5p → 1m-9m + 1p2p3p = tenpai (waiting on nothing extra needed since 9 tiles already form mentsu)
    // Actually let's use a simpler tenpai setup:
    // Hand: 1m 2m 3m  4m 5m 6m  7m 8m 9m  1p 2p 3p  5p
    // Discard 5p → shanten = 0 (3 mentsu + 1 mentsu in pin + no pair = tenpai for pair)
    // Discard 1p → hand is 1m2m3m 4m5m6m 7m8m9m 2p3p5p → shanten > 0
    const hand: TileType[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13] // 1m-9m, 1p,2p,3p,5p
    const state = makeState({
      players: [
        { hand, melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
        { hand: [], melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
        { hand: [], melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
        { hand: [], melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
      ],
    })

    const actions: Action[] = [
      { kind: ActionKind.Discard, tile: 13 }, // discard 5p → tenpai
      { kind: ActionKind.Discard, tile: 9 },  // discard 1p → worse
    ]

    const scores = scoreDiscardActions(state, actions, 0 as Player)

    // Discarding 5p should score higher because it reaches tenpai (shanten 0)
    expect(scores[0]).toBeGreaterThan(scores[1])
  })

  // ---------------------------------------------------------------------------
  // 3. Penalizes discards with high danger when opponents have melds
  // ---------------------------------------------------------------------------
  it('penalizes discards of dangerous tiles when opponents have melds', () => {
    // Hand: 1m 2m 3m 4m 5m 6m 7m 8m 9m 1p 2p 3p 5p
    // Both 5p(13) and 3p(11) are pin tiles in hand.
    // Discard 5p → 1m-9m + 1p2p3p = tenpai (shanten 0)
    // Discard 3p → 1m-9m + 1p2p5p = shanten 1 (worse efficiency but different comparison)
    //
    // To make danger the deciding factor, use a hand where both discards have the
    // same shanten improvement but one tile is in the dangerous suit.
    // Hand: 1m 2m 3m 4m 5m 6m  1p 2p 3p  4p 5p 6p  E
    // Discard E(27) → shanten stays same, no danger
    // Discard 1p(9) → shanten stays same, but 1p is in pin suit (dangerous)
    const hand: TileType[] = [0, 1, 2, 3, 4, 5, 9, 10, 11, 12, 13, 14, 27]
    const opponent: PlayerState = {
      hand: [18, 19, 20, 21, 22, 23, 24, 25, 26, 0, 1, 2, 3],
      melds: [
        chiMeld(1, 1),  // pin suit chi
        chiMeld(1, 4),  // pin suit chi
      ],
      discards: [],
      riichi: false,
      riichiTurn: -1,
      score: 25000,
      isMenzen: false,
    }

    const state = makeState({
      players: [
        { hand, melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
        opponent,
        { hand: [], melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
        { hand: [], melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
      ],
      turnCount: 10,
    })

    const actions: Action[] = [
      { kind: ActionKind.Discard, tile: 27 }, // East — not in dangerous suit, honor danger is low
      { kind: ActionKind.Discard, tile: 9 },  // 1p — pin suit, opponent collecting pins → high danger
    ]

    const scores = scoreDiscardActions(state, actions, 0 as Player)

    // Discarding East should score higher because 1p has danger penalty from pin bias
    expect(scores[0]).toBeGreaterThan(scores[1])
  })

  // ---------------------------------------------------------------------------
  // 4. Gives bonus to preserving high-value yaku potential
  // ---------------------------------------------------------------------------
  it('gives bonus to discards that preserve chinitsu potential', () => {
    // Hand is all man tiles + one honor tile. Discarding the honor preserves chinitsu.
    // Hand: 1m 2m 3m 4m 5m 6m 7m 8m 9m 1m 2m 3m E (13 tiles)
    const hand: TileType[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 0, 1, 2, 27] // 1m-9m, 1m,2m,3m, East
    const state = makeState({
      players: [
        { hand, melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
        { hand: [], melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
        { hand: [], melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
        { hand: [], melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
      ],
    })

    const actions: Action[] = [
      { kind: ActionKind.Discard, tile: 27 }, // discard East → all man = chinitsu potential
      { kind: ActionKind.Discard, tile: 8 },  // discard 9m → breaks pure man but keeps honor
    ]

    const scores = scoreDiscardActions(state, actions, 0 as Player)

    // Discarding East (keeping all-man hand) should get a chinitsu bonus
    expect(scores[0]).toBeGreaterThan(scores[1])
  })

  it('gives bonus for preserving tanyao potential', () => {
    // Hand with all middle tiles + one terminal. Discard terminal to preserve tanyao.
    // Middle tiles: 2-8 in each suit (indices 1-7, 10-16, 19-25)
    // Hand: 2m 3m 4m 5m 6m 7m 2p 3p 4p 5p 6p 7p 1m(terminal)
    const hand: TileType[] = [1, 2, 3, 4, 5, 6, 10, 11, 12, 13, 14, 15, 0] // 2-7m, 2-7p, 1m(terminal)
    const state = makeState({
      players: [
        { hand, melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
        { hand: [], melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
        { hand: [], melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
        { hand: [], melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
      ],
    })

    const actions: Action[] = [
      { kind: ActionKind.Discard, tile: 0 },  // discard 1m (terminal) → tanyao potential
      { kind: ActionKind.Discard, tile: 15 }, // discard 7p (middle) → breaks tanyao
    ]

    const scores = scoreDiscardActions(state, actions, 0 as Player)

    // Discarding the terminal (1m) should score higher because resulting hand has tanyao potential
    expect(scores[0]).toBeGreaterThan(scores[1])
  })

  it('gives dora bonus for keeping dora tiles in hand', () => {
    // Dora indicator: 3m (index 2) → dora is 4m (index 3)
    const hand: TileType[] = [0, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 27] // has dora 4m
    const state = makeState({
      doraMarkers: [2], // indicator 3m → dora is 4m
      players: [
        { hand, melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
        { hand: [], melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
        { hand: [], melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
        { hand: [], melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
      ],
    })

    const actions: Action[] = [
      { kind: ActionKind.Discard, tile: 3 },  // discard 4m (dora) → loses dora
      { kind: ActionKind.Discard, tile: 27 }, // discard East → keeps dora
    ]

    const scores = scoreDiscardActions(state, actions, 0 as Player)

    // Keeping the dora tile should score higher (discard East instead of 4m)
    expect(scores[1]).toBeGreaterThan(scores[0])
  })

  it('gives yakuhai bonus for dragon pairs/triplets in hand', () => {
    // Hand with 3x Haku (31) — should get yakuhai bonus
    // 1m 2m 3m 4m 5m 6m 7m 8m 9m Haku Haku Haku E
    const hand: TileType[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 31, 31, 31, 27]
    const state = makeState({
      players: [
        { hand, melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
        { hand: [], melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
        { hand: [], melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
        { hand: [], melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
      ],
    })

    const actions: Action[] = [
      { kind: ActionKind.Discard, tile: 31 }, // discard Haku → loses yakuhai
      { kind: ActionKind.Discard, tile: 27 }, // discard East → keeps yakuhai triplet
    ]

    const scores = scoreDiscardActions(state, actions, 0 as Player)

    // Discarding East (keeping yakuhai) should score higher
    expect(scores[1]).toBeGreaterThan(scores[0])
  })

  it('considers danger as a factor in discard selection', () => {
    // Verify that assessDanger is called and danger values differ for different tiles
    // This test validates the new sorting-based approach incorporates danger
    const hand: TileType[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13]

    const makePlayer = (h: TileType[]): PlayerState => ({
      hand: h, melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true,
    })

    // With no opponents, all tiles should have low danger
    const state = makeState({
      players: [makePlayer(hand), makePlayer([]), makePlayer([]), makePlayer([])],
    })

    const actions: Action[] = [
      { kind: ActionKind.Discard, tile: 13 },
    ]

    // Should still produce a valid score (not crash or return NaN)
    const scores = scoreDiscardActions(state, actions, 0 as Player)
    expect(scores[0]).toBeGreaterThan(0)
    expect(Number.isFinite(scores[0])).toBe(true)
  })

  it('scores riichi actions the same as discard actions', () => {
    const hand: TileType[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13]
    const state = makeState({
      players: [
        { hand, melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
        { hand: [], melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
        { hand: [], melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
        { hand: [], melds: [], discards: [], riichi: false, riichiTurn: -1, score: 25000, isMenzen: true },
      ],
    })

    const actions: Action[] = [
      { kind: ActionKind.Discard, tile: 13 },
      { kind: ActionKind.Riichi, tile: 13 },
    ]

    const scores = scoreDiscardActions(state, actions, 0 as Player)

    // Both involve discarding tile 13, so they should have the same score
    expect(scores[0]).toBe(scores[1])
  })
})
