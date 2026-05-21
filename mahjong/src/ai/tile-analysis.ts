import type { TileType, GameState, Player } from '../game/types'
import { countTiles } from '../game/tile-utils'
import { calculateShanten, shantenFromCounts } from '../game/shanten'

/** Get a 34-element array of visible tile counts from a player's perspective */
export function getVisibleTiles(state: GameState, selfPlayer: Player): number[] {
  const visible = new Array(34).fill(0)

  // Own hand
  for (const t of state.players[selfPlayer].hand) {
    visible[t]++
  }

  // All melds from all players
  for (const p of state.players) {
    for (const meld of p.melds) {
      for (const t of meld.tiles) {
        visible[t]++
      }
    }
  }

  // All discards from all players
  for (const p of state.players) {
    for (const entry of p.discards) {
      visible[entry.tile]++
    }
  }

  // Dora markers
  for (const t of state.doraMarkers) {
    visible[t]++
  }

  // Sanma 抜き北: declared kita tiles are set aside (tracked via kitaCount,
  // not in melds or discards) and can no longer be drawn. Without this,
  // calculateUkeire and assessDanger overcount how many 北 remain.
  for (const p of state.players) {
    visible[30] += p.kitaCount
  }

  return visible
}

/** Count remaining copies of a tile (4 - visible) */
export function countRemaining(tile: TileType, visible: number[]): number {
  return 4 - visible[tile]
}

/** Count total accepting tiles (ukeire) for a hand */
export function calculateUkeire(hand: TileType[], visible: number[]): number {
  const currentShanten = calculateShanten(hand)
  let ukeire = 0

  // Build counts once, then mutate in-place for each test
  const counts = countTiles(hand)
  const baseShanten = currentShanten

  for (let t = 0 as TileType; t < 34; t++) {
    const remaining = 4 - visible[t]
    if (remaining <= 0) continue

    counts[t]++
    const newShanten = shantenFromCounts(counts)
    counts[t]--

    if (newShanten < baseShanten) {
      ukeire += remaining
    }
  }

  return ukeire
}

/** Per-tile ukeire detail for furiten and agari rate calculations */
export interface UkeireDetail {
  /** Total accepting tiles count (same as calculateUkeire return) */
  total: number
  /** Per-tile remaining count, only for tiles that reduce shanten */
  acceptingTiles: { tile: TileType; remaining: number }[]
}

/** Detailed ukeire with per-tile acceptance information */
export function calculateUkeireDetailed(hand: TileType[], visible: number[]): UkeireDetail {
  const currentShanten = calculateShanten(hand)
  const counts = countTiles(hand)
  const baseShanten = currentShanten

  const acceptingTiles: { tile: TileType; remaining: number }[] = []
  let total = 0

  for (let t = 0 as TileType; t < 34; t++) {
    const remaining = 4 - visible[t]
    if (remaining <= 0) continue

    counts[t]++
    const newShanten = shantenFromCounts(counts)
    counts[t]--

    if (newShanten < baseShanten) {
      total += remaining
      acceptingTiles.push({ tile: t, remaining })
    }
  }

  return { total, acceptingTiles }
}
