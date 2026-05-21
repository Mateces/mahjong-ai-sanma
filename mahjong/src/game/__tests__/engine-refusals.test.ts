/**
 * Negative tests: the engine must REFUSE actions in these situations.
 *
 * The replay-mjai pipeline only checks "engine accepts what really
 * happened in tenhou logs", so it can't catch the inverse class of
 * bugs — engine *offering* actions that aren't actually legal. These
 * tests target the most evaluation-impacting refusals: no-yaku wins,
 * furiten ron, and riichi locking the hand.
 */

import { describe, it, expect } from 'vitest'
import { createGame, getValidActions } from '../engine'
import { ActionKind } from '../types'
import type { GameState, Player, TileType, Meld } from '../types'

function makeDiscardPhase(
  concealed: TileType[],
  melds: Meld[],
  lastDrawn: TileType,
  opts: { dealer?: Player; current?: Player; riichi?: boolean; score?: number } = {},
): GameState {
  const state = createGame()
  const current = opts.current ?? 0
  const dealer = opts.dealer ?? 0
  const players = [...state.players] as GameState['players']
  players[current] = {
    ...players[current],
    hand: [...concealed].sort((a, b) => a - b),
    melds,
    riichi: opts.riichi ?? false,
    score: opts.score ?? 25000,
    isMenzen: melds.length === 0 || melds.every(m => m.type === 'ankan'),
  }
  return {
    ...state,
    players,
    currentPlayer: current,
    dealer,
    phase: 'discard',
    lastDrawnTile: lastDrawn,
  }
}

function makeRespondPhase(
  playerHands: TileType[][],
  playerMelds: Meld[][],
  discarder: Player,
  discardTile: TileType,
  opts: { dealer?: Player; perPlayerRiichi?: boolean[]; perPlayerDiscards?: TileType[][] } = {},
): GameState {
  const state = createGame()
  const players = [...state.players] as GameState['players']
  for (let p = 0; p < 4; p++) {
    const hand = playerHands[p] ?? []
    const melds = playerMelds[p] ?? []
    players[p] = {
      ...players[p],
      hand: [...hand].sort((a, b) => a - b),
      melds,
      riichi: opts.perPlayerRiichi?.[p] ?? false,
      isMenzen: melds.length === 0 || melds.every(m => m.type === 'ankan'),
      discards: (opts.perPlayerDiscards?.[p] ?? []).map(t => ({ tile: t, tsumogiri: false })),
    }
  }
  return {
    ...state,
    players,
    currentPlayer: discarder,
    dealer: opts.dealer ?? 0,
    phase: 'respond',
    lastDiscard: discardTile,
    lastDiscardPlayer: discarder,
    lastDrawnTile: discardTile,
  }
}

describe('Tsumo / Ron — no-yaku refusal', () => {
  it('refuses Tsumo on an open hand with no yaku (no tanyao, no ittsu, no yakuhai)', () => {
    // chi 1m2m3m (terminal-containing meld → no tanyao) +
    // concealed 5m6m7m + 4p5p6p + 7p8p9p + 6m6m (pair).
    // Pair 6m, not yakuhai. Open → no pinfu, no menzen_tsumo.
    // Ittsu needs 1-4-7 ranks in same suit — we have m suit 1-3 (chi)
    // and 5-7 (concealed), missing 7-8-9 → NO ittsu.
    const state = makeDiscardPhase(
      [4, 5, 6, 12, 13, 14, 15, 16, 17, 5, 5], // 5m6m7m 4p5p6p 7p8p9p 6m6m (11 tiles)
      [{ type: 'chi', tiles: [0, 1, 2], calledFrom: 1 }],
      5,
    )
    const actions = getValidActions(state)
    expect(actions.find(a => a.kind === ActionKind.Tsumo)).toBeUndefined()
  })

  it('allows Tsumo when the same shape closed gives menzen_tsumo + tanyao', () => {
    // 14-tile closed shape, all simples (2-8 only): 2m3m4m + 5m6m7m +
    // 4p5p6p + 6p7p8p + 6m6m pair. Closed → menzen_tsumo. No terminals →
    // tanyao. 2 han minimum.
    // 2m3m4m (1,2,3) + 5m6m7m (4,5,6) + 4p5p6p (12,13,14) + 6p7p8p (14,15,16)
    // + 6m6m pair (5,5) = 14 tiles.
    const state = makeDiscardPhase(
      [1, 2, 3, 4, 5, 6, 12, 13, 14, 14, 15, 16, 5, 5],
      [],
      5,
    )
    const actions = getValidActions(state)
    expect(actions.find(a => a.kind === ActionKind.Tsumo)).toBeDefined()
  })

  it('refuses Ron on a no-yaku open hand', () => {
    // P0 chi 1m2m3m + concealed 5m6m + 4p5p6p + 7p8p9p + 6m6m, P1 discards
    // 7m → completes 5m6m7m. No yaku per the analysis above.
    const concealed = [4, 5, 12, 13, 14, 15, 16, 17, 5, 5]
    const state = makeRespondPhase(
      [concealed, [], [], []],
      [[{ type: 'chi', tiles: [0, 1, 2], calledFrom: 1 }], [], [], []],
      1,
      6, // P1 discards 7m
    )
    const actions = getValidActions(state)
    expect(actions.find(a => a.kind === ActionKind.Ron)).toBeUndefined()
  })
})

