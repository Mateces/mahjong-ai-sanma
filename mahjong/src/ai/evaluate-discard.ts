import type { TileType, GameState, Player, Action } from '../game/types'
import { ActionKind } from '../game/types'
import { tileSuit, doraFromIndicator, countTiles } from '../game/tile-utils'
import { calculateShanten, shantenFromCounts } from '../game/shanten'
import { getVisibleTiles, calculateUkeire } from './tile-analysis'
import { assessDanger } from './danger-eval'

interface CandidateResult {
  tile: TileType
  action: Action
  shanten: number
  waitsCount: number
  avgNextWaits: number
  avgImproveWaits: number
  speedScore: number
  mixedRoundPoint: number
  discardTileValue: number
  isIsolatedYaochu: boolean
  danger: number
  furitenRate: number
}

function isTerminalOrHonor(t: TileType): boolean {
  return t >= 27 || t % 9 === 0 || t % 9 === 8
}

function isYakuhai(tile: TileType, state: GameState, selfPlayer: Player): boolean {
  if (tile >= 31 && tile <= 33) return true
  const seatWindTile = 27 + ((selfPlayer - state.dealer + state.playerCount) % state.playerCount)
  if (tile === seatWindTile) return true
  const roundWindTile = 27 + state.roundWind
  if (tile === roundWindTile) return true
  return false
}

function isIsolatedYaochu(tile: TileType, counts: number[]): boolean {
  if (!isTerminalOrHonor(tile)) return false
  if (tile >= 27) return counts[tile] <= 1
  const rank = tile % 9
  const suitStart = tile - rank
  if (counts[tile] >= 2) return false
  if (rank === 0) return counts[suitStart + 1] === 0 && counts[suitStart + 2] === 0
  if (rank === 8) return counts[suitStart + 7] === 0 && counts[suitStart + 6] === 0
  return false
}

function calcDiscardTileValue(tile: TileType, counts: number[], state: GameState, selfPlayer: Player): number {
  let value = counts[tile] * 1000
  if (isYakuhai(tile, state, selfPlayer)) value += 500
  const isSanma = state.playerCount === 3
  const doraTiles = state.doraMarkers.map(d => doraFromIndicator(d, isSanma))
  for (const d of doraTiles) {
    if (tile === d) value += 2000
    const s = tileSuit(tile)
    const ds = tileSuit(d)
    if (s < 3 && s === ds && Math.abs(tile - d) === 1) value += 500
  }
  return value
}

function calcSpeedScore(waitsCount: number, avgNextWaits: number, leftCount: number): number {
  if (waitsCount === 0 || avgNextWaits === 0) return 0
  const p2 = waitsCount / leftCount
  const p1 = avgNextWaits / leftCount
  const p2_ = 1 - p2
  const p1_ = 1 - p1
  if (Math.abs(p2_ - p1_) < 1e-9) return 0
  const leftTurns = 10
  const sumP2 = p2_ * (1 - Math.pow(p2_, leftTurns)) / p2
  const sumP1 = p1_ * (1 - Math.pow(p1_, leftTurns)) / p1
  return p2 * p1 * (sumP2 - sumP1) / (p2_ - p1_) * 100
}

// Bug 14: proper basic points table
function calcBasicPoints(han: number, fu: number): number {
  if (han >= 13) return 8000
  if (han >= 11) return 6000
  if (han >= 8) return 4000
  if (han >= 6) return 3000
  if (han >= 5) return 2000
  if (han === 4 && fu >= 40) return 2000
  if (han === 3 && fu >= 70) return 2000
  return fu * Math.pow(2, 2 + han)
}

