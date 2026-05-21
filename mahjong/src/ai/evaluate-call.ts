import { calculateShanten } from '../game/shanten'
import { decomposeWinningHand } from '../game/hand-analysis'
import type { Action, GameState, Meld, Player, TileType } from '../game/types'
import { ActionKind } from '../game/types'
import { tileSuit } from '../game/tile-utils'
import { getVisibleTiles, calculateUkeire } from './tile-analysis'

/** A "simple" tile is 2-8 of m/p/s (the body of tanyao). */
function isSimple(tile: TileType): boolean {
  if (tile >= 27) return false
  const rank = tile % 9
  return rank >= 1 && rank <= 7
}

/**
 * Whether a yaochu tile (terminal or honor) can be discarded without
 * breaking useful structure:
 *  - Honors: always (no sequence membership)
 *  - 1m/1p/1s (rank 0): only when there's no adjacent (2) — otherwise it's
 *    in a 12 penchan or could form 123
 *  - 9m/9p/9s (rank 8): only when there's no adjacent (8) — otherwise it's
 *    in an 89 penchan
 *  - Any terminal with count ≥ 2: stuck (pair or triplet, costly to break)
 */
function isEasilyDiscardableTerminal(tile: TileType, counts: number[]): boolean {
  if (tile >= 27) return true
  if (counts[tile] >= 2) return false
  const rank = tile % 9
  if (rank === 0) return counts[tile + 1] === 0
  if (rank === 8) return counts[tile - 1] === 0
  return true // shouldn't happen — isSimple catches 1-7
}

/**
 * Strict check: given a complete 14-tile winning hand (concealed + meld
 * tiles combined), does it have at least one yaku that is achievable on
 * an open hand? Used to distinguish "shape-tenpai" from "actually winnable
 * tenpai" after a Pon or Chi — `calculateShanten` is shape-only and will
 * mark unwinnable 無役 tenpais as shanten=0.
 *
 * Covered yaku:
 *   - Yakuhai (三元 + 自風 + 場風 triplet)
 *   - Tanyao (all 2-8 of m/p/s)
 *   - Honitsu (single suit + honors)
 *   - Chinitsu (single suit, no honors)
 *   - Toitoi (no chi melds + 4 triplets + 1 pair count pattern)
 *
 * Not covered (skipped for MVP, will misclassify some hands as 無役):
 *   - sanshoku-doujun / sanshoku-doukou / ittsu / chanta / junchan
 *   - menzen-only yaku (riichi/ippatsu/pinfu/ipeiko/chiitoi/menzen-tsumo)
 *   - yakuman
 *
 * For most open-hand tenpais, the covered set is sufficient. False negatives
 * (genuine yaku missed) result in a candidate being scored as 1-shanten
 * instead of 0-shanten — strictly conservative, never miscalls a no-yaku
 * tenpai as winnable.
 */
function hasOpenYakuOnWinningHand(
  allTiles: TileType[],
  melds: Meld[],
  state: GameState,
  selfPlayer: Player,
): boolean {
  const counts = new Array<number>(34).fill(0)
  for (const t of allTiles) counts[t]++

  // 役牌: 三元 triplet
  for (let d = 31; d <= 33; d++) {
    if (counts[d] >= 3) return true
  }
  // 役牌: 自風 / 場風 triplet
  const seatWindTile =
    27 + ((selfPlayer - state.dealer + state.playerCount) % state.playerCount)
  const roundWindTile = 27 + state.roundWind
  if (counts[seatWindTile] >= 3) return true
  if (counts[roundWindTile] >= 3) return true

  // Tanyao: every tile is 2-8 of m/p/s
  if (allTiles.every(isSimple)) return true

  // Single-suit family (honitsu / chinitsu)
  let hasHonor = false
  const suits = new Set<number>()
  for (const t of allTiles) {
    if (t >= 27) hasHonor = true
    else suits.add(Math.floor(t / 9))
  }
  if (suits.size <= 1) return true // chinitsu (size=1, !hasHonor) or honitsu (size=1 + honor) or all-honor

  // Toitoi: no chi melds + count pattern is 1 pair + 4 triplets/kans
  const anyChi = melds.some(m => m.type === 'chi')
  if (!anyChi) {
    let pairs = 0
    let triplets = 0
    let others = 0
    for (let t = 0; t < 34; t++) {
      const c = counts[t]
      if (c === 0) continue
      if (c === 2) pairs++
      else if (c === 3 || c === 4) triplets++
      else others++
    }
    if (others === 0 && pairs === 1 && triplets === 4) return true
  }

  return false
}

