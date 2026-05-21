import { describe, it, expect } from 'vitest'
import { evaluateWin, previewWin } from '../win-evaluation'
import type { GameState, PlayerState, TileType, Player, Wind } from '../types'

function makePlayer(overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    hand: [],
    melds: [],
    discards: [],
    riichi: false,
    riichiTurn: 0,
    score: 25000,
    isMenzen: true,
    kitaCount: 0,
    ...overrides,
  }
}

function makeState(overrides: Partial<GameState> = {}): GameState {
  // Default: yonma, 4 menzen players, dora indicator 0 (1m → 2m dora).
  const playerCount = (overrides.playerCount ?? 4) as 3 | 4
  const startingScore = playerCount === 3 ? 35000 : 25000
  const defaultPlayers = Array.from({ length: playerCount }, () =>
    makePlayer({ score: startingScore })
  ) as GameState['players']

  return {
    playerCount,
    endRound: 8,
    wall: [],
    wallIndex: 0,
    rinshanIndex: 0,
    doraMarkers: [0],
    players: defaultPlayers,
    currentPlayer: 0 as Player,
    dealer: 0 as Player,
    roundWind: 0 as Wind,
    roundNumber: 1,
    honba: 0,
    kyotaku: 0,
    phase: 'discard',
    turnCount: 5, // past first-turn so tenhou/daburii don't fire by default
    lastDiscard: null,
    lastDiscardPlayer: null,
    lastDrawnTile: null,
    ippatsu: false,
    ...overrides,
  }
}