// Bug 14: estimate points from observable hand features.
// `bonusHan` lets the caller add han from situational yaku that aren't
// derivable from the hand alone (e.g. +1 for riichi, +1 for menzen tsumo).
// Exported so strategies can reuse this without re-deriving the heuristic.
export function estimatePoints(hand: TileType[], state: GameState, selfPlayer: Player, bonusHan = 0): number {
  const counts = countTiles(hand)
  const isDealer = state.dealer === selfPlayer
  const isSanma = state.playerCount === 3
  const player = state.players[selfPlayer]

  let han = 0
  for (const m of state.doraMarkers) {
    const d = doraFromIndicator(m, isSanma)
    han += counts[d]
  }
  // Sanma kita is independent dora: each 抜き北 in front of the player adds
  // +1 han at win time, and if any dora indicator points to North (西 = 29),
  // each kita counts double per Mahjong Soul rules.
  if (isSanma && player.kitaCount > 0) {
    han += player.kitaCount
    if (state.doraMarkers.some(m => doraFromIndicator(m, isSanma) === 30)) {
      han += player.kitaCount
    }
  }

  let allSimples = true
  for (const t of hand) {
    if (t >= 27 || t % 9 === 0 || t % 9 === 8) { allSimples = false; break }
  }
  if (allSimples) han += 1

  for (let d = 31; d <= 33; d++) { if (counts[d] >= 3) han += 1 }
  const seatWindTile = 27 + ((selfPlayer - state.dealer + state.playerCount) % state.playerCount)
  const roundWindTile = 27 + state.roundWind
  if (counts[seatWindTile] >= 3) han += 1
  if (counts[roundWindTile] >= 3 && roundWindTile !== seatWindTile) han += 1

  han = Math.max(han, 1) + bonusHan
  const fu = 30

  const basic = calcBasicPoints(han, fu)
  if (isDealer) return basic * 6
  return basic * 4
}

// Bug 12: furiten detection
function checkFuriten(hand: TileType[], selfDiscards: { tile: TileType }[]): boolean {
  const counts = countTiles(hand)
  const discardSet = new Set(selfDiscards.map(d => d.tile))

  for (let t = 0; t < 34; t++) {
    counts[t]++
    const newShanten = shantenFromCounts(counts)
    counts[t]--
    if (newShanten < 0 && discardSet.has(t)) {
      return true
    }
  }
  return false
}

/**
 * Type for a points-estimating function. `estimatePoints` is the v1 default;
 * v2 injects a path-enumerated yaku-aware version that's more accurate at
 * tenpai (replaces estimatePoints' heuristic hand-feature aggregate with a
 * per-wait evaluateWin call). Same return contract: average expected
 * ron-payment-equivalent points for the hand.
 */
export type PointsEstimator = (
  hand: TileType[], state: GameState, selfPlayer: Player, bonusHan: number,
) => number

/**
 * Type for a deal-in EV evaluator. Returns expected points lost from
 * discarding `tile` (sum over opponents of pTenpai × dangerByTile × value).
 * v2 Phase 3 injects an OpponentModel-based implementation; v1 / no
 * injection leaves dealin out of mixedRoundPoint (v1 treats danger as a
 * sort tiebreaker only).
 */
export type DealinEvaluator = (
  state: GameState, selfPlayer: Player, tile: TileType,
) => number

// Bug 12,13,14: improved mixed round point with serial probability, point
// estimation, furiten. `isRiichi` lets the caller signal that this candidate
// is a Riichi declaration; estimatePoints then adds 1 han for the riichi
// yaku itself, so Riichi:X is preferred over Discard:X for the same tile
// (previously they tied and stable-sort always picked the Discard).
function calcMixedRoundPoint(
  shanten: number, waitsCount: number, totalRemaining: number,
  hand: TileType[], state: GameState, selfPlayer: Player, furitenRate: number,
  isRiichi = false,
  pointsEstimator: PointsEstimator = estimatePoints,
  dealinEV: number = 0,
): number {
  const weight = -1500
  if (shanten > 0) {
    // Phase 3: even at non-tenpai, dealin risk is real once an opponent is
    // tenpai. Subtract dealinEV so dangerous discards are demoted before
    // the v1 fallback ranks ties via speedScore.
    return -dealinEV
  }
  const leftTurns = Math.min(10, totalRemaining / 4)
  const p = waitsCount / totalRemaining
  const agariRate = Math.min(1 - Math.pow(1 - p, leftTurns), 0.6)
  const bonusHan = isRiichi ? 1 : 0
  const pointEstimate = pointsEstimator(hand, state, selfPlayer, bonusHan)

  if (furitenRate > 0) {
    const tsumoOnlyRate = agariRate * 0.3
    return tsumoOnlyRate * (pointEstimate * 0.5 + 1500) + weight - dealinEV
  }

  return agariRate * (pointEstimate + 1500) + weight - dealinEV
}