/**
 * Iterate every possible winning tile for a tenpai-shape hand and return
 * true if at least one of them yields a yaku-bearing winning shape.
 *
 * `testHand` is the 10-tile (Pon) or post-discard concealed hand. `melds`
 * already includes the just-formed call. The wait tiles are checked
 * regardless of remaining-tile availability — we're asking "is the tenpai
 * shape winnable in principle", not "is the win likely".
 */
function hasYakuBearingTenpai(
  testHand: TileType[],
  melds: Meld[],
  state: GameState,
  selfPlayer: Player,
): boolean {
  const meldTiles: TileType[] = []
  for (const m of melds) for (const t of m.tiles) meldTiles.push(t)

  for (let t = 0 as TileType; t < 34; t++) {
    const allTiles = [...testHand, t, ...meldTiles]
    if (allTiles.length !== 14) continue // Pon/Chi paths produce 14; daiminkan would be 15
    const decomp = decomposeWinningHand(allTiles)
    if (!decomp) continue
    if (hasOpenYakuOnWinningHand(allTiles, melds, state, selfPlayer)) return true
  }
  return false
}

function hasYakuPotential(hand: TileType[], melds: Meld[], state: GameState, selfPlayer: Player): boolean {
  // After opening, riichi is impossible. Check if any non-riichi yaku is achievable.
  // Quick check: tanyao (all simples), yakuhai (dragon/wind triplets),
  // or any open-hand yaku
  const counts = new Array(34).fill(0)
  for (const t of hand) counts[t]++

  // Check for yakuhai in hand (dragon triplets or wind triplets)
  for (let d = 31; d <= 33; d++) {
    if (counts[d] >= 3) return true
  }
  const seatWindTile = 27 + ((selfPlayer - state.dealer + state.playerCount) % state.playerCount)
  const roundWindTile = 27 + state.roundWind
  if (counts[seatWindTile] >= 3) return true
  if (counts[roundWindTile] >= 3) return true

  // Check for yakuhai in existing melds
  for (const meld of melds) {
    if (meld.type === 'pon' || meld.type === 'daiminkan' || meld.type === 'kakan') {
      const t = meld.tiles[0]
      if (t >= 31 && t <= 33) return true
      if (t === seatWindTile || t === roundWindTile) return true
    }
  }

  // Check tanyao potential. Mainstream 食いタン setups tolerate a single
  // sheddable yaochu (honor or isolated terminal) — the standard "鳴いて 1
  // 巡で打 1m" pattern. Reject when any yaochu is locked in a meld (can
  // never be discarded), is paired/tripled in hand, or sits in a 12/89
  // penchan that breaks if discarded.
  let meldHasYaochu = false
  for (const meld of melds) {
    if (meld.tiles.some(t => !isSimple(t))) {
      meldHasYaochu = true
      break
    }
  }
  if (!meldHasYaochu) {
    let stuckYaochu = 0
    let looseYaochu = 0
    for (let t = 0; t < 34; t++) {
      if (counts[t] === 0) continue
      if (isSimple(t)) continue
      if (isEasilyDiscardableTerminal(t, counts)) {
        looseYaochu += counts[t]
      } else {
        stuckYaochu += counts[t]
      }
    }
    if (stuckYaochu === 0 && looseYaochu <= 1) return true
  }

  // Check toitoi potential: many triplets
  let triplets = 0
  for (let i = 0; i < 34; i++) if (counts[i] >= 3) triplets++
  for (const meld of melds) {
    if (meld.type === 'pon' || meld.type === 'ankan' || meld.type === 'daiminkan' || meld.type === 'kakan') triplets++
  }
  if (triplets >= 2) return true

  return false
}

function isYakuhai(tile: TileType, state: GameState, selfPlayer: Player): boolean {
  if (tile >= 31 && tile <= 33) return true
  const seatWindTile = 27 + ((selfPlayer - state.dealer + state.playerCount) % state.playerCount)
  if (tile === seatWindTile) return true
  const roundWindTile = 27 + state.roundWind
  if (tile === roundWindTile) return true
  return false
}

function isKuikaeChi(tiles: [TileType, TileType], called: TileType, discardTile: TileType): boolean {
  const suit = tileSuit(called)
  if (suit >= 3 || tileSuit(discardTile) !== suit) return false
  const allThree = [...tiles, called].sort((a, b) => a - b)
  for (const t of allThree) {
    if (discardTile === t) return true
    const rs = discardTile - (suit === 0 ? 0 : suit === 1 ? 9 : 18)
    const rt = t - (suit === 0 ? 0 : suit === 1 ? 9 : 18)
    if (Math.abs(rs - rt) === 3) return true
  }
  return false
}

