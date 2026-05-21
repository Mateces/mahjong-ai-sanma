import type { TileType, GameState, Player } from '../game/types'
import { tileSuit, doraFromIndicator } from '../game/tile-utils'
import { getVisibleTiles } from './tile-analysis'
import {
  RiskRate, MaxTurns, TileTypeTable, HonorTileType,
  FixedDoraRiskRateMulti, RiskTileType,
} from './risk-data'

function calcLowRiskTiles27(safeTiles34: boolean[], leftTiles34: number[], playerCount: 3 | 4 = 4): number[] {
  const lowRisk = new Array(27).fill(0)
  for (let i = 0; i < 27; i++) {
    if (safeTiles34[i]) lowRisk[i] = 1
  }
  for (let s = 0; s < 3; s++) {
    // Sanma man suit (s=0) only has 1m and 9m. The NC inference uses absence
    // of middle tiles to deduce safety, but in sanma the middle tiles are
    // never in play to begin with — applying NC here would falsely brand
    // 1m/9m as safe.
    if (playerCount === 3 && s === 0) continue
    const b = s * 9
    if (leftTiles34[b + 1] === 0) lowRisk[b] = 1
    if (leftTiles34[b + 2] === 0) { lowRisk[b] = 1; lowRisk[b + 1] = 1 }
    if (leftTiles34[b + 3] === 0) { lowRisk[b + 1] = 1; lowRisk[b + 2] = 1 }
    if (leftTiles34[b + 5] === 0) { lowRisk[b + 6] = 1; lowRisk[b + 7] = 1 }
    if (leftTiles34[b + 6] === 0) { lowRisk[b + 7] = 1; lowRisk[b + 8] = 1 }
    if (leftTiles34[b + 7] === 0) lowRisk[b + 8] = 1
  }
  return lowRisk
}

function calcNCSafeTiles(leftTiles34: number[]): number[] {
  const result: number[] = []
  const nc = (i: number) => leftTiles34[i] === 0
  const orNc = (...is: number[]) => is.some(nc)
  for (let s = 0; s < 3; s++) {
    for (let j = 0; j < 3; j++) {
      const idx = s * 9 + j
      if (orNc(idx + 1, idx + 2)) result.push(idx)
    }
    for (let j = 3; j < 6; j++) {
      const idx = s * 9 + j
      if (orNc(idx - 2, idx - 1) && orNc(idx + 1, idx + 2)) result.push(idx)
    }
    for (let j = 6; j < 9; j++) {
      const idx = s * 9 + j
      if (orNc(idx - 2, idx - 1)) result.push(idx)
    }
  }
  return result
}

function calcDNCSafeTilesWithDiscards(leftTiles34: number[], safeTiles34: boolean[]): number[] {
  const result = new Set<number>()
  const nc = (i: number) => leftTiles34[i] === 0
  const orNc = (...is: number[]) => is.some(nc)
  const andNc = (...is: number[]) => is.every(nc)

  for (let s = 0; s < 3; s++) {
    const b = s * 9
    if (orNc(b + 1, b + 2)) result.add(b)
    if (nc(b + 2) || andNc(b, b + 3)) result.add(b + 1)
    for (let j = 2; j <= 6; j++) {
      const idx = b + j
      if (andNc(idx - 2, idx + 1) || andNc(idx - 1, idx + 1) || andNc(idx - 1, idx + 2))
        result.add(idx)
    }
    if (nc(b + 6) || andNc(b + 5, b + 8)) result.add(b + 7)
    if (orNc(b + 6, b + 7)) result.add(b + 8)
  }

  for (let s = 0; s < 3; s++) {
    const b = s * 9
    for (let j = 1; j < 3; j++) {
      const idx = b + j
      if (nc(idx - 1) && safeTiles34[idx + 3]) result.add(idx)
    }
    for (let j = 3; j < 6; j++) {
      const idx = b + j
      if (nc(idx - 1) && safeTiles34[idx + 3] || nc(idx + 1) && safeTiles34[idx - 3])
        result.add(idx)
    }
    for (let j = 6; j < 8; j++) {
      const idx = b + j
      if (nc(idx + 1) && safeTiles34[idx - 3]) result.add(idx)
    }
  }

  return [...result]
}

function doraMulti(tile: number, tileType: number, doraTiles: number[]): number {
  let m = 1.0
  for (const d of doraTiles) {
    if (tile === d) m *= FixedDoraRiskRateMulti[tileType]
  }
  return m
}

