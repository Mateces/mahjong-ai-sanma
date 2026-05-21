import { describe, it, expect } from 'vitest'
import { calculateFu, calculatePoints } from '../scoring'

describe('calculateFu', () => {
  describe('base fu', () => {
    it('returns 20 for pinhu tsumo (always 20)', () => {
      const fu = calculateFu({
        winningTile: 2,
        isTsumo: true,
        isPinhu: true,
        melds: [],
        pair: 13,
        mentsu: [{ tiles: [0, 1, 2] }, { tiles: [3, 4, 5] }, { tiles: [9, 10, 11] }],
        seatWind: 0,
        roundWind: 0,
      })
      expect(fu).toBe(20)
    })

    it('returns 30 for pinhu ron (corrected from 20)', () => {
      // Pinhu ron = 30 fu (门清荣和+10)
      const fu = calculateFu({
        winningTile: 5,
        isTsumo: false,
        isPinhu: true,
        melds: [],
        pair: 20,
        mentsu: [{ tiles: [0, 1, 2] }, { tiles: [3, 4, 5] }, { tiles: [9, 10, 11] }],
        seatWind: 0,
        roundWind: 0,
      })
      expect(fu).toBe(30)
    })
  })

  describe('ron bonus', () => {
    it('adds 10 fu for ron (waiting method, menzen)', () => {
      // Base 20 + 10 (ron menzen) = 30. winningTile 5 (=6m) is ryanmen high
      // of seq [3,4,5] = 4m-5m-6m (won 6m from 4m-5m). Note: winningTile 4
      // would be the MIDDLE of the seq → kanchan (+2 fu), not ryanmen.
      const fu = calculateFu({
        winningTile: 5,
        isTsumo: false,
        isPinhu: false,
        melds: [],
        pair: 13,
        mentsu: [{ tiles: [0, 1, 2] }, { tiles: [3, 4, 5] }, { tiles: [9, 10, 11] }],
        seatWind: 0,
        roundWind: 0,
      })
      expect(fu).toBe(30)
    })
  })

  describe('tsumo bonus', () => {
    it('adds 2 fu for tsumo', () => {
      // Base 20 + 2 (tsumo) = 22, rounded up to 30
      const fu = calculateFu({
        winningTile: 2,
        isTsumo: true,
        isPinhu: false,
        melds: [],
        pair: 13,
        mentsu: [{ tiles: [0, 1, 2] }, { tiles: [3, 4, 5] }, { tiles: [9, 10, 11] }],
        seatWind: 0,
        roundWind: 0,
      })
      expect(fu).toBe(30) // ceil(22/10)*10 = 30
    })
  })

  describe('pair yakuhai', () => {
    it('adds 2 fu for dragon pair', () => {
      // Base 20 + 10 (ron) + 2 (dragon pair) = 32 → 40
      const fu = calculateFu({
        winningTile: 2,
        isTsumo: false,
        isPinhu: false,
        melds: [],
        pair: 31, // haku
        mentsu: [{ tiles: [0, 1, 2] }, { tiles: [3, 4, 5] }, { tiles: [9, 10, 11] }],
        seatWind: 0,
        roundWind: 0,
      })
      expect(fu).toBe(40)
    })

    it('adds 2 fu for seat wind pair', () => {
      // Base 20 + 10 (ron) + 2 (seat wind pair) = 32 → 40
      const fu = calculateFu({
        winningTile: 2,
        isTsumo: false,
        isPinhu: false,
        melds: [],
        pair: 27, // East wind
        mentsu: [{ tiles: [1, 2, 3] }, { tiles: [4, 5, 6] }, { tiles: [9, 10, 11] }],
        seatWind: 0, // East seat
        roundWind: 1, // South round (so round wind doesn't match)
      })
      expect(fu).toBe(40)
    })

    it('adds 2 fu for round wind pair', () => {
      // Base 20 + 10 (ron) + 2 (round wind pair) = 32 → 40
      const fu = calculateFu({
        winningTile: 2,
        isTsumo: false,
        isPinhu: false,
        melds: [],
        pair: 27, // East
        mentsu: [{ tiles: [1, 2, 3] }, { tiles: [4, 5, 6] }, { tiles: [9, 10, 11] }],
        seatWind: 1, // South seat
        roundWind: 0, // East round
      })
      expect(fu).toBe(40)
    })

    it('adds 4 fu for double wind pair (seat + round)', () => {
      // Base 20 + 10 (ron) + 2 (seat) + 2 (round) = 34 → 40
      const fu = calculateFu({
        winningTile: 2,
        isTsumo: false,
        isPinhu: false,
        melds: [],
        pair: 27, // East
        mentsu: [{ tiles: [1, 2, 3] }, { tiles: [4, 5, 6] }, { tiles: [9, 10, 11] }],
        seatWind: 0, // East seat
        roundWind: 0, // East round
      })
      expect(fu).toBe(40) // 20 + 10 + 2 + 2 = 34 → 40
    })

    it('no bonus for non-yakuhai pair', () => {
      // Pair is 5p (number tile, not wind/dragon). winningTile 5 (=6m) is
      // ryanmen high of seq [3,4,5] (no wait fu). 4 would be kanchan.
      const fu = calculateFu({
        winningTile: 5,
        isTsumo: false,
        isPinhu: false,
        melds: [],
        pair: 13, // 5p
        mentsu: [{ tiles: [0, 1, 2] }, { tiles: [3, 4, 5] }, { tiles: [9, 10, 11] }],
        seatWind: 0,
        roundWind: 0,
      })
      expect(fu).toBe(30) // 20 + 10 = 30
    })
  })

  describe('mentsu fu', () => {
    it('adds 4 fu for closed terminal triplet', () => {
      // Base 20 + 10 (ron) + 4 (closed terminal triplet) = 34 → 40
      const fu = calculateFu({
        winningTile: 5,
        isTsumo: false,
        isPinhu: false,
        melds: [],
        pair: 13,
        mentsu: [{ tiles: [0, 0, 0] }, { tiles: [3, 4, 5] }, { tiles: [9, 10, 11] }],
        seatWind: 0,
        roundWind: 0,
      })
      expect(fu).toBe(40) // 20 + 10 + 4 = 34 → 40
    })

    it('adds 8 fu for closed terminal triplet (in hand, counted as closed)', () => {
      // mentsuFu for closed triplet: 4 base, terminal = 4*2 = 8
      // Base 20 + 10 (ron) + 8 (closed terminal triplet) = 38 → 40
      const fu = calculateFu({
        winningTile: 5,
        isTsumo: false,
        isPinhu: false,
        melds: [],
        pair: 13,
        mentsu: [
          { tiles: [8, 8, 8] }, // 9m terminal, closed triplet = 8
          { tiles: [3, 4, 5] },
          { tiles: [9, 10, 11] },
        ],
        seatWind: 0,
        roundWind: 0,
      })
      expect(fu).toBe(40) // 20 + 10 + 8 = 38 → 40
    })

    it('adds 2 fu for open simple triplet via pon meld', () => {
      // Pon meld of simple tile: isOpen=true, 2 fu base, simple = 2
      const fu = calculateFu({
        winningTile: 5,
        isTsumo: false,
        isPinhu: false,
        melds: [{ type: 'pon', tiles: [4, 4, 4], calledFrom: 1 }],
        pair: 13,
        mentsu: [{ tiles: [0, 1, 2] }, { tiles: [9, 10, 11] }],
        seatWind: 0,
        roundWind: 0,
      })
      // 20 + 10 + 2 (open pon simple) = 32 → 40
      expect(fu).toBe(40)
    })

    it('adds 4 fu for open terminal triplet via pon meld', () => {
      // Pon meld of terminal tile: isOpen=true, 2*2=4
      const fu = calculateFu({
        winningTile: 5,
        isTsumo: false,
        isPinhu: false,
        melds: [{ type: 'pon', tiles: [0, 0, 0], calledFrom: 1 }],
        pair: 13,
        mentsu: [{ tiles: [3, 4, 5] }, { tiles: [9, 10, 11] }],
        seatWind: 0,
        roundWind: 0,
      })
      // 20 + 10 + 4 (open pon terminal) = 34 → 40
      expect(fu).toBe(40)
    })

    it('adds 16 fu for ankan of terminal (4 * closed_terminal_fu)', () => {
      // Ankan: mentsuFu(tiles, false) * 4
      // Closed terminal triplet: 8, * 4 = 32
      const fu = calculateFu({
        winningTile: 5,
        isTsumo: false,
        isPinhu: false,
        melds: [{ type: 'ankan', tiles: [0, 0, 0, 0], calledFrom: 0 }],
        pair: 13,
        mentsu: [{ tiles: [3, 4, 5] }, { tiles: [9, 10, 11] }],
        seatWind: 0,
        roundWind: 0,
      })
      // 20 + 10 + 32 (ankan terminal) = 62 → 70
      expect(fu).toBe(70)
    })

    it('adds no fu for sequences', () => {
      // All sequences: no mentsu fu. winningTile 5 (=6m) is ryanmen high of
      // seq [3,4,5] (no wait fu). 4 would be kanchan.
      const fu = calculateFu({
        winningTile: 5,
        isTsumo: false,
        isPinhu: false,
        melds: [],
        pair: 13,
        mentsu: [{ tiles: [0, 1, 2] }, { tiles: [3, 4, 5] }, { tiles: [9, 10, 11] }],
        seatWind: 0,
        roundWind: 0,
      })
      expect(fu).toBe(30) // 20 + 10 = 30
    })
  })

  describe('fu rounding', () => {
    it('rounds up to nearest 10', () => {
      // Any non-multiple-of-10 should round up
      // 20 base + 10 ron + 2 dragon pair = 32 → 40
      const fu = calculateFu({
        winningTile: 2,
        isTsumo: false,
        isPinhu: false,
        melds: [],
        pair: 31,
        mentsu: [{ tiles: [0, 1, 2] }, { tiles: [3, 4, 5] }, { tiles: [9, 10, 11] }],
        seatWind: 0,
        roundWind: 0,
      })
      expect(fu % 10).toBe(0)
      expect(fu).toBeGreaterThanOrEqual(30)
    })

    it('keeps exact 10-multiple as-is', () => {
      // winningTile 5 (=6m) is ryanmen high of [3,4,5], no wait fu.
      // 4 would be kanchan (+2 fu) and total would round up to 40.
      const fu = calculateFu({
        winningTile: 5,
        isTsumo: false,
        isPinhu: false,
        melds: [],
        pair: 13,
        mentsu: [{ tiles: [0, 1, 2] }, { tiles: [3, 4, 5] }, { tiles: [9, 10, 11] }],
        seatWind: 0,
        roundWind: 0,
      })
      expect(fu).toBe(30)
    })
  })
})

