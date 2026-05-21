import type { TileType } from './types'
import { TILE_COUNT_PER_TYPE } from './constants'

/** Tile indices for the three aka-dora candidates: 5m, 5p, 5s. */
export const AKA_TILES: readonly TileType[] = [4, 13, 22]

export interface Wall {
  tiles: TileType[]
  drawIndex: number
  rinshanIndex: number
  doraCount: number
  /**
   * Wall positions (indices into `tiles`) that are aka-dora (赤ドラ).
   * Exactly one position per aka-eligible tile kind (3 in yonma — 5m,
   * 5p, 5s; in sanma 5m's row is removed so only 5p and 5s, 2 entries).
   * `tiles[position]` already gives the underlying tile type; aka is
   * a marker on top.
   */
  akaPositions: Set<number>
}

export function createWall(playerCount: 3 | 4 = 4): Wall {
  const tiles: TileType[] = []
  // Track per-tile-kind the wall positions we've pushed so we can mark
  // one copy of each aka-eligible tile as aka post-shuffle.
  const positionsByTile: Map<TileType, number[]> = new Map()
  for (let t = 0; t < 34; t++) {
    if (playerCount === 3 && t >= 1 && t <= 7) continue
    const positions: number[] = []
    for (let c = 0; c < TILE_COUNT_PER_TYPE; c++) {
      positions.push(tiles.length)
      tiles.push(t)
    }
    positionsByTile.set(t as TileType, positions)
  }
  // Pick one position per aka-eligible tile as aka. Doing this BEFORE
  // shuffle would tag the same physical position regardless of game; we
  // shuffle first and then re-track which positions hold each tile.
  shuffle(tiles)
  const akaPositions = new Set<number>()
  for (const akaTile of AKA_TILES) {
    if (playerCount === 3 && akaTile === 4) continue // no 5m in sanma wall
    // Find first wall position holding this tile post-shuffle.
    for (let i = 0; i < tiles.length; i++) {
      if (tiles[i] === akaTile) { akaPositions.add(i); break }
    }
  }
  const drawIndex = 13 * playerCount
  return { tiles, drawIndex, rinshanIndex: tiles.length - 1, doraCount: 1, akaPositions }
}

function shuffle<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
}

export function dealHaipai(
  wall: Wall,
  playerCount: 3 | 4 = 4,
): { hands: TileType[][]; akaInHand: TileType[][] } {
  const hands: TileType[][] = Array.from({ length: playerCount }, () => [])
  // Per-player aka tiles dealt during haipai. Each entry is a flat list of
  // aka-tile types the player received (typically 0..3 entries, max 1 per
  // aka kind since each aka exists only once in the wall).
  const akaInHand: TileType[][] = Array.from({ length: playerCount }, () => [])
  for (let round = 0; round < 13; round++) {
    for (let p = 0; p < playerCount; p++) {
      const pos = round * playerCount + p
      hands[p].push(wall.tiles[pos])
      if (wall.akaPositions.has(pos)) akaInHand[p].push(wall.tiles[pos])
    }
  }
  for (const h of hands) h.sort((a, b) => a - b)
  return { hands, akaInHand }
}

/**
 * Number of rinshans already taken (0..4). Each kan moves one tile from the
 * live wall to the dead wall to maintain dead-wall size, so we deduct
 * `usedRinshans` from the live-wall cap. This matches libriichi's
 * `tiles_left = 70` budget that counts main + rinshan draws together.
 * Pre-fix the live wall allowed 70 main + up to 4 rinshan = 74 total tsumo
 * events, and libriichi crashed with "exhausted yama" past 70.
 */
function usedRinshans(wall: Wall): number {
  return wall.tiles.length - 1 - wall.rinshanIndex
}

export function drawTile(wall: Wall): { tile: TileType; aka: boolean; wall: Wall } | null {
  // Live wall ends at tiles.length - 14 - usedRinshans (each kan shrinks it).
  const normalDrawEnd = wall.tiles.length - 14 - usedRinshans(wall)
  if (wall.drawIndex >= normalDrawEnd) return null
  const pos = wall.drawIndex
  return {
    tile: wall.tiles[pos],
    aka: wall.akaPositions.has(pos),
    wall: { ...wall, drawIndex: pos + 1 },
  }
}

export function drawRinshan(wall: Wall): { tile: TileType; aka: boolean; wall: Wall } | null {
  if (wall.rinshanIndex <= wall.drawIndex) return null
  const pos = wall.rinshanIndex
  return {
    tile: wall.tiles[pos],
    aka: wall.akaPositions.has(pos),
    wall: { ...wall, rinshanIndex: pos - 1, doraCount: wall.doraCount + 1 },
  }
}

export function getDoraMarkers(wall: Wall): TileType[] {
  const markers: TileType[] = []
  for (let i = 0; i < wall.doraCount; i++) {
    markers.push(wall.tiles[wall.rinshanIndex - 3 - i * 2])
  }
  return markers
}

export function remainingTiles(wall: Wall): number {
  const normalDrawEnd = wall.tiles.length - 14 - usedRinshans(wall)
  return normalDrawEnd - wall.drawIndex
}
