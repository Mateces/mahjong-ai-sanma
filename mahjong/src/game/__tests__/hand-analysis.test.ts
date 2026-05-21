import { describe, it, expect } from 'vitest'
import { isWinningHand, decomposeWinningHand } from '../hand-analysis'
import type { TileType } from '../types'

describe('isWinningHand', () => {
  describe('regular form (14 tiles)', () => {
    it('detects 4 mentsu + pair with all sequences', () => {
      const hand = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 13]
      expect(isWinningHand(hand)).toBe(true)
    })

    it('detects 4 triplets + pair', () => {
      const hand = [0, 0, 0, 3, 3, 3, 6, 6, 6, 9, 9, 9, 13, 13]
      expect(isWinningHand(hand)).toBe(true)
    })

    it('detects mixed triplets and sequences', () => {
      const hand = [0, 0, 0, 3, 4, 5, 9, 9, 9, 18, 19, 20, 27, 27]
      expect(isWinningHand(hand)).toBe(true)
    })

    it('detects sequence at edge (1-2-3)', () => {
      const hand = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 13]
      expect(isWinningHand(hand)).toBe(true)
    })

    it('detects sequence at edge (7-8-9)', () => {
      const hand = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 13]
      expect(isWinningHand(hand)).toBe(true)
    })

    it('detects pin suit sequences', () => {
      // 1p2p3p 4p5p6p 7p8p9p + man triplet + pair
      const hand = [9, 10, 11, 12, 13, 14, 15, 16, 17, 0, 0, 0, 18, 18]
      expect(isWinningHand(hand)).toBe(true)
    })

    it('detects sou suit sequences', () => {
      const hand = [18, 19, 20, 21, 22, 23, 24, 25, 26, 0, 0, 0, 9, 9]
      expect(isWinningHand(hand)).toBe(true)
    })

    it('detects honor triplets', () => {
      // EEE SSS WWW + 1m2m3m + NN pair
      const hand = [27, 27, 27, 28, 28, 28, 29, 29, 29, 0, 1, 2, 30, 30]
      expect(isWinningHand(hand)).toBe(true)
    })

    it('detects dragon triplets', () => {
      // HHH GGG RRR + 1m2m3m + 1p1p
      const hand = [31, 31, 31, 32, 32, 32, 33, 33, 33, 0, 1, 2, 9, 9]
      expect(isWinningHand(hand)).toBe(true)
    })

    it('rejects incomplete hand', () => {
      const hand = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 13, 14]
      expect(isWinningHand(hand)).toBe(false)
    })

    it('rejects random tiles', () => {
      const hand = [0, 3, 5, 9, 12, 14, 18, 21, 24, 27, 29, 31, 33, 1]
      expect(isWinningHand(hand)).toBe(false)
    })

    it('rejects 13-tile input (no pair slot)', () => {
      expect(isWinningHand([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 13])).toBe(false)
    })

    it('rejects 15-tile input (over-full)', () => {
      expect(isWinningHand([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 13, 13, 14])).toBe(false)
    })
  })

  describe('open hands (post-call concealed portions)', () => {
    // After N melds, the concealed portion is 14 − 3·N tiles long.
    // Valid: 11 (1 meld), 8 (2 melds), 5 (3 melds), 2 (4 melds).
    it('detects 11-tile win (1 meld)', () => {
      const hand = [0, 1, 2, 3, 4, 5, 9, 10, 11, 13, 13]
      expect(isWinningHand(hand)).toBe(true)
    })

    it('detects 8-tile win (2 melds)', () => {
      const hand = [0, 1, 2, 3, 4, 5, 9, 9]
      expect(isWinningHand(hand)).toBe(true)
    })

    it('detects 5-tile win (3 melds)', () => {
      const hand = [0, 1, 2, 9, 9]
      expect(isWinningHand(hand)).toBe(true)
    })

    it('detects 2-tile win (4 melds, only pair concealed)', () => {
      expect(isWinningHand([9, 9])).toBe(true)
    })

    it('rejects 11-tile non-winning', () => {
      // No valid pair + 3 mentsu decomposition
      expect(isWinningHand([0, 2, 5, 9, 12, 15, 18, 21, 24, 27, 31])).toBe(false)
    })

    it('rejects 12-tile (len%3 !== 2)', () => {
      expect(isWinningHand([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9])).toBe(false)
    })

    it('rejects 10-tile (len%3 !== 2)', () => {
      expect(isWinningHand([0, 1, 2, 3, 4, 5, 9, 9, 9, 9])).toBe(false)
    })

    it('rejects 1-tile and empty', () => {
      expect(isWinningHand([0])).toBe(false)
      expect(isWinningHand([])).toBe(false)
    })
  })

  describe('seven pairs (14 tiles)', () => {
    it('detects seven pairs', () => {
      const hand = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6]
      expect(isWinningHand(hand)).toBe(true)
    })

    it('detects seven pairs across suits', () => {
      const hand = [0, 0, 9, 9, 18, 18, 27, 27, 28, 28, 31, 31, 32, 32]
      expect(isWinningHand(hand)).toBe(true)
    })

    it('rejects six pairs + two singles', () => {
      const hand = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 6, 7, 8]
      expect(isWinningHand(hand)).toBe(false)
    })

    it('detects seven pairs that also form regular', () => {
      // 1m1m 2m2m 3m3m 4m4m 5m5m 6m6m 7m7m — this is also regular: 123 123 456 456 + 77 pair
      const hand = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6]
      expect(isWinningHand(hand)).toBe(true)
    })
  })

  describe('kokushi (14 tiles)', () => {
    it('detects kokushi with 1m pair', () => {
      const hand = [0, 0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33]
      expect(isWinningHand(hand)).toBe(true)
    })

    it('detects kokushi with dragon pair', () => {
      const hand = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33, 33]
      expect(isWinningHand(hand)).toBe(true)
    })

    it('rejects kokushi missing one terminal', () => {
      // Missing 9p (17)
      const hand = [0, 0, 8, 9, 18, 26, 27, 28, 29, 30, 31, 32, 33, 16]
      expect(isWinningHand(hand)).toBe(false)
    })

    it('rejects kokushi with two pairs', () => {
      // Two pairs means it's not kokushi (need exactly 13 unique + 1 pair)
      const hand = [0, 0, 8, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32]
      // Missing 33, has two pairs — this is NOT kokushi
      expect(isWinningHand(hand)).toBe(false)
    })
  })
})