function isKuikaePon(called: TileType, discardTile: TileType): boolean {
  return discardTile === called
}

/**
 * Tiered shanten penalty for Pon / Chi result. Replaces the previous flat
 * `-shanten * 10000` slope, which forced calls to reach 聴牌 immediately or
 * never fire at all. The relaxed table allows calls to one-shanten and
 * two-shanten outcomes — common opening lines for 役牌 / 断幺 / 混一色
 * routes — while still effectively disallowing calls that strand the hand
 * at 3-shanten or worse.
 *
 *   shanten | penalty   | net score after typical bonuses
 *   --------|-----------|--------------------------------
 *      0    |     0     | yakuhai pon → tenpai: ~7000
 *      1    |  -2000    | yakuhai pon → 1-shanten: ~5000
 *      2    |  -5000    | yakuhai pon → 2-shanten: ~2000
 *     ≥3    | -20000    | rejected vs Pass=0
 */
function shantenPenalty(s: number): number {
  if (s <= 0) return 0
  if (s === 1) return -2000
  if (s === 2) return -5000
  return -20000
}

/**
 * Bonus added when the post-call hand has at least one yaku route
 * (yakuhai / tanyao / honitsu / toitoi etc.). Without this, non-yakuhai
 * pon → 1-shanten was always negative (no inherent positive signal),
 * so 断幺 / 混一色 paths through pon never fired.
 */
const YAKU_PATH_BONUS = 2000