describe('Ron — furiten refusal', () => {
  it('refuses Ron when responder previously discarded a winning-wait tile', () => {
    // P0 closed shape with shanpon wait on 1m or 4m:
    //   1m1m + 2m3m + 4p5p6p + 7p8p9p + 1s2s3s + 4s5s6s (13 tiles, tenpai
    //   shanpon? Let me redo: 1m1m4m4m + 4 sequences → shanpon 1m/4m wait
    //   needs 2 pairs + 3 mentsu = 4 mentsu + pair structure with one pair
    //   completed by the win tile.
    // Cleaner: 4 sequences + tanki on 4m. Discards include 4m → furiten.
    //   2m3m4m + 5m6m7m + 4p5p6p + 7p8p9p + 4m (tanki). 13 tiles. Wait: 4m
    //   already in the first mentsu. So tanki on 4m = win 4m completes
    //   4m,4m pair. Discards include 4m → furiten.
    const tenpai = [1, 2, 3, 4, 5, 6, 12, 13, 14, 15, 16, 17, 3]
    const state = makeRespondPhase(
      [tenpai, [], [], []],
      [[], [], [], []],
      1,
      3, // P1 discards 4m
      { perPlayerDiscards: [[3], [], [], []] }, // P0 already discarded 4m → furiten
    )
    const actions = getValidActions(state)
    expect(
      actions.find(a => a.kind === ActionKind.Ron),
      'furiten responder must not be offered Ron',
    ).toBeUndefined()
  })

  it('allows Ron when responder has not discarded any wait tile', () => {
    // Same shape, but P0 has NOT discarded 4m → ron is legal (tanyao + pinfu
    // possible if waits ryanmen, but tanki tanki gives at least menzen tsumo
    // for tsumo only; for ron we need yaku. Closed tanyao alone is enough.)
    const tenpai = [1, 2, 3, 4, 5, 6, 12, 13, 14, 15, 16, 17, 3]
    const state = makeRespondPhase(
      [tenpai, [], [], []],
      [[], [], [], []],
      1,
      3,
      { perPlayerDiscards: [[], [], [], []] }, // clean discards
    )
    const actions = getValidActions(state)
    expect(actions.find(a => a.kind === ActionKind.Ron)).toBeDefined()
  })
})

describe('Riichi locks the hand — engine must refuse chi/pon/daiminkan from riichi player', () => {
  it('refuses Chi by a riichi-declared next-seat player', () => {
    const state = makeRespondPhase(
      [[], [3, 5, 1, 2, 4, 12, 13, 14, 15, 16, 17, 5, 5], [], []],
      [[], [], [], []],
      0,
      4, // P0 discards 5m
      { perPlayerRiichi: [false, true, false, false] },
    )
    const actions = getValidActions(state)
    expect(actions.find(a => a.kind === ActionKind.Chi)).toBeUndefined()
  })

  it('refuses Pon by a riichi-declared player who holds the pair', () => {
    const state = makeRespondPhase(
      [[], [], [4, 4, 0, 1, 2, 12, 13, 14, 15, 16, 17, 18, 19], []],
      [[], [], [], []],
      0,
      4,
      { perPlayerRiichi: [false, false, true, false] },
    )
    const actions = getValidActions(state)
    expect(actions.find(a => a.kind === ActionKind.Pon)).toBeUndefined()
  })

  it('refuses Daiminkan by a riichi-declared player who holds the triple', () => {
    const state = makeRespondPhase(
      [[], [], [4, 4, 4, 0, 1, 2, 12, 13, 14, 15, 16, 17, 18], []],
      [[], [], [], []],
      0,
      4,
      { perPlayerRiichi: [false, false, true, false] },
    )
    const actions = getValidActions(state)
    expect(actions.find(a => a.kind === ActionKind.Daiminkan)).toBeUndefined()
  })
})