function goodTileFirstCompare(a: TileType, b: TileType): boolean {
  if (a < 27 && b < 27) {
    const da = Math.min(a % 9, 8 - a % 9)
    const db = Math.min(b % 9, 8 - b % 9)
    if (da !== db) return da > db
  }
  if (a < 27 || b < 27) return a < 27
  return a > b
}

function inDelta(a: number, b: number, delta: number): boolean {
  return Math.abs(a - b) <= delta
}

// Bug 4: bestShanten parameter; Bug 3: waitsCount tiebreaker; Bug 2: linear formula
function compareCandidates(a: CandidateResult, b: CandidateResult, bestShanten: number): number {
  if (a.waitsCount === 0 || b.waitsCount === 0) {
    if (a.waitsCount === 0 && b.waitsCount === 0) {
      return b.avgImproveWaits - a.avgImproveWaits
    }
    return b.waitsCount - a.waitsCount
  }

  if (bestShanten === 0) {
    if (!inDelta(a.mixedRoundPoint, b.mixedRoundPoint, 100)) {
      return b.mixedRoundPoint - a.mixedRoundPoint
    }
    if (a.waitsCount !== b.waitsCount) return b.waitsCount - a.waitsCount
  }

  if (bestShanten === 1) {
    // Go's logic: when mixedRoundPoint is negative (losing position), more
    // waits is better — divide instead of multiply to bring score closer to
    // zero. When non-negative, multiply normally.
    const wA = a.mixedRoundPoint < 0 ? 1 / Math.max(a.waitsCount, 1) : a.waitsCount
    const wB = b.mixedRoundPoint < 0 ? 1 / Math.max(b.waitsCount, 1) : b.waitsCount
    const scoreA = wA * a.mixedRoundPoint
    const scoreB = wB * b.mixedRoundPoint
    // Audit fix I: scores are in points-scale (thousands), 0.01 delta is
    // never satisfied. Use 100 to actually catch near-ties.
    if (!inDelta(scoreA, scoreB, 100)) return scoreB - scoreA
  }

  if (bestShanten >= 2) {
    if (a.isIsolatedYaochu && b.isIsolatedYaochu) {
      if (a.discardTileValue !== b.discardTileValue) return a.discardTileValue - b.discardTileValue
    } else if (a.isIsolatedYaochu && a.discardTileValue < 500) {
      return -1
    } else if (b.isIsolatedYaochu && b.discardTileValue < 500) {
      return 1
    }
  }

  if (!inDelta(a.speedScore, b.speedScore, 0.01)) return b.speedScore - a.speedScore
  if (a.waitsCount !== b.waitsCount) return b.waitsCount - a.waitsCount
  if (!inDelta(a.avgNextWaits, b.avgNextWaits, 0.01)) return b.avgNextWaits - a.avgNextWaits
  if (!inDelta(a.avgImproveWaits, b.avgImproveWaits, 0.01)) return b.avgImproveWaits - a.avgImproveWaits
  if (a.discardTileValue !== b.discardTileValue) return a.discardTileValue - b.discardTileValue
  if (Math.abs(a.danger - b.danger) > 0.01) return a.danger - b.danger
  return goodTileFirstCompare(a.tile, b.tile) ? -1 : 1
}