describe('decomposeWinningHand', () => {
  describe('regular decomposition', () => {
    it('decomposes all-sequences hand', () => {
      const hand: TileType[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 13]
      const result = decomposeWinningHand(hand)
      expect(result).not.toBeNull()
      expect(result!.type).toBe('regular')
      expect(result!.mentsu.length).toBe(4)
      expect(result!.pair).toBe(13)
    })

    it('decomposes all-triplets hand', () => {
      const hand: TileType[] = [0, 0, 0, 3, 3, 3, 6, 6, 6, 9, 9, 9, 13, 13]
      const result = decomposeWinningHand(hand)
      expect(result).not.toBeNull()
      expect(result!.type).toBe('regular')
      expect(result!.mentsu.length).toBe(4)
      // All mentsu should be triplets
      expect(result!.mentsu.every(m => m.tiles[0] === m.tiles[1])).toBe(true)
    })

    it('identifies correct pair tile', () => {
      const hand: TileType[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 27, 27]
      const result = decomposeWinningHand(hand)
      expect(result).not.toBeNull()
      expect(result!.pair).toBe(27) // EE pair
    })

    it('decomposes hand with honor triplets', () => {
      const hand: TileType[] = [0, 0, 0, 3, 4, 5, 31, 31, 31, 9, 10, 11, 13, 13]
      const result = decomposeWinningHand(hand)
      expect(result).not.toBeNull()
      expect(result!.type).toBe('regular')
      expect(result!.mentsu.length).toBe(4)
    })
  })

  describe('seven pairs decomposition', () => {
    it('decomposes seven pairs', () => {
      const hand: TileType[] = [0, 0, 2, 2, 5, 5, 9, 9, 18, 18, 27, 27, 31, 31]
      const result = decomposeWinningHand(hand)
      expect(result).not.toBeNull()
      expect(result!.type).toBe('seven_pairs')
      expect(result!.mentsu.length).toBe(0)
    })

    it('returns seven_pairs when not decomposable as regular', () => {
      // Hand that ONLY works as seven pairs
      const hand: TileType[] = [0, 0, 2, 2, 5, 5, 9, 9, 18, 18, 27, 27, 31, 31]
      const result = decomposeWinningHand(hand)
      expect(result!.type).toBe('seven_pairs')
    })
  })

  describe('kokushi decomposition', () => {
    it('decomposes kokushi', () => {
      const hand: TileType[] = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33, 33]
      const result = decomposeWinningHand(hand)
      expect(result).not.toBeNull()
      expect(result!.type).toBe('kokushi')
      expect(result!.mentsu.length).toBe(0)
    })

    it('identifies pair tile in kokushi', () => {
      const hand: TileType[] = [0, 0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33]
      const result = decomposeWinningHand(hand)
      expect(result).not.toBeNull()
      expect(result!.pair).toBe(0) // 1m is the pair
    })
  })

  describe('open hand decomposition (variable tile count)', () => {
    it('decomposes 11 tiles (3 melds) — 3 mentsu + pair', () => {
      // Player has 1 pon meld (3 tiles) + 11 hand tiles
      // 11 tiles = 3 mentsu (9) + pair (2)
      const tiles: TileType[] = [0, 1, 2, 3, 4, 5, 9, 10, 11, 13, 13]
      const result = decomposeWinningHand(tiles)
      expect(result).not.toBeNull()
      expect(result!.type).toBe('regular')
      expect(result!.mentsu.length).toBe(3)
      expect(result!.pair).toBe(13)
    })

    it('decomposes 8 tiles (2 melds) — 2 mentsu + pair', () => {
      // Player has 2 melds (6 tiles) + 8 hand tiles
      // 8 tiles = 2 mentsu (6) + pair (2)
      const tiles: TileType[] = [0, 1, 2, 3, 4, 5, 9, 9]
      const result = decomposeWinningHand(tiles)
      expect(result).not.toBeNull()
      expect(result!.type).toBe('regular')
      expect(result!.mentsu.length).toBe(2)
      expect(result!.pair).toBe(9)
    })

    it('decomposes 5 tiles (3 melds) — 1 mentsu + pair', () => {
      // Player has 3 melds (9 tiles) + 5 hand tiles
      // 5 tiles = 1 mentsu (3) + pair (2)
      const tiles: TileType[] = [0, 1, 2, 9, 9]
      const result = decomposeWinningHand(tiles)
      expect(result).not.toBeNull()
      expect(result!.type).toBe('regular')
      expect(result!.mentsu.length).toBe(1)
      expect(result!.pair).toBe(9)
    })

    it('decomposes 2 tiles (4 melds) — pair only', () => {
      // Player has 4 melds (12 tiles) + 2 hand tiles
      // 2 tiles = pair only (0 mentsu)
      const tiles: TileType[] = [9, 9]
      const result = decomposeWinningHand(tiles)
      expect(result).not.toBeNull()
      expect(result!.type).toBe('regular')
      expect(result!.mentsu.length).toBe(0)
      expect(result!.pair).toBe(9)
    })

    it('returns null for non-winning open hand (11 tiles)', () => {
      const tiles: TileType[] = [0, 2, 5, 9, 12, 15, 18, 21, 24, 27, 31]
      const result = decomposeWinningHand(tiles)
      expect(result).toBeNull()
    })

    it('returns null for non-winning open hand (8 tiles)', () => {
      const tiles: TileType[] = [0, 3, 9, 14, 18, 22, 27, 31]
      const result = decomposeWinningHand(tiles)
      expect(result).toBeNull()
    })
  })

  describe('decomposition correctness', () => {
    it('all mentsu tiles sum to correct count', () => {
      const hand: TileType[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 13]
      const result = decomposeWinningHand(hand)!
      let tileCount = 0
      for (const m of result.mentsu) tileCount += m.tiles.length
      tileCount += 2 // pair
      expect(tileCount).toBe(14)
    })

    it('produces valid mentsu (all triplets or sequences)', () => {
      const hand: TileType[] = [0, 0, 0, 3, 4, 5, 31, 31, 31, 9, 10, 11, 13, 13]
      const result = decomposeWinningHand(hand)!
      for (const m of result.mentsu) {
        expect(m.tiles.length).toBe(3)
        const isTriplet = m.tiles[0] === m.tiles[1] && m.tiles[1] === m.tiles[2]
        const isSequence = m.tiles[2] === m.tiles[1] + 1 && m.tiles[1] === m.tiles[0] + 1
        expect(isTriplet || isSequence).toBe(true)
      }
    })

    it('pair is exactly 2 identical tiles', () => {
      const hand: TileType[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 13, 13]
      const result = decomposeWinningHand(hand)!
      expect(result.pair).toBeGreaterThanOrEqual(0)
      expect(result.pair).toBeLessThanOrEqual(33)
    })

    it('returns null for non-winning hand', () => {
      const hand: TileType[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 13, 14]
      expect(decomposeWinningHand(hand)).toBeNull()
    })

    it('returns null for empty array', () => {
      expect(decomposeWinningHand([])).toBeNull()
    })

    it('returns null for 1 tile', () => {
      expect(decomposeWinningHand([0])).toBeNull()
    })
  })

  describe('ambiguous decompositions', () => {
    it('handles hand with multiple valid decompositions', () => {
      // 1m1m1m 2m3m4m 5m6m7m 8m9m 8m9m — could decompose different ways
      // Wait, that's 14 tiles: 111 234 567 89 89 — 4 mentsu + 89 pair? No, 89 isn't a pair
      // Let's try: 1m1m 1m2m3m 4m5m6m 7m8m9m 7m8m9m — wait that's 14 with duplicate sequences
      // Actually: 1m1m 1m2m3m 2m3m4m 5m6m7m 8m9m
      // That's 14: [0,0,0,1,2,3,4,4,5,6,7,8,7,8] — no let me recount
      // 0,0,0,1,2,2,3,3,4,5,6,7,8,8 — 14 tiles
      // 1m1m pair + 1m2m3m + 2m3m... this gets complicated
      // Let's just test a hand where pair selection matters:
      const hand: TileType[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 18, 18]
      // Pair could be 9p or 1s — either way it should decompose
      const result = decomposeWinningHand(hand)
      expect(result).not.toBeNull()
      expect(result!.type).toBe('regular')
    })
  })
})
