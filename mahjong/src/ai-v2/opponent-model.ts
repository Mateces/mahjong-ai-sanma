import type { GameState, Player, TileType } from '../game/types'
import { doraFromIndicator } from '../game/tile-utils'
import { perTileRiskAgainst } from '../ai/danger-eval'

/**
 * Structured per-opponent threat model. Phase 3 of v2's EV architecture.
 *
 * v1 only knows a per-tile max-over-opponents danger scalar (assessDanger).
 * That conflates "this tile is dangerous against the riichi'd opponent"
 * with "this tile MIGHT be in someone's hand" — losing distinctions like
 * which opponent is the real threat, how much they'd win for, and whether
 * they're really at tenpai or just sitting on a meld.
 *
 * OpponentThreat splits the threat into:
 *  - `pTenpai`: probability the opponent is currently tenpai
 *  - `estHandValue`: expected points they win for (publicly inferable)
 *  - `dangerByTile`: per-tile risk against this specific opponent
 *  - `shape`: structural hints (honitsu / yakuhai / toitoi suspicion)
 *
 * dealInEV against this opponent for a tile = pTenpai × dangerByTile[t] × estHandValue.
 * Aggregated across opponents (Σ), this replaces v1's coarse
 * `danger × 8000` calculation.
 */
export interface OpponentThreat {
  player: Player
  pTenpai: number
  estHandValue: number
  dangerByTile: number[]
  shape: {
    pHonitsu: number
    pYakuhai: number
    pToitoi: number
  }
}

/** Heuristic: probability opponent has reached tenpai given public info. */
function estimatePTenpai(state: GameState, opp: Player): number {
  const player = state.players[opp]
  if (player.riichi) return 1.0
  if (player.melds.length >= 3) return 0.9

  let p = 0.05 // baseline
  if (player.discards.length >= 14) p += 0.25
  else if (player.discards.length >= 10) p += 0.15
  else if (player.discards.length >= 6) p += 0.08

  // Trailing tsumogiri: opponent stopped improving, likely tenpai.
  const recent = player.discards.slice(-4)
  const tsumogiri = recent.filter(d => d.tsumogiri).length
  if (tsumogiri >= 3) p += 0.2
  else if (tsumogiri >= 2) p += 0.1

  // Open melds raise tenpai likelihood structurally.
  if (player.melds.length === 2) p += 0.15
  else if (player.melds.length === 1) p += 0.05

  return Math.max(0, Math.min(1, p))
}

/** Public-info heuristic for opponent's expected won points. */
function estimateHandValue(state: GameState, opp: Player): number {
  const player = state.players[opp]
  const isSanma = state.playerCount === 3
  const doraTiles = state.doraMarkers.map(d => doraFromIndicator(d, isSanma))
  const isDealer = state.dealer === opp

  let han = 1 // baseline: riichi or menzen-tsumo or some minimal yaku

  // Visible dora from opponent's melds.
  let doraInMelds = 0
  for (const meld of player.melds) {
    for (const t of meld.tiles) {
      for (const d of doraTiles) {
        if (t === d) doraInMelds++
      }
    }
  }
  han += doraInMelds

  // Yakuhai melds: dragons or relevant winds visible.
  const seatWindTile = 27 + ((opp - state.dealer + state.playerCount) % state.playerCount)
  const roundWindTile = 27 + state.roundWind
  for (const meld of player.melds) {
    if (meld.type === 'pon' || meld.type === 'daiminkan' || meld.type === 'kakan') {
      const t = meld.tiles[0]
      if (t >= 31 && t <= 33) han++ // dragon
      else if (t === roundWindTile) han++ // round wind
      else if (t === seatWindTile && t !== roundWindTile) han++ // seat wind
    }
  }

  // Riichi adds 1 + expected ippatsu/uradora contributions.
  if (player.riichi) han += 2

  // Convert han to approximate ron payment, using standard mahjong table.
  let basic: number
  if (han >= 13) basic = 8000
  else if (han >= 11) basic = 6000
  else if (han >= 8) basic = 4000
  else if (han >= 6) basic = 3000
  else if (han >= 5) basic = 2000
  else basic = 30 * Math.pow(2, 2 + han) // fu approximation
  basic = Math.min(basic, 8000)

  const ronPayment = isDealer ? basic * 6 : basic * 4
  // Round to nearest 100.
  return Math.ceil(ronPayment / 100) * 100
}

/** Crude shape inference from melds and discard color spread. */
function estimateShape(state: GameState, opp: Player): OpponentThreat['shape'] {
  const player = state.players[opp]
  const isSanma = state.playerCount === 3

  // Honitsu (染め色) suspicion: count tiles by suit across melds + discards.
  // If one suit dominates and honors are kept, raise suspicion.
  const suitCounts = [0, 0, 0]
  let honorCount = 0
  const allVisible: TileType[] = []
  for (const m of player.melds) for (const t of m.tiles) allVisible.push(t)
  for (const d of player.discards) allVisible.push(d.tile)
  for (const t of allVisible) {
    if (t >= 27) honorCount++
    else suitCounts[Math.floor(t / 9)]++
  }
  const total = allVisible.length || 1
  const maxSuitFrac = Math.max(...suitCounts) / total
  // Pure honitsu: most of one suit + honors visible, very few off-suit discards.
  let pHonitsu = 0
  if (player.melds.length >= 1) {
    // Look at melds suit consistency.
    const meldSuits = new Set<number>()
    for (const m of player.melds) {
      for (const t of m.tiles) {
        if (t < 27) meldSuits.add(Math.floor(t / 9))
      }
    }
    if (meldSuits.size === 1) pHonitsu = Math.min(1, 0.3 + maxSuitFrac * 0.7)
    else if (meldSuits.size === 0) pHonitsu = 0.05 // all honors, possible suuanko unlikely
  }
  void isSanma

  // Yakuhai suspicion: opponent NOT discarding dragons/winds → keeping them.
  let pYakuhai = 0
  for (const m of player.melds) {
    if (m.type === 'pon' || m.type === 'daiminkan' || m.type === 'kakan') {
      const t = m.tiles[0]
      if (t >= 31 && t <= 33) pYakuhai = 1.0 // dragon pon, guaranteed yakuhai
      else if (t >= 27) pYakuhai = Math.max(pYakuhai, 0.5) // wind pon
    }
  }

  // Toitoi: multiple triplet melds.
  const kotsuMelds = player.melds.filter(
    m => m.type === 'pon' || m.type === 'daiminkan' || m.type === 'kakan' || m.type === 'ankan',
  ).length
  const pToitoi = kotsuMelds >= 2 ? 0.5 : kotsuMelds === 1 ? 0.1 : 0

  return { pHonitsu, pYakuhai, pToitoi }
}

export function modelOpponent(
  state: GameState,
  opp: Player,
  selfPlayer: Player,
): OpponentThreat {
  return {
    player: opp,
    pTenpai: estimatePTenpai(state, opp),
    estHandValue: estimateHandValue(state, opp),
    dangerByTile: perTileRiskAgainst(state, selfPlayer, opp),
    shape: estimateShape(state, opp),
  }
}
