import { describe, it, expect } from 'vitest'
import { evaluateYaku } from '../yaku'
import { calculatePoints } from '../scoring'
import type { TileType, PlayerState, Wind } from '../types'

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

const baseCtx = {
  roundWind: 0 as Wind,
  seatWind: 0 as Wind,
  isTsumo: false,
  isRiichi: false,
  isIppatsu: false,
  isRinshan: false,
  isChankan: false,
  isHaitei: false,
  isHoutei: false,
  isFirstTurn: false,
  koyakuMode: false,
}

describe('純正九蓮宝燈 (junsei chuuren) — always-on W yakuman', () => {
  it('detects junsei when 13-tile hand is the perfect [3,1,...,3] shape', () => {
    // 13-tile hand: 1112345678999m. Winning tile is 1m (the "extra" matches
    // a position in the pattern, so removing it still leaves the perfect shape).
    const hand: TileType[] = [0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 8, 8]
    const result = evaluateYaku({
      ...baseCtx,
      hand,
      melds: [],
      winningTile: 0,
      player: makePlayer({ hand }),
    })
    expect(result.isYakuman).toBe(true)
    expect(result.yaku.some(y => y.name === 'junsei_chuuren')).toBe(true)
    expect(result.yaku.some(y => y.name === 'chuuren')).toBe(false)
    expect(result.totalHan).toBe(26)
  })

  it('junsei wins on any of the 9 suit tiles (here: 5m)', () => {
    // 13-tile pattern + winning on 5m: 11123455678999m
    const hand: TileType[] = [0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 8, 8]
    const result = evaluateYaku({
      ...baseCtx,
      hand,
      melds: [],
      winningTile: 4, // 5m
      player: makePlayer({ hand }),
    })
    expect(result.isYakuman).toBe(true)
    expect(result.yaku.some(y => y.name === 'junsei_chuuren')).toBe(true)
  })

  it('detects regular chuuren when 13-tile hand is NOT the perfect shape', () => {
    // 14-tile: 11122345678999m (extra 2m). 13-tile (subtract winning 2m) =
    // 1112345678999m — wait, that would be junsei. To get non-junsei the
    // 13-tile must differ from the perfect pattern by one tile.
    // Construct: 13-tile = 11122345678999m (extra 2m, missing one position?).
    // Counts: [3,2,1,1,1,1,1,1,3] = 14, not 13. Hmm.
    // Correct non-junsei: 13-tile = [3,2,1,1,1,1,1,1,2] -> need to wait on 9m
    // to make [3,2,1,1,1,1,1,1,3]. Sum 13. Winning tile = 9m (8).
    const hand: TileType[] = [0, 0, 0, 1, 1, 2, 3, 4, 5, 6, 7, 8, 8]
    const result = evaluateYaku({
      ...baseCtx,
      hand,
      melds: [],
      winningTile: 8, // 9m
      player: makePlayer({ hand }),
    })
    expect(result.isYakuman).toBe(true)
    expect(result.yaku.some(y => y.name === 'chuuren')).toBe(true)
    expect(result.yaku.some(y => y.name === 'junsei_chuuren')).toBe(false)
    expect(result.totalHan).toBe(13)
  })
})

describe('大七星 (daichisei) — 古役 W yakuman', () => {
  // Hand: 2 of each of the 7 honors = 14 tiles, chiitoi shape, all honors.
  // 13-tile + winning tile. Hand = [27,27,28,28,29,29,30,30,31,31,32,32,33], win=33.
  const daichiseiHand: TileType[] = [27, 27, 28, 28, 29, 29, 30, 30, 31, 31, 32, 32, 33]

  it('without koyakuMode: same hand scores as 字一色 (single yakuman)', () => {
    const result = evaluateYaku({
      ...baseCtx,
      hand: daichiseiHand,
      melds: [],
      winningTile: 33,
      koyakuMode: false,
      player: makePlayer({ hand: daichiseiHand }),
    })
    expect(result.isYakuman).toBe(true)
    expect(result.yaku.some(y => y.name === 'tsuuiisou')).toBe(true)
    expect(result.yaku.some(y => y.name === 'daichisei')).toBe(false)
    expect(result.totalHan).toBe(13)
  })

  it('with koyakuMode: same hand scores as 大七星 (W yakuman), tsuuiisou suppressed', () => {
    const result = evaluateYaku({
      ...baseCtx,
      hand: daichiseiHand,
      melds: [],
      winningTile: 33,
      koyakuMode: true,
      player: makePlayer({ hand: daichiseiHand }),
    })
    expect(result.isYakuman).toBe(true)
    expect(result.yaku.some(y => y.name === 'daichisei')).toBe(true)
    expect(result.yaku.some(y => y.name === 'tsuuiisou')).toBe(false)
    expect(result.totalHan).toBe(26)
  })

  it('koyakuMode does not affect 字一色 of regular (non-chiitoi) shape', () => {
    // Regular shape: 4 honor triplets + honor pair (need 14 tiles, all honors).
    // E.g., 27,27,27, 28,28,28, 29,29,29, 30,30,30, 31, win=31
    const hand: TileType[] = [27, 27, 27, 28, 28, 28, 29, 29, 29, 30, 30, 30, 31]
    const result = evaluateYaku({
      ...baseCtx,
      hand,
      melds: [],
      winningTile: 31,
      koyakuMode: true,
      player: makePlayer({ hand }),
    })
    expect(result.isYakuman).toBe(true)
    expect(result.yaku.some(y => y.name === 'tsuuiisou')).toBe(true)
    expect(result.yaku.some(y => y.name === 'daichisei')).toBe(false)
  })
})

