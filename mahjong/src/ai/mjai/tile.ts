import type { TileType } from '../../game/types'
import type { MjaiTile } from './types'

/**
 * Convert TS TileType (0-33) to MJAI string ("1m", "E", "P", ...).
 * Pass aka=true for tiles that are aka-dora (赤ドラ) to get "5mr"/"5pr"/"5sr".
 */
export function tileToMjai(t: TileType, aka?: boolean): MjaiTile {
  if (t <= 8) return (t === 4 && aka) ? '5mr' : `${t + 1}m`
  if (t <= 17) return (t === 13 && aka) ? '5pr' : `${t - 8}p`
  if (t <= 26) return (t === 22 && aka) ? '5sr' : `${t - 17}s`
  switch (t) {
    case 27: return 'E'
    case 28: return 'S'
    case 29: return 'W'
    case 30: return 'N'
    case 31: return 'P'
    case 32: return 'F'
    case 33: return 'C'
  }
  throw new Error(`unknown tile ${t}`)
}

/** Inverse of tileToMjai. Strips the 'r' aka suffix ("5mr" → 5m). */
export function mjaiToTile(s: MjaiTile): TileType {
  const base = s.endsWith('r') ? s.slice(0, -1) : s
  if (base.length === 2) {
    const rank = parseInt(base[0]!, 10)
    if (!Number.isFinite(rank) || rank < 1 || rank > 9) {
      throw new Error(`bad mjai tile ${s}`)
    }
    switch (base[1]) {
      case 'm': return rank - 1
      case 'p': return 8 + rank
      case 's': return 17 + rank
    }
  }
  switch (base) {
    case 'E': return 27
    case 'S': return 28
    case 'W': return 29
    case 'N': return 30
    case 'P': return 31
    case 'F': return 32
    case 'C': return 33
  }
  throw new Error(`bad mjai tile ${s}`)
}

export const ROUND_WIND_NAMES = ['E', 'S', 'W', 'N'] as const
