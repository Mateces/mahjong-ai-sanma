import type { TileType, Meld, Wind } from './types'
import { isDragon, isWind } from './tile-utils'
import { WIND_START, MANGAN_BASIC, HANEMAN_BASIC, BAIMAN_BASIC, SANBAIMAN_BASIC, YAKUMAN_BASIC } from './constants'

export interface FuContext {
  winningTile: TileType
  isTsumo: boolean
  isPinhu: boolean
  isMenzen?: boolean
  isChiitoi?: boolean
  melds: Meld[]
  pair: TileType
  mentsu: { tiles: TileType[] }[]
  seatWind: Wind
  roundWind: Wind
}

export function calculateFu(ctx: FuContext): number {
  // Bug fix 2: Chiitoi = 25 fu (fixed value, no rounding)
  if (ctx.isChiitoi) return 25

  // Bug fix 3: Pinhu ron should be 30, pinhu tsumo is 20
  if (ctx.isPinhu) return ctx.isTsumo ? 20 : 30

  let fu = 20 // base fu (fuutei)

  if (ctx.isTsumo) fu += 2 // tsumo bonus

  // Bug fix 4: Ron +10 only for menzen (concealed) hands (default: menzen)
  if (!ctx.isTsumo && ctx.isMenzen !== false) fu += 10

  // Pair yakuhai
  if (isDragon(ctx.pair)) fu += 2
  if (isWind(ctx.pair)) {
    if (ctx.pair === WIND_START + ctx.seatWind) fu += 2
    if (ctx.pair === WIND_START + ctx.roundWind) fu += 2
  }

  // Bug fix 5: Wait fu (tanki/kanchan/penchan)
  fu += calcWaitFu(ctx)

  // Ron ankou downgrade — the triplet completed by the ron tile becomes
  // minkou (concealed→open, halving the fu bonus). But the ron tile may
  // appear in MULTIPLE sets of the same decomposition: e.g. a hand with
  // 9,9,9 ankou + 9-10-11 sequence + ron-tile=9 has the 9 in both. The
  // wait shape determines which set is ron-completed: if any sequence
  // in the decomp absorbs the ron tile as a kanchan/penchan/ryanmen
  // wait, the ron is on the sequence — the triplet stays ankou. Only
  // when no such sequence exists is the win a shanpon, downgrading the
  // triplet. (L1.5+ replay caught the prior naive `mentsu.includes(win)`
  // form costing 4-8 fu per affected hand.)
  const hasSequenceWithWinTile = !ctx.isTsumo && ctx.mentsu.some(m =>
    m.tiles[0] !== m.tiles[1] && m.tiles.includes(ctx.winningTile),
  )
  for (const mentsu of ctx.mentsu) {
    const isTriplet = mentsu.tiles[0] === mentsu.tiles[1]
    const isRonKotsu =
      !ctx.isTsumo &&
      isTriplet &&
      mentsu.tiles.includes(ctx.winningTile) &&
      !hasSequenceWithWinTile
    fu += mentsuFu(mentsu.tiles, isRonKotsu)
  }

  // Audit fix C: open kan (kakan/daiminkan) is 8 fu (16 for terminal/honor),
  // i.e. 4× the open triplet (minkou) fu, mirroring how ankan is 4× ankou.
  // Previous code returned the minkou value directly, which was 4× too small.
  for (const meld of ctx.melds) {
    if (meld.type === 'pon') fu += mentsuFu(meld.tiles, true)
    if (meld.type === 'ankan') fu += mentsuFu(meld.tiles, false) * 4
    if (meld.type === 'kakan') fu += mentsuFu(meld.tiles, true) * 4
    if (meld.type === 'daiminkan') fu += mentsuFu(meld.tiles, true) * 4
  }

  const rounded = Math.ceil(fu / 10) * 10
  // 30-fu minimum rule for non-pinfu / non-chiitoi wins. Pinfu-tsumo (20)
  // and chiitoi (25) are returned early above; every other win — including
  // open pinfu-shape ron (kuipinfu) where the raw fu = 20 base with no
  // bonuses — rounds up to at least 30 fu. Without this floor an open all-
  // sequence ron scored 1 han 20 fu and undercut the real ronPayment by
  // one fu-step (1000 vs Tenhou's 30-fu-equivalent calc).
  return Math.max(30, rounded)
}