describe('multi-yakuman scoring', () => {
  it('basicPoints scales with yakuman multiplier (han=26 → 16000 basic)', () => {
    const result = calculatePoints({ han: 26, fu: 30, isDealer: false, isTsumo: false })
    // child W yakuman ron: basic 16000 × 4 = 64000
    expect(result.basicPoints).toBe(16000)
    expect(result.ronPayment).toBe(64000)
  })

  it('basicPoints scales for triple yakuman (han=39 → 24000 basic)', () => {
    const result = calculatePoints({ han: 39, fu: 30, isDealer: false, isTsumo: false })
    expect(result.basicPoints).toBe(24000)
  })

  it('single yakuman (han=13) unchanged: basic 8000', () => {
    const result = calculatePoints({ han: 13, fu: 30, isDealer: false, isTsumo: false })
    expect(result.basicPoints).toBe(8000)
    expect(result.ronPayment).toBe(32000) // child 8000 × 4
  })
})

describe('四暗刻 ron-shanpon downgrade', () => {
  // Hand: 4 triplet shapes (1m, 3m, 6m, 9m) + 5p pair, winning on 3m by ron.
  // The winning tile completes the 3m triplet — under ron, that triplet
  // becomes a minkou, so the hand is san_ankou (3 ankou + 1 minkou) + toitoi,
  // NOT suu_ankou.
  const ronShanponHand: TileType[] = [0, 0, 0, 3, 3, 6, 6, 6, 8, 8, 8, 13, 13]
  // Note: 13-tile hand with two 3m. Winning 3m makes the 3rd → triplet.

  it('ron with winning tile in a triplet (shanpon) does not fire suu_ankou', () => {
    const result = evaluateYaku({
      ...baseCtx,
      hand: ronShanponHand,
      melds: [],
      winningTile: 3, // 3m
      isTsumo: false,
      player: makePlayer({ hand: ronShanponHand }),
    })
    expect(result.yaku.some(y => y.name === 'suu_ankou')).toBe(false)
    expect(result.yaku.some(y => y.name === 'suu_ankou_tanki')).toBe(false)
    expect(result.yaku.some(y => y.name === 'san_ankou')).toBe(true)
    expect(result.yaku.some(y => y.name === 'toitoi')).toBe(true)
  })

  it('tsumo on the same hand DOES fire suu_ankou', () => {
    const result = evaluateYaku({
      ...baseCtx,
      hand: ronShanponHand,
      melds: [],
      winningTile: 3,
      isTsumo: true,
      player: makePlayer({ hand: ronShanponHand }),
    })
    expect(result.isYakuman).toBe(true)
    expect(result.yaku.some(y => y.name === 'suu_ankou')).toBe(true)
  })

  it('ron on the pair (tanki) emits suu_ankou_tanki (and NOT regular suu_ankou)', () => {
    // 4 ankou + tanki wait on 5p. Tenhou's mjai logs consistently pay
    // single yakuman (basic 8000) for suu_ankou_tanki, so suu_ankou and
    // suu_ankou_tanki are MUTUALLY EXCLUSIVE rather than stacking. Both
    // are 13 han; the tanki variant is just the named form used when the
    // wait was on the pair.
    const tankiHand: TileType[] = [0, 0, 0, 3, 3, 3, 6, 6, 6, 8, 8, 8, 13]
    const result = evaluateYaku({
      ...baseCtx,
      hand: tankiHand,
      melds: [],
      winningTile: 13,
      isTsumo: false,
      player: makePlayer({ hand: tankiHand }),
    })
    expect(result.isYakuman).toBe(true)
    expect(result.yaku.some(y => y.name === 'suu_ankou_tanki')).toBe(true)
    expect(result.yaku.some(y => y.name === 'suu_ankou')).toBe(false)
    expect(result.totalHan).toBe(13)
  })
})

describe('stacked yakuman entries score as multi-yakuman', () => {
  it('daisangen + suu_ankou_tanki (2 yakuman entries) → totalHan 26', () => {
    // 3 dragon ankou + 1m ankou + 5m pair, tanki on 5m tsumo.
    // Expected yakuman: suu_ankou_tanki + daisangen = 2 entries (single
    // yakuman each — tenhou never stacks suu_ankou + suu_ankou_tanki).
    const hand: TileType[] = [0, 0, 0, 31, 31, 31, 32, 32, 32, 33, 33, 33, 4]
    const result = evaluateYaku({
      ...baseCtx,
      hand,
      melds: [],
      winningTile: 4,
      isTsumo: true,
      player: makePlayer({ hand }),
    })
    expect(result.isYakuman).toBe(true)
    expect(result.yaku.some(y => y.name === 'daisangen')).toBe(true)
    expect(result.yaku.some(y => y.name === 'suu_ankou_tanki')).toBe(true)
    expect(result.yaku.some(y => y.name === 'suu_ankou')).toBe(false)
    expect(result.totalHan).toBe(26)
  })
})
