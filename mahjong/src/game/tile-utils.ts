import type { TileType, Suit } from './types'
import {
  MAN_START, MAN_END, PIN_START, PIN_END,
  SOU_START, SOU_END, HONOR_START, HONOR_END,
  WIND_START, WIND_END, DRAGON_START, DRAGON_END,
  TERMINALS,
} from './constants'

export function tileSuit(t: TileType): Suit {
  if (t <= MAN_END) return 0
  if (t <= PIN_END) return 1
  if (t <= SOU_END) return 2
  return 3
}

export function tileRank(t: TileType): number {
  if (t <= MAN_END) return t - MAN_START + 1
  if (t <= PIN_END) return t - PIN_START + 1
  if (t <= SOU_END) return t - SOU_START + 1
  return t - HONOR_START + 1
}

export function isMan(t: TileType): boolean { return t >= MAN_START && t <= MAN_END }
export function isPin(t: TileType): boolean { return t >= PIN_START && t <= PIN_END }
export function isSou(t: TileType): boolean { return t >= SOU_START && t <= SOU_END }
export function isHonor(t: TileType): boolean { return t >= HONOR_START && t <= HONOR_END }
export function isWind(t: TileType): boolean { return t >= WIND_START && t <= WIND_END }
export function isDragon(t: TileType): boolean { return t >= DRAGON_START && t <= DRAGON_END }

export function isTerminal(t: TileType): boolean {
  return TERMINALS.includes(t)
}

export function isTerminalOrHonor(t: TileType): boolean {
  return isHonor(t) || isTerminal(t)
}

export function sameSuit(a: TileType, b: TileType): boolean {
  return tileSuit(a) === tileSuit(b)
}

/** Convert tile number to string like "1m", "5p", "E", "H" */
export function tileToString(t: TileType): string {
  if (t <= MAN_END) return `${t - MAN_START + 1}m`
  if (t <= PIN_END) return `${t - PIN_START + 1}p`
  if (t <= SOU_END) return `${t - SOU_START + 1}s`
  const honorNames = ['E', 'S', 'W', 'N', 'H', 'G', 'R']
  return honorNames[t - HONOR_START]
}

/**
 * Get dora tile from indicator.
 *
 * `isSanma` adjusts the man-suit wrap-around: in sanma, 2m-8m don't exist,
 * so 1m's "next" tile is 9m (matching mahjong-helper's behavior). All other
 * mappings are unchanged.
 */
export function doraFromIndicator(indicator: TileType, isSanma = false): TileType {
  if (isHonor(indicator)) {
    if (indicator < 31) return indicator === 30 ? 27 : indicator + 1
    return indicator === 33 ? 31 : indicator + 1
  }
  // Sanma: 1m's dora wraps to 9m because 2m-8m don't exist
  if (isSanma && indicator === MAN_START) return MAN_START + 8
  const suitStart = isMan(indicator) ? MAN_START : isPin(indicator) ? PIN_START : SOU_START
  const rank = tileRank(indicator)
  return rank === 9 ? suitStart : suitStart + rank
}

/** Count tiles by type: returns array of 34 counts */
export function countTiles(tiles: TileType[]): number[] {
  const counts = new Array(34).fill(0)
  for (const t of tiles) counts[t]++
  return counts
}

/** Extract tiles from a count array back into tile array */
export function tilesFromCounts(counts: number[]): TileType[] {
  const tiles: TileType[] = []
  for (let i = 0; i < 34; i++) {
    for (let j = 0; j < counts[i]; j++) tiles.push(i)
  }
  return tiles
}

/** Remove n copies of a tile from a count array */
export function removeTile(counts: number[], tile: TileType, n: number = 1): number[] {
  const result = [...counts]
  result[tile] -= n
  return result
}