describe('evaluateWin', () => {
  it('pinhu tsumo: yakuHan = 2 (pinhu + menzen tsumo), fu = 20', () => {
    // 1m2m3m 7m8m9m 2p3p4p 6p7p8p 6s6s, tsumo 9m? No — too many 9m.
    // Pick: 1m2m3m 7m8m9m 2p3p4p 6p7p 6s6s, tsumo 8p (ryanmen high of 6p7p).
    // 14 tiles total (tsumo). Pinhu (all sequences, simple pair, ryanmen).
    // No ikkitsuukan (no 4m5m6m). Indicator 31 (haku) → dora 32 → not in hand.
    const hand: TileType[] = [0, 1, 2, 6, 7, 8, 10, 11, 12, 14, 15, 16, 23, 23]
    const players = [
      makePlayer({ hand }),
      makePlayer(),
      makePlayer(),
      makePlayer(),
    ] as GameState['players']

    const state = makeState({
      doraMarkers: [31], // haku → hatsu dora (not in hand)
      players,
    })

    const result = evaluateWin(state, 0 as Player, true, 16 as TileType)
    expect(result.hasYaku).toBe(true)
    expect(result.yakuList.some(y => y.name === 'pinhu')).toBe(true)
    expect(result.yakuList.some(y => y.name === 'menzen_tsumo')).toBe(true)
    expect(result.yakuHan).toBe(2)
    expect(result.doraCount).toBe(0)
    expect(result.totalHan).toBe(2)
    expect(result.fu).toBe(20)
  })

  it('riichi + pinhu tsumo: yakuHan = 3', () => {
    const hand: TileType[] = [0, 1, 2, 6, 7, 8, 10, 11, 12, 14, 15, 16, 23, 23]
    const players = [
      makePlayer({ hand, riichi: true }),
      makePlayer(),
      makePlayer(),
      makePlayer(),
    ] as GameState['players']

    const state = makeState({
      doraMarkers: [31],
      players,
    })

    const result = evaluateWin(state, 0 as Player, true, 16 as TileType)
    expect(result.hasYaku).toBe(true)
    expect(result.yakuList.some(y => y.name === 'riichi')).toBe(true)
    expect(result.yakuList.some(y => y.name === 'pinhu')).toBe(true)
    expect(result.yakuList.some(y => y.name === 'menzen_tsumo')).toBe(true)
    expect(result.yakuHan).toBe(3)
  })

  it('sanma: 1 kita yields doraCount = 1 (no other dora)', () => {
    // Sanma winning hand. tiles 1m=0, 9m=8, pin 10..17, sou 18..26, honors
    // 27..33. Avoid 2m-8m (1..7). Pick a yakuhai-haku (31) hand.
    // 14-tile (tsumo) hand: 1m1m 2p3p4p 6p7p8p 5s6s7s 31 31 31
    // That's 2+3+3+3+3 = 14. Winning tile = 31 (last copy).
    const hand: TileType[] = [0, 0, 10, 11, 12, 14, 15, 16, 22, 23, 24, 31, 31, 31]
    const players = [
      makePlayer({ hand, kitaCount: 1 }),
      makePlayer(),
      makePlayer(),
    ] as GameState['players']

    const state = makeState({
      playerCount: 3,
      doraMarkers: [27], // East indicator → South dora; not in our hand
      players,
    })

    const result = evaluateWin(state, 0 as Player, true, 31 as TileType)
    expect(result.hasYaku).toBe(true)
    expect(result.yakuList.some(y => y.name === 'yakuhai_haku')).toBe(true)
    expect(result.doraCount).toBe(1) // 1 kita
  })

  it('sanma: 1 kita with West indicator (dora = North) yields doraCount = 2', () => {
    const hand: TileType[] = [0, 0, 10, 11, 12, 14, 15, 16, 22, 23, 24, 31, 31, 31]
    const players = [
      makePlayer({ hand, kitaCount: 1 }),
      makePlayer(),
      makePlayer(),
    ] as GameState['players']

    const state = makeState({
      playerCount: 3,
      doraMarkers: [29], // West → North dora
      players,
    })

    const result = evaluateWin(state, 0 as Player, true, 31 as TileType)
    expect(result.hasYaku).toBe(true)
    // 1 kita itself + 1 because the dora (North) "matches" the kita
    expect(result.doraCount).toBe(2)
  })

  it('no yaku: hasYaku = false (open tanyao with no other yaku in sanma where tanyao impossible — use yonma open hand without yaku)', () => {
    // Yonma open hand: pon of 2m + chi 3p4p5p + chi 6s7s8s + 1m1m + tanki on
    // 2m? Open, no riichi. Open hand with only sequences/triplets that
    // produce no yaku.
    // Actual: open chi 1p2p3p, chi 4p5p6p, chi 7p8p9p, hand: 5m5m winning
    // 1m → 1m,5m,5m + 3 chi. That's 11 tiles + 3*3 = 9 in melds = 13 in hand?
    // Let me just construct: melds [chi 1p2p3p called from 1, chi 4p5p6p, chi
    // 7p8p9p], hand 13 - 9 = 4 tiles before win + 1 = 5. But we need 4 tile
    // pair and pon. Easier:
    // 4 melds called (open) + pair. e.g. pon 1m, pon 5p, pon 1s, pon 5s,
    // plus pair 9m. Hand = 9m 9m. No yaku because: not toitoi (toitoi YES
    // here actually). Hmm.
    //
    // Try: chi 2m3m4m, chi 5m6m7m, chi 2p3p4p, chi 5p6p7p, pair 4s. Open
    // hand all sequences with non-yakuhai pair. tanyao? 2m4m5m6m7m all
    // simples; 4s simple. So tanyao = 1 han. Open tanyao IS a yaku.
    // To make it no-yaku: include a terminal. chi 1m2m3m, chi 5m6m7m,
    // chi 2p3p4p, chi 5p6p7p, pair 4s. 1m is terminal so no tanyao.
    // No riichi (player isn't menzen). Pinhu requires menzen → no.
    // Iipeikou requires menzen → no. No yakuhai. Open + sequences + simple
    // pair. → No yaku.
    const meld1 = { type: 'chi' as const, tiles: [0, 1, 2] as TileType[], calledFrom: 1 as Player }
    const meld2 = { type: 'chi' as const, tiles: [4, 5, 6] as TileType[], calledFrom: 1 as Player }
    const meld3 = { type: 'chi' as const, tiles: [10, 11, 12] as TileType[], calledFrom: 1 as Player }
    const meld4 = { type: 'chi' as const, tiles: [13, 14, 15] as TileType[], calledFrom: 1 as Player }
    // hand has just the pair tile (4s = 21), waiting to win on 4s = tanki
    const hand: TileType[] = [21]
    const players = [
      makePlayer({ hand, melds: [meld1, meld2, meld3, meld4], isMenzen: false }),
      makePlayer(),
      makePlayer(),
      makePlayer(),
    ] as GameState['players']

    const state = makeState({ doraMarkers: [33], players })
    const result = evaluateWin(state, 0 as Player, false, 21 as TileType)
    expect(result.hasYaku).toBe(false)
  })

  it('yakuman: doraCount excluded from totalHan', () => {
    // Daisangen: triplets of all 3 dragons + 2 sequences + pair
    // 31 31 31 32 32 32 33 33 33 0 1 2 5 5 (winning 5m → tanki on 6m? or
    // 4m completes seq?) Easy version: hand 31 31 31 32 32 32 33 33 33
    // 0 1 2 5 5 — tsumo 5m on tanki. Win = 14, all decomposes. Yaku:
    // daisangen (yakuman). Even if dora indicator = 1m → 2m dora and we have
    // 2m, totalHan should be 13.
    const hand: TileType[] = [0, 1, 2, 5, 5, 31, 31, 31, 32, 32, 32, 33, 33, 33]
    const players = [
      makePlayer({ hand }),
      makePlayer(),
      makePlayer(),
      makePlayer(),
    ] as GameState['players']

    const state = makeState({ doraMarkers: [0], players })
    const result = evaluateWin(state, 0 as Player, true, 5 as TileType)
    expect(result.isYakuman).toBe(true)
    expect(result.hasYaku).toBe(true)
    expect(result.totalHan).toBe(13)
  })
})

describe('previewWin', () => {
  it('returns true when hand has yaku (riichi)', () => {
    const hand: TileType[] = [0, 1, 2, 6, 7, 8, 10, 11, 12, 14, 15, 16, 23, 23]
    const players = [
      makePlayer({ hand, riichi: true }),
      makePlayer(),
      makePlayer(),
      makePlayer(),
    ] as GameState['players']
    const state = makeState({ players })
    expect(previewWin(state, 0 as Player, true, 16 as TileType)).toBe(true)
  })

  it('returns false for open no-yaku hand', () => {
    const meld1 = { type: 'chi' as const, tiles: [0, 1, 2] as TileType[], calledFrom: 1 as Player }
    const meld2 = { type: 'chi' as const, tiles: [4, 5, 6] as TileType[], calledFrom: 1 as Player }
    const meld3 = { type: 'chi' as const, tiles: [10, 11, 12] as TileType[], calledFrom: 1 as Player }
    const meld4 = { type: 'chi' as const, tiles: [13, 14, 15] as TileType[], calledFrom: 1 as Player }
    const hand: TileType[] = [21]
    const players = [
      makePlayer({ hand, melds: [meld1, meld2, meld3, meld4], isMenzen: false }),
      makePlayer(),
      makePlayer(),
      makePlayer(),
    ] as GameState['players']
    const state = makeState({ players })
    expect(previewWin(state, 0 as Player, false, 21 as TileType)).toBe(false)
  })
})
