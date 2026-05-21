import type { DiscardEntry, GameView, MeldView, Pai, SeatView } from './types'

/**
 * Hardcoded mid-game GameView for Phase A layout iteration. Mid-East-1, P0
 * (us) has been called twice on, opponents have non-trivial rivers. No real
 * legality — purely a visual fixture.
 */

const d = (pai: Pai, opts: Partial<DiscardEntry> = {}): DiscardEntry => ({
  pai,
  tsumogiri: false,
  riichi: false,
  called: false,
  ...opts,
})

const meldChi = (called: Pai, c1: Pai, c2: Pai): MeldView => ({
  kind: 'chi',
  tiles: [called, c1, c2],
  calledIndex: 0,
})

const meldPon = (called: Pai): MeldView => ({
  kind: 'pon',
  tiles: [called, called, called],
  calledIndex: 0,
})

const p0Hand: Pai[] = ['1m', '2m', '3m', '4m', '5m', '6m', '7m', '0p', '6p', '7p', '2s', '3s', '4s']

const seat0: SeatView = {
  seatId: 0,
  hand: p0Hand,
  tsumo: '5p',
  river: [
    d('9m'), d('S'), d('N'), d('1p'),
    d('W'), d('C'), d('9s'),
    d('8s', { tsumogiri: true }),
  ],
  melds: [],
  score: 25000,
  seatWind: 0,
  riichi: false,
  mood: 'idle',
}

const seat1: SeatView = {
  seatId: 1,
  hand: Array<Pai>(13).fill('?'),
  tsumo: '?',
  river: [
    d('E'), d('N'), d('1m'), d('9p'),
    d('1s'), d('P'), d('S', { riichi: true }),
    d('2m', { tsumogiri: true }), d('3m', { tsumogiri: true }),
  ],
  melds: [],
  score: 27000,
  seatWind: 1,
  riichi: true,
  mood: 'tense',
}

const seat2: SeatView = {
  seatId: 2,
  hand: Array<Pai>(10).fill('?'),
  tsumo: null,
  river: [
    d('C'), d('P'), d('F'), d('9m'), d('1p'),
    d('2p', { called: true }), d('7s'), d('8m'),
  ],
  melds: [meldPon('F')],
  score: 23000,
  seatWind: 2,
  riichi: false,
  mood: 'idle',
}

const seat3: SeatView = {
  seatId: 3,
  hand: Array<Pai>(7).fill('?'),
  tsumo: null,
  river: [
    d('1s'), d('9s'), d('N'), d('W'),
    d('2m'), d('8p'), d('4s', { called: true }),
  ],
  melds: [meldChi('5s', '6s', '7s'), meldPon('F')],
  score: 25000,
  seatWind: 3,
  riichi: false,
  mood: 'idle',
}

export const DEMO_GAME: GameView = {
  me: 0,
  seats: [seat0, seat1, seat2, seat3],
  bakaze: 0,
  kyoku: 1,
  honba: 0,
  kyotaku: 1,
  wallRemaining: 42,
  doraIndicators: ['5s'],
  activeSeat: 0,
}
