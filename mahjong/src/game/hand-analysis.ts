import type { TileType } from './types'
import { countTiles } from './tile-utils'
import { SOU_END } from './constants'

const KOKUSHI_TILES = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33]

export interface Mentsu {
  tiles: TileType[]
}

export interface HandDecomposition {
  mentsu: Mentsu[]
  pair: TileType
  type: 'regular' | 'seven_pairs' | 'kokushi'
}

export function isWinningHand(tiles: TileType[]): boolean {
  // Concealed-portion length is 14 − 3·N_melds, so valid lengths are
  // 14, 11, 8, 5, 2 (i.e. len%3 === 2). Rejecting len !== 14 made open
  // hands unable to ron — getValidActions would skip the Ron query and
  // the model retreated to chi/pon, inflating fuuro%.
  if (tiles.length > 14 || tiles.length < 2 || tiles.length % 3 !== 2) return false
  return decomposeWinningHand(tiles) !== null
}

export function decomposeWinningHand(tiles: TileType[]): HandDecomposition | null {
  const all = decomposeAllWinningHands(tiles)
  return all.length > 0 ? all[0]! : null
}

/**
 * Enumerate every valid (regular / seven-pairs / kokushi) decomposition of
 * the winning hand. Used by evaluateYaku so it can pick the
 * highest-scoring interpretation when a hand has multiple valid splits.
 *
 * Background: A real example caught by `scripts/replay-mjai.ts` —
 *   chi 1m2m3m + concealed [1p,2p,3p, 1s,1s,2s,2s,3s,3s,4s,4s]
 * has two regular decompositions:
 *   (a) pair 1s1s + 1p2p3p + 2s3s4s + 2s3s4s          → no sanshoku
 *   (b) pair 4s4s + 1p2p3p + 1s2s3s + 1s2s3s + chi    → sanshoku doujun
 * The previous single-result form returned (a) deterministically; (b) is
 * the legitimate ittsu/sanshoku-bearing decomposition the player chose,
 * worth more han. Returning all decompositions lets evaluateYaku score
 * each and pick the best.
 */
export function decomposeAllWinningHands(tiles: TileType[]): HandDecomposition[] {
  if (tiles.length < 2 || tiles.length > 14) return []

  const counts = countTiles(tiles)
  const expectedMentsu = Math.floor(tiles.length / 3)
  const hasPairSlot = tiles.length % 3 === 2
  const out: HandDecomposition[] = []

  if (hasPairSlot) {
    for (let pair = 0; pair < 34; pair++) {
      if (counts[pair]! >= 2) {
        counts[pair]! -= 2
        const allMentsu = extractAllMentsuWithCount(counts, [], expectedMentsu)
        counts[pair]! += 2
        for (const mentsu of allMentsu) {
          out.push({ mentsu, pair: pair as TileType, type: 'regular' })
        }
      }
    }
  }

  // Chiitoitsu and kokushi only apply to fully concealed 14-tile hands.
  if (tiles.length === 14) {
    if (isSevenPairs(counts)) {
      const pairTile = counts.findIndex((c, _i) => c >= 2) as TileType
      out.push({ mentsu: [], pair: pairTile, type: 'seven_pairs' })
    }
    const kokushiResult = checkKokushi(counts)
    if (kokushiResult !== null) out.push(kokushiResult)
  }

  return out
}

function decomposeRegularWithCount(counts: number[], targetMentsu: number): Omit<HandDecomposition, 'type'> | null {
  for (let pair = 0; pair < 34; pair++) {
    if (counts[pair] >= 2) {
      const c = [...counts]
      c[pair] -= 2
      const mentsu = extractMentsuWithCount(c, [], targetMentsu)
      if (mentsu) {
        return { mentsu, pair }
      }
    }
  }
  return null
}

function decomposeRegular(counts: number[]): Omit<HandDecomposition, 'type'> | null {
  return decomposeRegularWithCount(counts, 4)
}

/**
 * Yield every way to partition `counts` (an in-place mutated tile-count
 * array, restored before returning) into exactly `target` mentsu. Canonical
 * left-to-right enumeration avoids producing equivalent decomposition
 * permutations of the same set of mentsu.
 */
