import type { TileType } from './types'
import { countTiles } from './tile-utils'
import { SOU_END } from './constants'

/**
 * Distance (in draws) from tenpai for the regular form. `meldCount` is the
 * number of already-completed mentsu held as melds (chi/pon/kan), so the
 * concealed portion only needs to build `4 - meldCount` more mentsu + 1 pair.
 *
 * meldCount=0 (closed hand): need 4 mentsu + pair from 13 concealed tiles.
 * meldCount=1: need 3 mentsu + pair from 10 concealed tiles. Etc.
 *
 * Without this parameter the function over-counted shanten for open hands —
 * e.g. a tenpai hand with 1 ankan returned shanten ≥ 2 and so getValidActions
 * never exposed Riichi (or the tenpai check at end-of-kyoku misfired).
 */
export function calculateShanten(tiles: TileType[], meldCount = 0): number {
  const counts = countTiles(tiles)
  return shantenFromCounts(counts, meldCount)
}

// Module-level cache for decompose, cleared per shantenFromCounts invocation
let decomposeCache: Map<string, { mentsu: number; taatsu: number }> | null = null

export function shantenFromCounts(counts: number[], meldCount = 0): number {
  decomposeCache = new Map()
  const components: number[] = [shantenRegular(counts, meldCount)]
  // Chiitoitsu and kokushi are valid only for fully concealed hands (no melds).
  if (meldCount === 0) {
    components.push(shantenSevenPairs(counts), shantenKokushi(counts))
  }
  const result = Math.min(...components)
  decomposeCache = null
  return result
}

function shantenRegular(counts: number[], meldCount = 0): number {
  // Target after melds: (4 − meldCount) mentsu + 1 pair from the concealed
  // portion. Max useful taatsu is also bounded by (4 − meldCount − mentsu).
  const targetMentsu = 4 - meldCount
  const baseShanten = 2 * targetMentsu // == 8 for closed, 6 for 1 meld, etc.
  let minShanten = baseShanten
  const c = [...counts]

  // Try each tile as jantai (pair)
  for (let t = 0; t < 34; t++) {
    if (c[t] >= 2) {
      c[t] -= 2
      const { mentsu, taatsu } = decompose(c, 0)
      const s = baseShanten - 2 * mentsu - 1 - Math.min(taatsu, targetMentsu - mentsu)
      if (s < minShanten) minShanten = s
      c[t] += 2
    }
  }

  // Without jantai
  const { mentsu, taatsu } = decompose(c, 0)
  const s = baseShanten - 2 * mentsu - Math.min(taatsu, targetMentsu - mentsu)
  if (s < minShanten) minShanten = s

  return minShanten
}

function decompose(counts: number[], startPos: number): { mentsu: number; taatsu: number } {
  let pos = startPos
  while (pos < 34 && counts[pos] === 0) pos++
  if (pos === 34) return { mentsu: 0, taatsu: 0 }

  // Cache check - key from counts[pos..33] since [0..pos-1] are all 0
  const parts: string[] = []
  for (let i = pos; i < 34; i++) parts.push(String(counts[i]))
  const cacheKey = parts.join('') + ':' + pos

  if (decomposeCache) {
    const cached = decomposeCache.get(cacheKey)
    if (cached) return cached
  }

  let bestMentsu = 0
  let bestTaatsu = 0
  let bestScore = 0

  // Option 1: skip this tile (treat as isolated)
  counts[pos]--
  const skipResult = decompose(counts, pos)
  counts[pos]++
  bestScore = skipResult.mentsu * 2 + skipResult.taatsu
  bestMentsu = skipResult.mentsu
  bestTaatsu = skipResult.taatsu

  // Option 2: triplet (刻子)
  if (counts[pos] >= 3) {
    counts[pos] -= 3
    const r = decompose(counts, pos)
    counts[pos] += 3
    const s = (r.mentsu + 1) * 2 + r.taatsu
    if (s > bestScore) { bestMentsu = r.mentsu + 1; bestTaatsu = r.taatsu; bestScore = s }
  }

  // Option 3: sequence (顺子) — number suits only
  if (pos <= SOU_END && pos % 9 <= 6 && counts[pos + 1] > 0 && counts[pos + 2] > 0) {
    counts[pos]--
    counts[pos + 1]--
    counts[pos + 2]--
    const r = decompose(counts, pos)
    counts[pos]++
    counts[pos + 1]++
    counts[pos + 2]++
    const s = (r.mentsu + 1) * 2 + r.taatsu
    if (s > bestScore) { bestMentsu = r.mentsu + 1; bestTaatsu = r.taatsu; bestScore = s }
  }

  // Option 4: pair as taatsu (对子)
  if (counts[pos] >= 2) {
    counts[pos] -= 2
    const r = decompose(counts, pos)
    counts[pos] += 2
    const s = r.mentsu * 2 + (r.taatsu + 1)
    if (s > bestScore) { bestMentsu = r.mentsu; bestTaatsu = r.taatsu + 1; bestScore = s }
  }

  // Option 5: consecutive taatsu (两面/边张)
  if (pos <= SOU_END && pos % 9 <= 7 && counts[pos + 1] > 0) {
    counts[pos]--
    counts[pos + 1]--
    const r = decompose(counts, pos)
    counts[pos]++
    counts[pos + 1]++
    const s = r.mentsu * 2 + (r.taatsu + 1)
    if (s > bestScore) { bestMentsu = r.mentsu; bestTaatsu = r.taatsu + 1; bestScore = s }
  }

  // Option 6: kanchan taatsu (嵌张)
  if (pos <= SOU_END && pos % 9 <= 6 && counts[pos + 2] > 0) {
    counts[pos]--
    counts[pos + 2]--
    const r = decompose(counts, pos)
    counts[pos]++
    counts[pos + 2]++
    const s = r.mentsu * 2 + (r.taatsu + 1)
    if (s > bestScore) { bestMentsu = r.mentsu; bestTaatsu = r.taatsu + 1; bestScore = s }
  }

  const result = { mentsu: bestMentsu, taatsu: bestTaatsu }
  if (decomposeCache) decomposeCache.set(cacheKey, result)
  return result
}

function shantenSevenPairs(counts: number[]): number {
  let pairs = 0
  let kinds = 0
  for (let i = 0; i < 34; i++) {
    if (counts[i] >= 1) kinds++
    if (counts[i] >= 2) pairs++
  }
  if (kinds < 7) return 6 - pairs + (7 - kinds)
  return 6 - pairs
}

const KOKUSHI_TILES = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33]

function shantenKokushi(counts: number[]): number {
  let unique = 0
  let hasPair = 0
  for (const t of KOKUSHI_TILES) {
    if (counts[t] >= 1) unique++
    if (counts[t] >= 2) hasPair = 1
  }
  return 13 - unique - hasPair
}