function calcWaitFu(ctx: FuContext): number {
  // Tanki: winning tile equals the pair
  if (ctx.winningTile === ctx.pair) return 2

  // Audit fix F: kanchan IS detectable from the final hand: it's the case
  // where the winning tile is the middle of a sequence (e.g. 3-?-5 with the
  // 4 completing). Penchan + kanchan both give +2 fu; ryanmen gives 0 (the
  // default base case).
  for (const mentsu of ctx.mentsu) {
    if (mentsu.tiles[0] === mentsu.tiles[1]) continue // triplet, not sequence
    const sorted = [...mentsu.tiles].sort((a, b) => a - b)
    const s = Math.floor(sorted[0] / 9)
    if (sorted.some(t => Math.floor(t / 9) !== s)) continue

    const ranks = sorted.map(t => t - s * 9)
    // Penchan low: won the 3 of 1-2-3 sequence
    if (ranks[0] === 0 && sorted[2] === ctx.winningTile) return 2
    // Penchan high: won the 7 of 7-8-9 sequence
    if (ranks[2] === 8 && sorted[0] === ctx.winningTile) return 2
    // Kanchan: won the middle of any sequence
    if (sorted[1] === ctx.winningTile) return 2
  }

  return 0
}

function mentsuFu(tiles: TileType[], isOpen: boolean): number {
  const isTriplet = tiles[0] === tiles[1]
  if (!isTriplet) return 0

  const base = isOpen ? 2 : 4
  const isTerminalOrHonor = tiles.some(t =>
    t === 0 || t === 8 || t === 9 || t === 17 || t === 18 || t === 26 || t >= 27
  )
  return isTerminalOrHonor ? base * 2 : base
}

export interface PointContext {
  han: number
  fu: number
  isDealer: boolean
  isTsumo: boolean
  /**
   * Player count: 3 = sanma, 4 = yonma. Affects tsumo payment distribution
   * (sanma child tsumo collects basic*2 from dealer + basic*1 from the one
   * other child, so the per-non-dealer tsumoChild value is the same as yonma
   * but is paid by only one player instead of two).
   */
  playerCount?: 3 | 4
}

export interface ScoreResult {
  /** Total points the loser pays in a ron win. */
  ronPayment: number
  /**
   * Per-payer tsumo payment when the dealer wins by tsumo: each non-dealer
   * pays this (= 2 × basic). Always 0 when winner is a child.
   */
  tsumoDealer: number
  /**
   * Per-non-dealer-payer tsumo payment when a child wins by tsumo (= 1 ×
   * basic). The dealer pays double this amount (see tsumoDealerPays below).
   * Always 0 when winner is the dealer.
   */
  tsumoChild: number
  /**
   * Tsumo payment the dealer pays when a child wins (= 2 × basic). Always
   * 0 when winner is the dealer.
   */
  tsumoDealerPays: number
  basicPoints: number
}

export function calculatePoints(ctx: PointContext): ScoreResult {
  const basic = basicPoints(ctx.han, ctx.fu)

  if (ctx.isDealer) {
    return {
      ronPayment: ceil100(basic * 6),
      tsumoDealer: ceil100(basic * 2),
      tsumoChild: 0,
      tsumoDealerPays: 0,
      basicPoints: basic,
    }
  }

  return {
    ronPayment: ceil100(basic * 4),
    tsumoDealer: 0,
    tsumoChild: ceil100(basic * 1),
    tsumoDealerPays: ceil100(basic * 2),
    basicPoints: basic,
  }
}

export function basicPoints(han: number, fu: number): number {
  // basicPoints is the unit from which payments are derived:
  // child ron = basic × 4, dealer ron = basic × 6
  // tsumo: each child pays basic, dealer pays basic × 2
  //
  // Multi-yakuman (han ≥ 13): scale by floor(han/13). One yakuman = 13 han,
  // W役満 = 26 han, 三倍役満 = 39 han, etc. Each stacked yakuman adds 8000
  // basic points. Prior to this change, all han ≥ 13 returned a flat 8000,
  // silently undercounting daisangen+suu_ankou and similar overlaps.
  if (han >= 13) return 8000 * Math.floor(han / 13)
  if (han >= 11) return 6000     // sanbaiman
  if (han >= 8) return 4000      // baiman
  if (han >= 6) return 3000      // haneman
  if (han >= 5) return 2000      // mangan
  if (han === 4 && fu >= 40) return 2000
  if (han === 3 && fu >= 70) return 2000
  return fu * Math.pow(2, 2 + han)
}

function ceil100(n: number): number {
  return Math.ceil(n / 100) * 100
}