export function scoreDiscardActions(
  state: GameState,
  actions: Action[],
  selfPlayer: Player,
  pointsEstimator: PointsEstimator = estimatePoints,
  dealinEvaluator?: DealinEvaluator,
): number[] {
  const hand = state.players[selfPlayer].hand
  const originalShanten = calculateShanten(hand)
  const visible = getVisibleTiles(state, selfPlayer)
  const leftCount = new Array(34).fill(0)
  let totalLeft = 0
  for (let t = 0; t < 34; t++) {
    leftCount[t] = 4 - visible[t]
    totalLeft += leftCount[t]
  }

  const candidates: CandidateResult[] = []

  for (const action of actions) {
    if (action.kind !== ActionKind.Discard && action.kind !== ActionKind.Riichi) {
      candidates.push({
        tile: -1 as TileType, action, shanten: 99, waitsCount: 0,
        avgNextWaits: 0, avgImproveWaits: 0, speedScore: 0,
        mixedRoundPoint: 0, discardTileValue: 0, isIsolatedYaochu: false, danger: 0, furitenRate: 0,
      })
      continue
    }

    const tile = action.tile
    const remainingHand = [...hand]
    const idx = remainingHand.indexOf(tile)
    if (idx === -1) {
      candidates.push({
        tile, action, shanten: 99, waitsCount: 0,
        avgNextWaits: 0, avgImproveWaits: 0, speedScore: 0,
        mixedRoundPoint: 0, discardTileValue: 0, isIsolatedYaochu: false, danger: 0, furitenRate: 0,
      })
      continue
    }
    remainingHand.splice(idx, 1)

    const shanten = calculateShanten(remainingHand)
    const waitsCount = shanten <= originalShanten ? calculateUkeire(remainingHand, visible) : 0

    let avgNextWaits = 0
    let avgImproveWaits = waitsCount

    if (waitsCount > 0) {
      let nextWaitsSum = 0
      let nextWaitsWeight = 0
      for (let t = 0; t < 34; t++) {
        if (leftCount[t] <= 0) continue
        const testHand = [...remainingHand, t]
        const testShanten = calculateShanten(testHand)
        if (testShanten < shanten) {
          const testUkeire = calculateUkeire(testHand, visible)
          nextWaitsSum += testUkeire * leftCount[t]
          nextWaitsWeight += leftCount[t]
        }
      }
      if (nextWaitsWeight > 0) avgNextWaits = nextWaitsSum / nextWaitsWeight
    }

    if (shanten === originalShanten && shanten <= 1) {
      let improveWays = 0
      let improveSum = waitsCount * totalLeft
      for (let t = 0; t < 34; t++) {
        if (leftCount[t] <= 0) continue
        const testHand = [...remainingHand, t]
        const testShanten = calculateShanten(testHand)
        if (testShanten < shanten) continue
        const testUkeire = calculateUkeire(testHand, visible)
        if (testUkeire > waitsCount) {
          improveSum += (testUkeire - waitsCount) * leftCount[t]
          improveWays += leftCount[t]
        }
      }
      avgImproveWaits = improveSum / totalLeft
    }

    // Bug 7: speedScore /= 4 for sanshanten
    const speedScore = calcSpeedScore(waitsCount, avgNextWaits, totalLeft)
    const adjustedSpeedScore = shanten >= 2 ? speedScore / 4 : speedScore

    // Bug 12: furiten detection
    let furitenRate = 0
    if (shanten === 0 && waitsCount > 0) {
      furitenRate = checkFuriten(remainingHand, state.players[selfPlayer].discards) ? 1 : 0
    }

    const isRiichiAction = action.kind === ActionKind.Riichi
    const dealinEV = dealinEvaluator ? dealinEvaluator(state, selfPlayer, tile) : 0
    const mixedRoundPoint = calcMixedRoundPoint(shanten, waitsCount, totalLeft, remainingHand, state, selfPlayer, furitenRate, isRiichiAction, pointsEstimator, dealinEV)

    const counts = new Array(34).fill(0)
    for (const t of remainingHand) counts[t]++
    const discardTileValue = calcDiscardTileValue(tile, counts, state, selfPlayer)
    const isIsolated = isIsolatedYaochu(tile, counts)
    const danger = assessDanger(state, selfPlayer, tile)

    candidates.push({
      tile, action, shanten, waitsCount, avgNextWaits, avgImproveWaits,
      speedScore: adjustedSpeedScore, mixedRoundPoint, discardTileValue, isIsolatedYaochu: isIsolated, danger, furitenRate,
    })
  }

  const discardCandidates = candidates.filter(c => c.tile >= 0)

  // Audit fix B: bestShanten must be computed BEFORE sort. Reading
  // discardCandidates[0] inside the comparator is undefined behavior because
  // Array.sort is in-place and [0] changes mid-sort.
  const bestShanten = discardCandidates.length > 0
    ? discardCandidates.reduce((min, c) => Math.min(min, c.shanten), Infinity)
    : originalShanten

  discardCandidates.sort((a, b) => {
    if (a.shanten > originalShanten && b.shanten <= originalShanten) return 1
    if (b.shanten > originalShanten && a.shanten <= originalShanten) return -1
    return compareCandidates(a, b, bestShanten)
  })

  const scores = new Array(actions.length).fill(0)

  // Plan A: drop the scalar score formula entirely and derive scores from the
  // compareCandidates rank instead. mahjong-helper itself has no scalar
  // "score" — it ranks candidates with a multi-criteria comparator and takes
  // the top of the list. Forcing all signals (mixedRoundPoint, danger,
  // discardTileValue, etc.) into one number was a lossy port that introduced
  // sign / magnitude / unit bugs we were chasing one at a time.
  //
  // Score range chosen to interleave with scoreCallActions:
  //   Tsumo            100000  (always wins)
  //   Ankan             50000  (call action, fixed)
  //   Kakan             40000  (call action, fixed)
  //   Discard rank 0    30000  (top of compareCandidates ordering)
  //   Discard rank N    30000 - N * 100
  //   Pass                  0
  //   Daiminkan        -10000  (call action, post-Bug-18 penalty)
  //   Shanten regress  -10000  (any discard that takes us further from win)
  //   Kyushukyuhai    -100000
  const BASE = 30000
  const STEP = 100
  const REGRESS = -10000

  const assignedScores = new Map<string, number>()
  let rank = 0
  for (const candidate of discardCandidates) {
    const key = `${candidate.action.kind}:${candidate.tile}`
    let score: number
    if (candidate.shanten > originalShanten) {
      score = REGRESS
    } else {
      score = BASE - rank * STEP
      rank++
    }
    const existing = assignedScores.get(key)
    if (existing === undefined || score > existing) {
      assignedScores.set(key, score)
    }
  }

  // Riichi:X must never score below Discard:X for the same tile. Riichi is
  // strictly an upgrade in expected value when tenpai (the +1 han is already
  // baked into mixedRoundPoint, so compareCandidates usually puts Riichi:X
  // ahead). Edge case: when waitsCount is zero or the comparator otherwise
  // ties, the rank order is undefined; this clamp guarantees the AI never
  // prefers a plain discard over its own riichi for the same tile.
  for (const action of actions) {
    if (action.kind === ActionKind.Riichi) {
      const riichiKey = `${ActionKind.Riichi}:${action.tile}`
      const discardKey = `${ActionKind.Discard}:${action.tile}`
      const ds = assignedScores.get(discardKey)
      const rs = assignedScores.get(riichiKey)
      if (ds !== undefined && rs !== undefined && rs < ds) {
        assignedScores.set(riichiKey, ds)
      }
    }
  }

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i]
    if (action.kind === ActionKind.Discard || action.kind === ActionKind.Riichi) {
      const s = assignedScores.get(`${action.kind}:${action.tile}`)
      if (s !== undefined) scores[i] = s
    }
  }

  return scores
}