export function scoreCallActions(
  state: GameState,
  actions: Action[],
  selfPlayer: Player,
): number[] {
  const hand = state.players[selfPlayer].hand
  const currentShanten = calculateShanten(hand)
  const visible = getVisibleTiles(state, selfPlayer)
  const currentUkeire = calculateUkeire(hand, visible)

  return actions.map(action => {
    switch (action.kind) {
      case ActionKind.Ron:
        return 100000

      case ActionKind.Tsumo:
        return 100000

      case ActionKind.Ankan:
        return 50000

      case ActionKind.Kakan:
        return 40000

      case ActionKind.Pass:
        return 0

      case ActionKind.Pon: {
        let afterHand = [...hand]
        let removed = 0
        for (let i = afterHand.length - 1; i >= 0 && removed < 2; i--) {
          if (afterHand[i] === action.called) {
            afterHand.splice(i, 1)
            removed++
          }
        }

        const isYaku = isYakuhai(action.called, state, selfPlayer)

        if (afterHand.length === 0) return 30000

        // Build the post-pon meld list once; used by both the strict tenpai
        // yaku check (per testHand) and the coarser hasYakuPotential gate.
        const meldsWithPon: Meld[] = [
          ...state.players[selfPlayer].melds,
          {
            type: 'pon' as const,
            tiles: [action.called, action.called, action.called],
            calledFrom: state.lastDiscardPlayer ?? 0,
          },
        ]

        let bestScore = -Infinity
        for (let i = 0; i < afterHand.length; i++) {
          const discardTile = afterHand[i]
          if (isKuikaePon(action.called, discardTile)) continue
          const testHand = [...afterHand]
          testHand.splice(i, 1)
          // -1 adjusts for the new pon meld: regular shanten treats a 10-tile
          // hand as needing 4 mentsu + pair from scratch, but with the pon
          // we already have one mentsu locked.
          const shapeS = calculateShanten(testHand) - 1
          // Strict yaku check at shape-tenpai: if no winning tile produces a
          // yaku-bearing hand, demote this candidate to 1-shanten so the
          // tenpai-only +0 penalty doesn't mask an unwinnable 無役 hand.
          let effS = shapeS
          if (shapeS === 0) {
            if (!hasYakuBearingTenpai(testHand, meldsWithPon, state, selfPlayer)) {
              effS = 1
            }
          }
          const u = calculateUkeire(testHand, visible)
          const score = shantenPenalty(effS) + u * 10
          if (score > bestScore) bestScore = score
        }

        if (bestScore === -Infinity) return isYaku ? 1000 : -50000

        // Yaku-path classification: if the resulting open hand has any plausible
        // yaku route (yakuhai / tanyao / toitoi / honitsu pattern), reward; if
        // none at all, the call leads to an unwinnable hand — heavy penalty.
        // Yakuhai pons inherently have a yaku route (the pon itself), so they
        // always get the bonus.
        const hasPath = isYaku || hasYakuPotential(afterHand, meldsWithPon, state, selfPlayer)
        if (hasPath) {
          bestScore += YAKU_PATH_BONUS
        } else {
          bestScore -= 30000
        }

        return bestScore + (isYaku ? 5000 : 0)
      }

      case ActionKind.Chi: {
        let afterHand = [...hand]
        for (const t of action.tiles) {
          const idx = afterHand.indexOf(t)
          if (idx !== -1) afterHand.splice(idx, 1)
        }

        const meldsWithChi: Meld[] = [
          ...state.players[selfPlayer].melds,
          {
            type: 'chi' as const,
            tiles: [...action.tiles, action.called],
            calledFrom: state.lastDiscardPlayer ?? 0,
          },
        ]

        let bestScore = -Infinity
        for (let i = 0; i < afterHand.length; i++) {
          const discardTile = afterHand[i]
          if (isKuikaeChi(action.tiles, action.called, discardTile)) continue
          const testHand = [...afterHand]
          testHand.splice(i, 1)
          const shapeS = calculateShanten(testHand) - 1
          // Strict yaku check: chi-derived tenpai with no yaku is unwinnable
          // (no riichi after opening). Demote to 1-shanten so the candidate
          // doesn't masquerade as tenpai.
          let effS = shapeS
          if (shapeS === 0) {
            if (!hasYakuBearingTenpai(testHand, meldsWithChi, state, selfPlayer)) {
              effS = 1
            }
          }
          const u = calculateUkeire(testHand, visible)
          const score = shantenPenalty(effS) + u * 10
          if (score > bestScore) bestScore = score
        }

        if (bestScore === -Infinity) return -50000

        // Chi never carries an inherent yaku, so without a yaku path the
        // hand cannot win (no 立直 after opening). Reward yaku-path
        // resulting hands; punish those without.
        if (hasYakuPotential(afterHand, meldsWithChi, state, selfPlayer)) {
          bestScore += YAKU_PATH_BONUS
        } else {
          bestScore -= 30000
        }

        return bestScore
      }

      case ActionKind.Daiminkan: {
        const afterHand = [...hand]
        let removed = 0
        for (let i = afterHand.length - 1; i >= 0 && removed < 3; i--) {
          if (afterHand[i] === action.called) {
            afterHand.splice(i, 1)
            removed++
          }
        }
        if (afterHand.length === 0) return 10000

        const baseScore = calculateShanten(afterHand) < currentShanten ? -10000 : -50000

        // Yaku-less daiminkan penalty (mirrors pon/chi). Yakuhai kans are
        // always fine — the kan itself supplies the yaku. For non-yakuhai
        // kans, the resulting open hand still needs a yaku path (tanyao,
        // toitoi, honitsu, ...) or it can never win, and we should never
        // call into that.
        const isYaku = isYakuhai(action.called, state, selfPlayer)
        if (!isYaku) {
          const meldsWithKan: Meld[] = [
            ...state.players[selfPlayer].melds,
            {
              type: 'daiminkan' as const,
              tiles: [action.called, action.called, action.called, action.called],
              calledFrom: state.lastDiscardPlayer ?? 0,
            },
          ]
          if (!hasYakuPotential(afterHand, meldsWithKan, state, selfPlayer)) {
            return baseScore - 30000
          }
        }

        return baseScore
      }

      case ActionKind.Kyushukyuhai:
        return -100000

      case ActionKind.Kita: {
        // Sanma 抜き北 strategy: declare kita by default (it's a free +1 dora).
        // Exceptions where keeping the 北 in hand is better:
        //   1. shanten ≤ 0 — already tenpai or winning. Declaring kita
        //      would draw a rinshan tile and may break the wait.
        //   2. kitaInHand ≥ 2 AND shanten ≤ kitaInHand — likely 国士無双
        //      attempt (北 is one of the 13 yaochu tiles, and a 北 pair
        //      is fine for kokushi). Keep them.
        // The 35000 score sits above any Discard rank (max BASE=30000) so
        // the AI prefers kita over a discard when conditions favor it.
        const hand = state.players[selfPlayer].hand
        const shanten = calculateShanten(hand)
        const kitaInHand = hand.filter(t => t === 30).length
        if (shanten <= 0) return -10000
        if (kitaInHand >= 2 && shanten <= kitaInHand) return -10000
        return 35000
      }

      default:
        return 0
    }
  })
}