function calculateRiskTiles34(
  turns: number,
  safeTiles34: boolean[],
  leftTiles34: number[],
  doraTiles: number[],
  roundWindTile: number,
  playerWindTile: number,
  playerCount: 3 | 4 = 4,
): number[] {
  const risk34 = new Array(34).fill(0)
  const lowRisk = calcLowRiskTiles27(safeTiles34, leftTiles34, playerCount)

  for (let s = 0; s < 3; s++) {
    // Sanma man suit: only 1m and 9m exist. Skip the suji/penchan/etc. inference
    // that assumes a full 1-9 sequence; instead set 1m/9m to a Suji19 baseline
    // (single/pair/triplet wait risk) below, and leave 2m-8m as 0 (don't exist).
    if (playerCount === 3 && s === 0) continue

    for (let j = 0; j < 3; j++) {
      const idx = s * 9 + j
      const t = TileTypeTable[j][lowRisk[idx + 3]]
      risk34[idx] = RiskRate[turns][t] * doraMulti(idx, t, doraTiles)
      if (j === 0 && safeTiles34[idx + 3] && leftTiles34[idx] === 0) risk34[idx] = 0
    }
    for (let j = 3; j < 6; j++) {
      const idx = s * 9 + j
      const mix = (lowRisk[idx - 3] << 1) | lowRisk[idx + 3]
      const t = TileTypeTable[j][mix]
      risk34[idx] = RiskRate[turns][t] * doraMulti(idx, t, doraTiles)
    }
    for (let j = 6; j < 9; j++) {
      const idx = s * 9 + j
      const t = TileTypeTable[j][lowRisk[idx - 3]]
      risk34[idx] = RiskRate[turns][t] * doraMulti(idx, t, doraTiles)
      if (j === 8 && safeTiles34[idx - 3] && leftTiles34[idx] === 0) risk34[idx] = 0
    }
    if (leftTiles34[s * 9 + 4] === 0) {
      const t = RiskTileType.Suji37
      risk34[s * 9 + 2] = RiskRate[turns][t] * doraMulti(s * 9 + 2, t, doraTiles)
      risk34[s * 9 + 6] = RiskRate[turns][t] * doraMulti(s * 9 + 6, t, doraTiles)
    }
  }

  // Sanma 1m / 9m: baseline risk via the Suji19 category (single / pair /
  // triplet wait only, no sequences possible). 2m-8m don't exist → 0.
  if (playerCount === 3) {
    for (const idx of [0, 8]) {
      if (leftTiles34[idx] > 0 && !safeTiles34[idx]) {
        const t = RiskTileType.Suji19
        risk34[idx] = RiskRate[turns][t] * doraMulti(idx, t, doraTiles)
      }
    }
  }

  for (let i = 27; i < 34; i++) {
    if (leftTiles34[i] > 0) {
      const isYakuHai = i === roundWindTile || i === playerWindTile || i >= 31
      const t = HonorTileType[isYakuHai ? 1 : 0][leftTiles34[i] - 1]
      risk34[i] = RiskRate[turns][t] * doraMulti(i, t, doraTiles)
    }
  }

  for (const idx of calcNCSafeTiles(leftTiles34)) {
    const rank = idx % 9 + 1
    let t: number
    switch (rank) {
      case 1: case 9: t = RiskTileType.Suji19; break
      case 2: case 8: t = RiskTileType.Suji19; break
      case 3: case 7: t = RiskTileType.Suji28; break
      case 4: case 6: t = RiskTileType.DoubleSuji46; break
      default: t = RiskTileType.DoubleSuji5; break
    }
    risk34[idx] = RiskRate[turns][t] * doraMulti(idx, t, doraTiles)
    if (rank === 2 || rank === 8) risk34[idx] *= 1.1
  }

  for (const tile of calcDNCSafeTilesWithDiscards(leftTiles34, safeTiles34)) {
    if (leftTiles34[tile] > 0) {
      const t = RiskTileType.Suji19
      risk34[tile] = RiskRate[turns][t] * doraMulti(tile, t, doraTiles)
      const r9 = tile % 9
      if (r9 > 0 && r9 < 8) risk34[tile] *= 1.1
    } else {
      risk34[tile] = 0
    }
  }

  for (let i = 0; i < 34; i++) {
    if (safeTiles34[i]) risk34[i] = 0
  }

  return risk34
}

/**
 * Per-opponent danger vector. Returns risk values in [0, 1] for each of
 * 34 tile types against a specific opponent. Phase 3 OpponentModel uses
 * this to compute opponent-specific deal-in EV; v1's `assessDanger`
 * folds these into a max-over-opponents scalar for simpler ranking.
 */
export function perTileRiskAgainst(
  state: GameState,
  selfPlayer: Player,
  opp: Player,
): number[] {
  if (opp === selfPlayer) return new Array(34).fill(0)
  const visible = getVisibleTiles(state, selfPlayer)
  const leftTiles34 = new Array<number>(34)
  for (let i = 0; i < 34; i++) leftTiles34[i] = 4 - visible[i]

  let totalDiscards = 0
  let oppCount = 0
  for (let p = 0; p < state.playerCount; p++) {
    if (p === selfPlayer) continue
    oppCount++
    totalDiscards += state.players[p].discards.length
  }
  if (oppCount === 0) return new Array(34).fill(0)
  const turns = Math.max(1, Math.min(MaxTurns, Math.round(totalDiscards / oppCount)))

  const doraTiles = state.doraMarkers.map(d => doraFromIndicator(d, state.playerCount === 3))
  const roundWindTile = 27 + state.roundWind

  const safeForOpponent = new Array<boolean>(34).fill(false)
  for (const entry of state.players[opp].discards) {
    safeForOpponent[entry.tile] = true
  }
  const oppWindTile = 27 + ((opp - state.dealer + state.playerCount) % state.playerCount)
  const risk34 = calculateRiskTiles34(
    turns, safeForOpponent, leftTiles34, doraTiles,
    roundWindTile, oppWindTile,
    state.playerCount,
  )
  // Normalize to [0, 1]
  return risk34.map(r => Math.max(0, Math.min(1, r / 100)))
}

export function assessDanger(
  state: GameState,
  selfPlayer: Player,
  tile: TileType,
): number {
  let maxRisk = 0
  for (let p = 0; p < state.playerCount; p++) {
    if (p === selfPlayer) continue
    const risk34 = perTileRiskAgainst(state, selfPlayer, p as Player)
    if (risk34[tile] > maxRisk) maxRisk = risk34[tile]
  }
  return maxRisk
}