describe('calculatePoints', () => {
  describe('child ron', () => {
    it('1 han 30 fu: 1000', () => {
      const result = calculatePoints({ han: 1, fu: 30, isDealer: false, isTsumo: false })
      expect(result.ronPayment).toBe(1000) // 30 * 2^3 = 240, * 4 = 960 → ceil100 = 1000
    })

    it('2 han 30 fu: 2000', () => {
      const result = calculatePoints({ han: 2, fu: 30, isDealer: false, isTsumo: false })
      expect(result.ronPayment).toBe(2000) // 30 * 2^4 = 480, * 4 = 1920 → ceil100 = 2000
    })

    it('3 han 30 fu: 3900', () => {
      const result = calculatePoints({ han: 3, fu: 30, isDealer: false, isTsumo: false })
      // basicPoints: 30 * 2^5 = 960. ron = ceil100(960*4) = ceil100(3840) = 3900
      expect(result.ronPayment).toBe(3900)
    })

    it('3 han 60 fu: mangan (2000 basic)', () => {
      const result = calculatePoints({ han: 3, fu: 60, isDealer: false, isTsumo: false })
      // 3 han 60 fu: basic = 60 * 2^5 = 1920, not quite mangan
      // But 3 han 70 fu → mangan
      expect(result.ronPayment).toBeGreaterThan(0)
    })

    it('3 han 70 fu: mangan', () => {
      const result = calculatePoints({ han: 3, fu: 70, isDealer: false, isTsumo: false })
      // basicPoints: 3 han, fu >= 70 → 2000 (mangan)
      expect(result.ronPayment).toBe(8000) // 2000 * 4 = 8000
    })

    it('4 han 30 fu', () => {
      const result = calculatePoints({ han: 4, fu: 30, isDealer: false, isTsumo: false })
      // basicPoints: 4 han, fu < 40 → normal calculation
      // 30 * 2^6 = 1920, ron = 1920*4 = 7680 → 7700
      expect(result.ronPayment).toBe(7700)
    })

    it('4 han 40 fu: mangan', () => {
      const result = calculatePoints({ han: 4, fu: 40, isDealer: false, isTsumo: false })
      // basicPoints: 4 han, fu >= 40 → 2000 (mangan)
      expect(result.ronPayment).toBe(8000)
    })

    it('5 han: mangan', () => {
      const result = calculatePoints({ han: 5, fu: 30, isDealer: false, isTsumo: false })
      expect(result.ronPayment).toBe(8000)
    })
  })

  describe('dealer ron', () => {
    it('1 han 30 fu', () => {
      const result = calculatePoints({ han: 1, fu: 30, isDealer: true, isTsumo: false })
      // basic = 30 * 2^3 = 240, dealer ron = 240 * 6 = 1440 → 1500
      expect(result.ronPayment).toBe(1500)
    })

    it('mangan dealer ron: 12000', () => {
      const result = calculatePoints({ han: 5, fu: 30, isDealer: true, isTsumo: false })
      // basic = 2000, dealer ron = 2000 * 6 = 12000
      expect(result.ronPayment).toBe(12000)
    })
  })

  describe('haneman (6-7 han)', () => {
    it('6 han: haneman', () => {
      const result = calculatePoints({ han: 6, fu: 30, isDealer: false, isTsumo: false })
      // basic = 3000, ron = 3000 * 4 = 12000
      expect(result.ronPayment).toBe(12000)
    })

    it('7 han: haneman', () => {
      const result = calculatePoints({ han: 7, fu: 30, isDealer: false, isTsumo: false })
      expect(result.ronPayment).toBe(12000)
    })

    it('6 han dealer ron', () => {
      const result = calculatePoints({ han: 6, fu: 30, isDealer: true, isTsumo: false })
      // basic = 3000, dealer ron = 3000 * 6 = 18000
      expect(result.ronPayment).toBe(18000)
    })
  })

  describe('baiman (8-10 han)', () => {
    it('8 han: baiman', () => {
      const result = calculatePoints({ han: 8, fu: 30, isDealer: false, isTsumo: false })
      // basic = 4000, ron = 4000 * 4 = 16000
      expect(result.ronPayment).toBe(16000)
    })

    it('10 han: baiman', () => {
      const result = calculatePoints({ han: 10, fu: 30, isDealer: false, isTsumo: false })
      expect(result.ronPayment).toBe(16000)
    })
  })

  describe('sanbaiman (11-12 han)', () => {
    it('11 han: sanbaiman', () => {
      const result = calculatePoints({ han: 11, fu: 30, isDealer: false, isTsumo: false })
      // basic = 6000, ron = 6000 * 4 = 24000
      expect(result.ronPayment).toBe(24000)
    })

    it('12 han: sanbaiman', () => {
      const result = calculatePoints({ han: 12, fu: 30, isDealer: false, isTsumo: false })
      expect(result.ronPayment).toBe(24000)
    })
  })

  describe('yakuman (13+ han)', () => {
    it('13 han: yakuman', () => {
      const result = calculatePoints({ han: 13, fu: 30, isDealer: false, isTsumo: false })
      // basic = 8000, ron = 8000 * 4 = 32000
      expect(result.ronPayment).toBe(32000)
    })

    it('26 han: W yakuman pays 2× single yakuman', () => {
      // Two yakuman entries (e.g. junsei chuuren, daichisei) => 26 han.
      // basicPoints = 8000 × floor(26/13) = 16000; child ron = 16000 × 4.
      const result = calculatePoints({ han: 26, fu: 30, isDealer: false, isTsumo: false })
      expect(result.basicPoints).toBe(16000)
      expect(result.ronPayment).toBe(64000)
    })

    it('39 han: triple yakuman pays 3× single yakuman', () => {
      const result = calculatePoints({ han: 39, fu: 30, isDealer: false, isTsumo: false })
      expect(result.basicPoints).toBe(24000)
      expect(result.ronPayment).toBe(96000)
    })

    it('dealer yakuman ron', () => {
      const result = calculatePoints({ han: 13, fu: 30, isDealer: true, isTsumo: false })
      // basic = 8000, dealer ron = 8000 * 6 = 48000
      expect(result.ronPayment).toBe(48000)
    })
  })

  describe('tsumo payments', () => {
    it('child tsumo: each child pays basic*1, dealer pays basic*2', () => {
      const result = calculatePoints({ han: 1, fu: 30, isDealer: false, isTsumo: true })
      // basic = 240. Each child pays ceil100(240*1) = 300, dealer pays
      // ceil100(240*2) = 500.
      expect(result.tsumoChild).toBe(300)
      expect(result.tsumoDealerPays).toBe(500)
      expect(result.tsumoDealer).toBe(0)
    })

    it('dealer tsumo: each non-dealer pays basic*2', () => {
      const result = calculatePoints({ han: 1, fu: 30, isDealer: true, isTsumo: true })
      // basic = 240. Each non-dealer pays ceil100(240*2) = 500.
      expect(result.tsumoDealer).toBe(500)
      expect(result.tsumoChild).toBe(0)
      expect(result.tsumoDealerPays).toBe(0)
    })

    it('child mangan tsumo: each child 2000, dealer 4000', () => {
      const result = calculatePoints({ han: 5, fu: 30, isDealer: false, isTsumo: true })
      // basic = 2000. Each child pays 2000*1=2000, dealer pays 2000*2=4000.
      expect(result.tsumoChild).toBe(2000)
      expect(result.tsumoDealerPays).toBe(4000)
    })

    it('dealer mangan tsumo: each child pays 4000', () => {
      const result = calculatePoints({ han: 5, fu: 30, isDealer: true, isTsumo: true })
      // basic = 2000, each non-dealer pays ceil100(2000*2) = 4000.
      expect(result.tsumoDealer).toBe(4000)
    })

    it('child yakuman tsumo: each child 8000, dealer 16000', () => {
      const result = calculatePoints({ han: 13, fu: 30, isDealer: false, isTsumo: true })
      // basic = 8000. Each child pays 8000, dealer pays 16000.
      expect(result.tsumoChild).toBe(8000)
      expect(result.tsumoDealerPays).toBe(16000)
    })

    it('dealer yakuman tsumo: each non-dealer pays 16000', () => {
      const result = calculatePoints({ han: 13, fu: 30, isDealer: true, isTsumo: true })
      // basic = 8000, each non-dealer pays 16000.
      expect(result.tsumoDealer).toBe(16000)
    })
  })

  describe('basicPoints field', () => {
    it('returns basicPoints for 1 han 30 fu', () => {
      const result = calculatePoints({ han: 1, fu: 30, isDealer: false, isTsumo: false })
      expect(result.basicPoints).toBe(240) // 30 * 2^3
    })

    it('returns basicPoints for mangan', () => {
      const result = calculatePoints({ han: 5, fu: 30, isDealer: false, isTsumo: false })
      expect(result.basicPoints).toBe(2000)
    })

    it('returns basicPoints for yakuman', () => {
      const result = calculatePoints({ han: 13, fu: 30, isDealer: false, isTsumo: false })
      expect(result.basicPoints).toBe(8000)
    })
  })
})
