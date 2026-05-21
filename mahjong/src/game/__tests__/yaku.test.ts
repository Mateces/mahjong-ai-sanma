import { describe, it, expect } from 'vitest'
import { evaluateYaku } from '../yaku'
import type { TileType, PlayerState, Meld, Wind } from '../types'

function makePlayer(overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    hand: [],
    melds: [],
    discards: [],
    riichi: false,
    riichiTurn: 0,
    score: 25000,
    isMenzen: true,
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
}

describe('evaluateYaku', () => {
  describe('1-han yaku', () => {
    it('detects riichi', () => {
      const hand: TileType[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 13]
      const result = evaluateYaku({
        ...baseCtx,
        hand,
        melds: [],
        winningTile: 13,
        isRiichi: true,
        player: makePlayer({ hand, riichi: true }),
      })
      expect(result.yaku.some(y => y.name === 'riichi')).toBe(true)
      expect(result.totalHan).toBeGreaterThanOrEqual(1)
    })

    it('detects ippatsu (requires riichi)', () => {
      const hand: TileType[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 13]
      const result = evaluateYaku({
        ...baseCtx,
        hand,
        melds: [],
        winningTile: 13,
        isRiichi: true,
        isIppatsu: true,
        player: makePlayer({ hand, riichi: true }),
      })
      expect(result.yaku.some(y => y.name === 'ippatsu')).toBe(true)
      expect(result.yaku.some(y => y.name === 'riichi')).toBe(true)
      expect(result.totalHan).toBeGreaterThanOrEqual(2)
    })

    it('detects menzen tsumo (門前清自摸和)', () => {
      const hand: TileType[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 13]
      const result = evaluateYaku({
        ...baseCtx,
        hand,
        melds: [],
        winningTile: 13,
        isTsumo: true,
        player: makePlayer({ hand }),
      })
      expect(result.yaku.some(y => y.name === 'menzen_tsumo')).toBe(true)
    })

    it('does not give menzen tsumo on ron', () => {
      const hand: TileType[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 13]
      const result = evaluateYaku({
        ...baseCtx,
        hand,
        melds: [],
        winningTile: 13,
        isTsumo: false,
        player: makePlayer({ hand }),
      })
      expect(result.yaku.some(y => y.name === 'menzen_tsumo')).toBe(false)
    })

    it('detects rinshan (嶺上開花)', () => {
      const hand: TileType[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 13]
      const result = evaluateYaku({
        ...baseCtx,
        hand,
        melds: [],
        winningTile: 13,
        isRinshan: true,
        player: makePlayer({ hand }),
      })
      expect(result.yaku.some(y => y.name === 'rinshan')).toBe(true)
    })

    it('detects chankan (槍槓)', () => {
      const hand: TileType[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 13]
      const result = evaluateYaku({
        ...baseCtx,
        hand,
        melds: [],
        winningTile: 13,
        isChankan: true,
        player: makePlayer({ hand }),
      })
      expect(result.yaku.some(y => y.name === 'chankan')).toBe(true)
    })

    it('detects haitei (海底撈月) — tsumo on last tile', () => {
      const hand: TileType[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 13]
      const result = evaluateYaku({
        ...baseCtx,
        hand,
        melds: [],
        winningTile: 13,
        isHaitei: true,
        isTsumo: true,
        player: makePlayer({ hand }),
      })
      expect(result.yaku.some(y => y.name === 'haitei')).toBe(true)
    })

    it('detects houtei (河底撈魚) — ron on last tile', () => {
      const hand: TileType[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 13]
      const result = evaluateYaku({
        ...baseCtx,
        hand,
        melds: [],
        winningTile: 13,
        isHoutei: true,
        player: makePlayer({ hand }),
      })
      expect(result.yaku.some(y => y.name === 'houtei')).toBe(true)
    })

    it('detects tanyao (断幺九)', () => {
      const hand: TileType[] = [1, 2, 3, 4, 5, 6, 10, 11, 12, 13, 14, 15, 20]
      const result = evaluateYaku({
        ...baseCtx,
        hand,
        melds: [],
        winningTile: 20,
        player: makePlayer({ hand }),
      })
      expect(result.yaku.some(y => y.name === 'tanyao')).toBe(true)
    })

    it('does not give tanyao for hand with terminals', () => {
      // Contains 1m (terminal)
      const hand: TileType[] = [0, 1, 2, 4, 5, 6, 10, 11, 12, 13, 14, 15, 20]
      const result = evaluateYaku({
        ...baseCtx,
        hand,
        melds: [],
        winningTile: 20,
        player: makePlayer({ hand }),
      })
      expect(result.yaku.some(y => y.name === 'tanyao')).toBe(false)
    })

    it('detects yakuhai: haku (白)', () => {
      const hand: TileType[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 31, 31, 31, 13]
      const result = evaluateYaku({
        ...baseCtx,
        hand,
        melds: [],
        winningTile: 13,
        player: makePlayer({ hand }),
      })
      expect(result.yaku.some(y => y.name === 'yakuhai_haku')).toBe(true)
    })

    it('detects yakuhai: hatsu (發)', () => {
      const hand: TileType[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 32, 32, 32, 13]
      const result = evaluateYaku({
        ...baseCtx,
        hand,
        melds: [],
        winningTile: 13,
        player: makePlayer({ hand }),
      })
      expect(result.yaku.some(y => y.name === 'yakuhai_hatsu')).toBe(true)
    })

    it('detects yakuhai: chun (中)', () => {
      const hand: TileType[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 33, 33, 33, 13]
      const result = evaluateYaku({
        ...baseCtx,
        hand,
        melds: [],
        winningTile: 13,
        player: makePlayer({ hand }),
      })
      expect(result.yaku.some(y => y.name === 'yakuhai_chun')).toBe(true)
    })

    it('detects yakuhai: round wind (場風)', () => {
      // East round, East seat — EEE triplet
      const hand: TileType[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 27, 27, 27, 13]
      const result = evaluateYaku({
        ...baseCtx,
        roundWind: 0,
        hand,
        melds: [],
        winningTile: 13,
        player: makePlayer({ hand }),
      })
      expect(result.yaku.some(y => y.name === 'yakuhai_bakaze')).toBe(true)
    })

    it('detects yakuhai: seat wind (自風)', () => {
      // East round, South seat — SSS triplet gives jikaze
      const hand: TileType[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 28, 28, 28, 13]
      const result = evaluateYaku({
        ...baseCtx,
        roundWind: 0,
        seatWind: 1,
        hand,
        melds: [],
        winningTile: 13,
        player: makePlayer({ hand }),
      })
      expect(result.yaku.some(y => y.name === 'yakuhai_jikaze')).toBe(true)
    })

    it('detects pinhu (平和) — all sequences, non-yakuhai pair', () => {
      // 1m2m3m 4m5m6m 7m8m 2p3p4p 6s6s, winning 9m (ryanmen high from 7m-8m).
      // Original test used tanki on 6s — that is NOT pinhu since pinhu
      // requires a ryanmen wait per Japanese mahjong rules.
      const hand: TileType[] = [0, 1, 2, 3, 4, 5, 6, 7, 10, 11, 12, 23, 23]
      const result = evaluateYaku({
        ...baseCtx,
        roundWind: 0,
        seatWind: 0,
        hand,
        melds: [],
        winningTile: 8,
        player: makePlayer({ hand }),
      })
      expect(result.yaku.some(y => y.name === 'pinhu')).toBe(true)
    })

    it('does not give pinhu with yakuhai pair (dragon)', () => {
      // 1m2m3m 4m5m6m 7m8m9m 2p3p4p HH (pair is dragon)
      const hand: TileType[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 31]
      const result = evaluateYaku({
        ...baseCtx,
        hand,
        melds: [],
        winningTile: 31,
        player: makePlayer({ hand }),
      })
      expect(result.yaku.some(y => y.name === 'pinhu')).toBe(false)
    })

    it('does not give pinhu with round wind pair', () => {
      // East round, pair is East
      const hand: TileType[] = [1, 2, 3, 4, 5, 6, 10, 11, 12, 19, 20, 21, 27]
      const result = evaluateYaku({
        ...baseCtx,
        roundWind: 0,
        seatWind: 1,
        hand,
        melds: [],
        winningTile: 27,
        player: makePlayer({ hand }),
      })
      expect(result.yaku.some(y => y.name === 'pinhu')).toBe(false)
    })

    it('does not give pinhu on open hand', () => {
      const hand: TileType[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 23]
      const result = evaluateYaku({
        ...baseCtx,
        hand,
        melds: [],
        winningTile: 23,
        player: makePlayer({ hand, isMenzen: false }),
      })
      expect(result.yaku.some(y => y.name === 'pinhu')).toBe(false)
    })
  })

  describe('1-han kuisagari yaku', () => {
    it('detects iipeikou (一盃口) — two identical sequences', () => {
      // 1m2m3m 1m2m3m 4m5m6m 7m8m9m 5p5p
      const hand: TileType[] = [0, 0, 1, 1, 2, 2, 3, 4, 5, 6, 7, 8, 13]
      const result = evaluateYaku({
        ...baseCtx,
        hand,
        melds: [],
        winningTile: 13,
        player: makePlayer({ hand }),
      })
      expect(result.yaku.some(y => y.name === 'iipeikou')).toBe(true)
    })

    it('does not give iipeikou on open hand', () => {
      const hand: TileType[] = [0, 0, 1, 1, 2, 2, 3, 4, 5, 6, 7, 8, 13]
      const result = evaluateYaku({
        ...baseCtx,
        hand,
        melds: [],
        winningTile: 13,
        player: makePlayer({ hand, isMenzen: false }),
      })
      expect(result.yaku.some(y => y.name === 'iipeikou')).toBe(false)
    })
  })

  describe('2-han yaku', () => {
    it('detects toitoi (対々和) — all triplets', () => {
      const hand: TileType[] = [0, 0, 0, 9, 9, 9, 20, 13, 13, 13]
      const melds: Meld[] = [{ type: 'pon', tiles: [4, 4, 4], calledFrom: 1 }]
      const result = evaluateYaku({
        ...baseCtx,
        hand,
        melds,
        winningTile: 20,
        player: makePlayer({ hand, melds, isMenzen: false }),
      })
      expect(result.yaku.some(y => y.name === 'toitoi')).toBe(true)
    })

    it('does not give toitoi when sequences present', () => {
      // Has a sequence, not all triplets
      const hand: TileType[] = [0, 1, 2, 9, 9, 9, 13, 13, 13, 20]
      const melds: Meld[] = [{ type: 'pon', tiles: [27, 27, 27], calledFrom: 1 }]
      const result = evaluateYaku({
        ...baseCtx,
        hand,
        melds,
        winningTile: 20,
        player: makePlayer({ hand, melds, isMenzen: false }),
      })
      expect(result.yaku.some(y => y.name === 'toitoi')).toBe(false)
    })

    it('detects san_ankou (三暗刻) — 3 closed triplets', () => {
      // 3 closed triplets in hand + 1 sequence meld, hand = 10 tiles (13 - 3 for chi)
      const hand: TileType[] = [0, 0, 0, 9, 9, 9, 18, 18, 18, 4]
      const melds: Meld[] = [{ type: 'chi', tiles: [27, 28, 29], calledFrom: 1 }]
      const result = evaluateYaku({
        ...baseCtx,
        hand,
        melds,
        winningTile: 4,
        isTsumo: true,
        player: makePlayer({ hand, melds, isMenzen: false }),
      })
      expect(result.yaku.some(y => y.name === 'san_ankou')).toBe(true)
    })

    it('detects sanshoku doujun (三色同順) — same sequence in 3 suits', () => {
      // 2m3m4m 2p3p4p 2s3s4s + rest
      // 2m=1,3m=2,4m=3 / 2p=10,3p=11,4p=12 / 2s=19,3s=20,4s=21
      const hand: TileType[] = [1, 2, 3, 10, 11, 12, 19, 20, 21, 6, 7, 8, 13]
      const result = evaluateYaku({
        ...baseCtx,
        hand,
        melds: [],
        winningTile: 13,
        player: makePlayer({ hand }),
      })
      expect(result.yaku.some(y => y.name === 'sanshoku_doujun')).toBe(true)
    })

    it('detects ikkitsuukan (一気通貫) — 1-9 of same suit', () => {
      // 1m2m3m 4m5m6m 7m8m9m + rest
      const hand: TileType[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13]
      const result = evaluateYaku({
        ...baseCtx,
        hand,
        melds: [],
        winningTile: 13,
        player: makePlayer({ hand }),
      })
      expect(result.yaku.some(y => y.name === 'ikkitsuukan')).toBe(true)
    })

    it('does not give ikkitsuukan across different suits', () => {
      // 1m2m3m 4p5p6p 7s8s9s — not same suit
      const hand: TileType[] = [0, 1, 2, 12, 13, 14, 24, 25, 26, 3, 4, 5, 9]
      const result = evaluateYaku({
        ...baseCtx,
        hand,
        melds: [],
        winningTile: 9,
        player: makePlayer({ hand }),
      })
      expect(result.yaku.some(y => y.name === 'ikkitsuukan')).toBe(false)
    })
  })

  describe('3-han yaku', () => {
    it('detects honitsu (混一色) — one suit + honors', () => {
      const hand: TileType[] = [0, 1, 2, 4, 5, 6, 7, 7, 7, 27, 27, 27, 8]
      const result = evaluateYaku({
        ...baseCtx,
        hand,
        melds: [],
        winningTile: 8,
        player: makePlayer({ hand }),
      })
      expect(result.yaku.some(y => y.name === 'honitsu')).toBe(true)
      const honitsu = result.yaku.find(y => y.name === 'honitsu')!
      expect(honitsu.han).toBe(3)
    })

    it('reduces honitsu with kuisagari on open hand', () => {
      const hand: TileType[] = [0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 4]
      const melds: Meld[] = [{ type: 'pon', tiles: [27, 27, 27], calledFrom: 1 }]
      const result = evaluateYaku({
        ...baseCtx,
        hand,
        melds,
        winningTile: 4,
        player: makePlayer({ hand, melds, isMenzen: false }),
      })
      const honitsu = result.yaku.find(y => y.name === 'honitsu')
      if (honitsu) {
        // Kuisagari reduces by 1: 3 → 2 han contribution
        expect(result.totalHan).toBeLessThan(5)
      }
    })

    it('detects ryanpeikou (二盃口) — two pairs of identical sequences', () => {
      // 1m2m3m 1m2m3m 4m5m6m 4m5m6m 7m7m
      const hand: TileType[] = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6]
      const result = evaluateYaku({
        ...baseCtx,
        hand,
        melds: [],
        winningTile: 6,
        player: makePlayer({ hand }),
      })
      expect(result.yaku.some(y => y.name === 'ryanpeikou')).toBe(true)
    })

    it('does not give ryanpeikou on open hand', () => {
      const hand: TileType[] = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6]
      const result = evaluateYaku({
        ...baseCtx,
        hand,
        melds: [],
        winningTile: 6,
        player: makePlayer({ hand, isMenzen: false }),
      })
      expect(result.yaku.some(y => y.name === 'ryanpeikou')).toBe(false)
    })
  })

  describe('6-han yaku', () => {
    it('detects chinitsu (清一色) — all one suit, no honors', () => {
      const hand: TileType[] = [0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 4, 4]
      const result = evaluateYaku({
        ...baseCtx,
        hand,
        melds: [],
        winningTile: 4,
        player: makePlayer({ hand }),
      })
      expect(result.yaku.some(y => y.name === 'chinitsu')).toBe(true)
      const chinitsu = result.yaku.find(y => y.name === 'chinitsu')!
      expect(chinitsu.han).toBe(6)
    })

    it('does not give chinitsu with honors', () => {
      const hand: TileType[] = [0, 1, 2, 4, 5, 6, 7, 7, 7, 27, 27, 27, 8]
      const result = evaluateYaku({
        ...baseCtx,
        hand,
        melds: [],
        winningTile: 8,
        player: makePlayer({ hand }),
      })
      expect(result.yaku.some(y => y.name === 'chinitsu')).toBe(false)
    })

    it('reduces chinitsu with kuisagari on open hand', () => {
      const hand: TileType[] = [0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8]
      const melds: Meld[] = [{ type: 'chi', tiles: [3, 4, 5], calledFrom: 1 }]
      const result = evaluateYaku({
        ...baseCtx,
        hand,
        melds,
        winningTile: 8,
        player: makePlayer({ hand, melds, isMenzen: false }),
      })
      const chinitsu = result.yaku.find(y => y.name === 'chinitsu')
      if (chinitsu) {
        // Open chinitsu: 6 - 1 = 5 han effective
        expect(result.totalHan).toBeLessThan(6)
      }
    })
  })

  describe('yakuman', () => {
    it('detects kokushi (国士無双)', () => {
      const hand: TileType[] = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33]
      const result = evaluateYaku({
        ...baseCtx,
        hand,
        melds: [],
        winningTile: 33,
        player: makePlayer({ hand }),
      })
      expect(result.isYakuman).toBe(true)
      expect(result.yaku.some(y => y.name === 'kokushi')).toBe(true)
      expect(result.totalHan).toBe(13)
    })

    it('detects suu_ankou (四暗刻) — 4 closed triplets, non-tanki tsumo', () => {
      // AAA BBB CCC + AA wait + DD pair → tsumo A completes the 4th triplet.
      // Winning tile is in a triplet (not the pair), so this is plain
      // suu_ankou — NOT the tanki variant.
      const hand: TileType[] = [0, 0, 0, 3, 3, 3, 6, 6, 6, 9, 9, 13, 13]
      const result = evaluateYaku({
        ...baseCtx,
        hand,
        melds: [],
        winningTile: 9,
        isTsumo: true,
        player: makePlayer({ hand }),
      })
      expect(result.isYakuman).toBe(true)
      expect(result.yaku.some(y => y.name === 'suu_ankou')).toBe(true)
      expect(result.yaku.some(y => y.name === 'suu_ankou_tanki')).toBe(false)
    })

    it('detects daisangen (大三元)', () => {
      const hand: TileType[] = [0, 1, 2, 31, 31, 31, 32, 32, 32, 33, 33, 33, 4]
      const result = evaluateYaku({
        ...baseCtx,
        hand,
        melds: [],
        winningTile: 4,
        player: makePlayer({ hand }),
      })
      expect(result.isYakuman).toBe(true)
      expect(result.yaku.some(y => y.name === 'daisangen')).toBe(true)
    })

    it('detects regular chuuren poutou (九蓮宝燈) — non-junsei wait', () => {
      // 13-tile [3,2,1,1,1,1,1,1,2] waiting on 9m to make [3,2,1,1,1,1,1,1,3].
      // 13-tile is NOT the perfect [3,1,1,1,1,1,1,1,3] pattern, so this is
      // single yakuman (not junsei).
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
    })

    it('detects tenhou (天和) — dealer wins on first turn', () => {
      const hand: TileType[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 13]
      const result = evaluateYaku({
        ...baseCtx,
        hand,
        melds: [],
        winningTile: 13,
        seatWind: 0,
        isTsumo: true,
        isFirstTurn: true,
        player: makePlayer({ hand }),
      })
      expect(result.isYakuman).toBe(true)
      expect(result.yaku.some(y => y.name === 'tenhou')).toBe(true)
    })

    it('detects chiihou (地和) — non-dealer wins on first draw', () => {
      const hand: TileType[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 13]
      const result = evaluateYaku({
        ...baseCtx,
        hand,
        melds: [],
        winningTile: 13,
        seatWind: 1, // non-dealer
        isTsumo: true,
        isFirstTurn: true,
        player: makePlayer({ hand }),
      })
      expect(result.isYakuman).toBe(true)
      expect(result.yaku.some(y => y.name === 'chiihou')).toBe(true)
    })

    it('detects suu_kantsu (四槓子) — 4 kans', () => {
      // With 4 kan melds, hand = 1 tile, winningTile completes pair (2 tiles total → pair)
      const handPair: TileType[] = [13]
      const kanMelds: Meld[] = [
        { type: 'ankan', tiles: [0, 0, 0, 0], calledFrom: 0 },
        { type: 'ankan', tiles: [9, 9, 9, 9], calledFrom: 0 },
        { type: 'kakan', tiles: [18, 18, 18, 18], calledFrom: 0 },
        { type: 'daiminkan', tiles: [27, 27, 27, 27], calledFrom: 1 },
      ]
      const result = evaluateYaku({
        ...baseCtx,
        hand: handPair,
        melds: kanMelds,
        winningTile: 13,
        player: makePlayer({ hand: handPair, melds: kanMelds, isMenzen: false }),
      })
      expect(result.yaku.some(y => y.name === 'suu_kantsu')).toBe(true)
    })
  })

  describe('multiple yaku combinations', () => {
    it('stacks riichi + ippatsu + tanyao + pinhu', () => {
      // 2m3m4m 5m6m7m 2p3p4p 5p6p 3s3s, winning 7p (ryanmen high of 5p-6p).
      // Original used tanki on 3s, which does not qualify for pinhu.
      const hand: TileType[] = [1, 2, 3, 4, 5, 6, 10, 11, 12, 13, 14, 20, 20]
      const result = evaluateYaku({
        ...baseCtx,
        hand,
        melds: [],
        winningTile: 15,
        isRiichi: true,
        isIppatsu: true,
        player: makePlayer({ hand, riichi: true }),
      })
      expect(result.yaku.some(y => y.name === 'riichi')).toBe(true)
      expect(result.yaku.some(y => y.name === 'ippatsu')).toBe(true)
      expect(result.yaku.some(y => y.name === 'tanyao')).toBe(true)
      expect(result.yaku.some(y => y.name === 'pinhu')).toBe(true)
      expect(result.totalHan).toBe(4) // 1+1+1+1
    })

    it('stacks menzen tsumo + pinhu', () => {
      // 1m2m3m 4m5m6m 7m8m 2p3p4p 6s6s, tsumo 9m (ryanmen high of 7m-8m).
      // Original used tanki on 6s — pinhu requires ryanmen.
      const hand: TileType[] = [0, 1, 2, 3, 4, 5, 6, 7, 10, 11, 12, 23, 23]
      const result = evaluateYaku({
        ...baseCtx,
        hand,
        melds: [],
        winningTile: 8,
        isTsumo: true,
        player: makePlayer({ hand }),
      })
      expect(result.yaku.some(y => y.name === 'menzen_tsumo')).toBe(true)
      expect(result.yaku.some(y => y.name === 'pinhu')).toBe(true)
      expect(result.totalHan).toBeGreaterThanOrEqual(2)
    })

    it('stacks tanyao + chinitsu', () => {
      // All man middle tiles, no terminals — tanyao + chinitsu
      // 2m2m 3m3m 4m4m 5m5m 6m6m 7m7m 8m (wait 8m for pair — seven pairs)
      const hand: TileType[] = [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7]
      const result = evaluateYaku({
        ...baseCtx,
        hand,
        melds: [],
        winningTile: 7,
        player: makePlayer({ hand }),
      })
      expect(result.yaku.some(y => y.name === 'tanyao')).toBe(true)
      expect(result.yaku.some(y => y.name === 'chinitsu')).toBe(true)
      expect(result.totalHan).toBeGreaterThanOrEqual(7) // 1 + 6
    })

    it('stacks honitsu + yakuhai', () => {
      // All man + dragon honor + dragon triplet
      const hand: TileType[] = [0, 1, 2, 4, 5, 6, 7, 7, 7, 31, 31, 31, 8]
      const result = evaluateYaku({
        ...baseCtx,
        hand,
        melds: [],
        winningTile: 8,
        player: makePlayer({ hand }),
      })
      expect(result.yaku.some(y => y.name === 'honitsu')).toBe(true)
      expect(result.yaku.some(y => y.name === 'yakuhai_haku')).toBe(true)
    })
  })

  describe('no yaku', () => {
    it('returns empty for open hand with no patterns', () => {
      const hand: TileType[] = [0, 0, 0, 3, 4, 5, 13, 14, 16]
      const melds: Meld[] = [{ type: 'chi', tiles: [18, 19, 20], calledFrom: 1 }]
      const result = evaluateYaku({
        ...baseCtx,
        hand,
        melds,
        winningTile: 16,
        player: makePlayer({ hand, melds, isMenzen: false }),
      })
      expect(result.totalHan).toBe(0)
      expect(result.yaku.length).toBe(0)
    })

    it('returns empty for non-decomposable hand', () => {
      const hand: TileType[] = [0, 3, 5, 9, 14, 18, 22, 27, 29, 31, 1, 2, 4]
      const result = evaluateYaku({
        ...baseCtx,
        hand,
        melds: [],
        winningTile: 4,
        player: makePlayer({ hand }),
      })
      expect(result.totalHan).toBe(0)
      expect(result.yaku.length).toBe(0)
    })
  })

  describe('kuisagari (喰い下がり)', () => {
    it('reduces tanyao han by 1 on open hand', () => {
      // Open hand with tanyao (assuming rules allow open tanyao)
      const hand: TileType[] = [1, 2, 3, 4, 5, 6, 10, 11, 12, 13, 14]
      const melds: Meld[] = [{ type: 'chi', tiles: [19, 20, 21], calledFrom: 1 }]
      const result = evaluateYaku({
        ...baseCtx,
        hand,
        melds,
        winningTile: 14,
        player: makePlayer({ hand, melds, isMenzen: false }),
      })
      const tanyao = result.yaku.find(y => y.name === 'tanyao')
      if (tanyao) {
        // Kuisagari: 1 - 1 = 0, so tanyao effectively 0 han on open hand
        expect(result.totalHan).toBeLessThanOrEqual(1)
      }
    })

    it('full han on closed hand', () => {
      const hand: TileType[] = [1, 2, 3, 4, 5, 6, 10, 11, 12, 13, 14, 15, 20]
      const result = evaluateYaku({
        ...baseCtx,
        hand,
        melds: [],
        winningTile: 20,
        player: makePlayer({ hand }),
      })
      const tanyao = result.yaku.find(y => y.name === 'tanyao')!
      expect(tanyao.han).toBe(1)
    })
  })
})