function extractAllMentsuWithCount(counts: number[], acc: Mentsu[], target: number): Mentsu[][] {
  if (acc.length === target) {
    return counts.every(c => c === 0) ? [acc.slice()] : []
  }
  let idx = -1
  for (let i = 0; i < 34; i++) {
    if (counts[i]! > 0) { idx = i; break }
  }
  if (idx === -1) return acc.length === target ? [acc.slice()] : []

  const results: Mentsu[][] = []

  // Triplet (刻子) at leftmost tile.
  if (counts[idx]! >= 3) {
    counts[idx]! -= 3
    acc.push({ tiles: [idx, idx, idx] as TileType[] })
    results.push(...extractAllMentsuWithCount(counts, acc, target))
    acc.pop()
    counts[idx]! += 3
  }

  // Sequence (順子) — number suits only.
  if (idx <= SOU_END && idx % 9 <= 6 && counts[idx + 1]! > 0 && counts[idx + 2]! > 0) {
    counts[idx]!--
    counts[idx + 1]!--
    counts[idx + 2]!--
    acc.push({ tiles: [idx, idx + 1, idx + 2] as TileType[] })
    results.push(...extractAllMentsuWithCount(counts, acc, target))
    acc.pop()
    counts[idx]!++
    counts[idx + 1]!++
    counts[idx + 2]!++
  }

  return results
}

function extractMentsuWithCount(counts: number[], acc: Mentsu[], target: number): Mentsu[] | null {
  if (acc.length === target) {
    // Check all tiles used
    return counts.every(c => c === 0) ? acc : null
  }

  let idx = -1
  for (let i = 0; i < 34; i++) {
    if (counts[i] > 0) { idx = i; break }
  }

  if (idx === -1) return acc.length === target ? acc : null

  // Try triplet
  if (counts[idx] >= 3) {
    const c = [...counts]
    c[idx] -= 3
    const result = extractMentsuWithCount(c, [...acc, { tiles: [idx, idx, idx] }], target)
    if (result) return result
  }

  // Try sequence (number suits only)
  if (idx <= SOU_END && idx % 9 <= 6 && counts[idx + 1] > 0 && counts[idx + 2] > 0) {
    const c = [...counts]
    c[idx]--
    c[idx + 1]--
    c[idx + 2]--
    const result = extractMentsuWithCount(c, [...acc, { tiles: [idx, idx + 1, idx + 2] }], target)
    if (result) return result
  }

  return null
}

function extractMentsu(counts: number[], acc: Mentsu[]): Mentsu[] | null {
  let idx = -1
  for (let i = 0; i < 34; i++) {
    if (counts[i] > 0) { idx = i; break }
  }

  if (idx === -1) return acc

  // Try triplet
  if (counts[idx] >= 3) {
    const c = [...counts]
    c[idx] -= 3
    const result = extractMentsu(c, [...acc, { tiles: [idx, idx, idx] }])
    if (result) return result
  }

  // Try sequence (number suits only)
  if (idx <= SOU_END && idx % 9 <= 6 && counts[idx + 1] > 0 && counts[idx + 2] > 0) {
    const c = [...counts]
    c[idx]--
    c[idx + 1]--
    c[idx + 2]--
    const result = extractMentsu(c, [...acc, { tiles: [idx, idx + 1, idx + 2] }])
    if (result) return result
  }

  return null
}

function isSevenPairs(counts: number[]): boolean {
  let pairs = 0
  for (let i = 0; i < 34; i++) {
    if (counts[i] % 2 !== 0) return false
    pairs += counts[i] / 2
  }
  return pairs === 7
}

function checkKokushi(counts: number[]): HandDecomposition | null {
  let hasPair = false
  let pairTile: TileType = -1
  for (const t of KOKUSHI_TILES) {
    if (counts[t] === 0) return null
    if (counts[t] === 2) {
      if (hasPair) return null
      hasPair = true
      pairTile = t
    }
  }
  if (!hasPair) return null
  return { mentsu: [], pair: pairTile, type: 'kokushi' }
}
