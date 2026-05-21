import { type TileType, type Meld, type PlayerState, type Wind, Suit } from './types'
import { countTiles, tileSuit, isHonor, isDragon, isWind, isTerminalOrHonor } from './tile-utils'
import { decomposeAllWinningHands, type HandDecomposition, type Mentsu } from './hand-analysis'
import { SOU_END, DRAGON_START, DRAGON_END, WIND_START, WIND_END } from './constants'

/**
 * Convert melds to Mentsu-shaped structures for shape-based yaku checks
 * (ittsu, sanshoku-doujun, chanta, junchan, etc.). Open melds physically
 * lock the corresponding mentsu — so any check that asks "does this hand
 * contain three sequences forming 1-9 of the same suit" must see them.
 *
 * - chi keeps its 3-tile sequence as-is.
 * - pon/daiminkan/ankan/kakan collapse to a 3-tile triplet [t, t, t]
 *   (the 4th tile of a kan is irrelevant for sequence-vs-triplet shape).
 */
function meldsAsMentsu(melds: readonly Meld[]): Mentsu[] {
  return melds.map(m => {
    if (m.type === 'chi') return { tiles: m.tiles }
    const t = m.tiles[0]!
    return { tiles: [t, t, t] }
  })
}

export interface YakuEntry {
  name: string
  han: number
  kuisagari: boolean
}

export interface YakuResult {
  yaku: YakuEntry[]
  totalHan: number
  isYakuman: boolean
}

export interface YakuContext {
  hand: TileType[]
  melds: Meld[]
  player: PlayerState
  roundWind: Wind
  seatWind: Wind
  isTsumo: boolean
  isRiichi: boolean
  isIppatsu: boolean
  isRinshan: boolean
  isChankan: boolean
  isHaitei: boolean
  isHoutei: boolean
  isFirstTurn: boolean
  winningTile: TileType
  /**
   * If true, classical 古役 are enabled. Currently this only affects
   * 大七星 (字一色 + 七対 → W役満). 純正九蓮宝燈 is detected unconditionally
   * (not a 古役).
   */
  koyakuMode?: boolean
}

export function evaluateYaku(ctx: YakuContext): YakuResult {
  // Hand + winning tile is the decomposable portion (melds are
  // already-locked structures).
  const concealedPlusWin = [...ctx.hand, ctx.winningTile]
  const decomps = decomposeAllWinningHands(concealedPlusWin)
  if (decomps.length === 0) return { yaku: [], totalHan: 0, isYakuman: false }

  // Score every valid decomposition and pick the best. Multiple regular
  // decompositions of the same tiles can yield different yaku sets — e.g.
  // chi 1m2m3m + 1p2p3p + 1s2s3s + 1s2s3s + 4s4s scores sanshoku doujun,
  // while the same tiles re-cut as 1p2p3p + 2s3s4s + 2s3s4s + 1s1s do not.
  // Tenhou rules require the player to claim the highest-scoring split.
  let best: YakuResult = { yaku: [], totalHan: 0, isYakuman: false }
  for (const decomp of decomps) {
    const r = evaluateYakuForDecomp(ctx, decomp, concealedPlusWin)
    if (isBetterResult(r, best)) best = r
  }
  return best
}

/** Yakuman first, then totalHan, then yaku count (richer description wins). */
function isBetterResult(a: YakuResult, b: YakuResult): boolean {
  if (a.isYakuman !== b.isYakuman) return a.isYakuman
  if (a.totalHan !== b.totalHan) return a.totalHan > b.totalHan
  return a.yaku.length > b.yaku.length
}

/** Evaluate yaku for a single concrete hand decomposition. Exported so
 *  win-evaluation can iterate decompositions itself and pick the one
 *  with the highest basicPoints (not just highest han) — fu varies
 *  across decompositions for the same tile set (e.g. shanpon vs ryanmen
 *  ron-completion), so picking solely on han loses small but real
 *  points (often 10 fu = 300-1900 yen). */
export function evaluateYakuForDecomp(
  ctx: YakuContext,
  decomp: HandDecomposition,
  concealedPlusWin: TileType[],
): YakuResult {
  const yaku: YakuEntry[] = []
  const isOpen = !ctx.player.isMenzen

  // Bug fix: tile-membership-based yaku checks (tanyao, honroutou, ryuiisou,
  // tsuuiisou, chinroutou, honitsu, chinitsu) must consider every tile in
  // the hand, including melded tiles. Previously only concealed+win was
  // examined, which made an open hand with a terminal in a chi meld
  // incorrectly qualify for tanyao/ryuiisou/etc.
  const allTiles = [...concealedPlusWin]
  for (const m of ctx.melds) {
    for (const t of m.tiles) allTiles.push(t)
  }

  const counts = countTiles(allTiles)

  // Check yakuman first.
  const yakuman = checkYakuman(ctx, decomp, counts, allTiles)
  if (yakuman.length > 0) {
    const total = yakuman.reduce((s, y) => s + y.han, 0)
    return { yaku: yakuman, totalHan: total, isYakuman: true }
  }

  // Situation-based yaku. Daburii (W立直, 2 han) REPLACES regular riichi
  // (1 han) — they do not stack. Daburii is locked at riichi-declaration
  // time and stored on PlayerState.daburii, so it survives later calls in
  // the same hand even though `state.turnCount`-based isFirstTurn at win
  // time would be false. (Previously this used `ctx.isFirstTurn &&
  // ctx.isRiichi` AND fell through to also push regular riichi — both
  // bugs: missed daburii after turn 1 advanced, and double-counted han
  // when it did fire.)
  if (ctx.player.daburii === true) {
    yaku.push({ name: 'daburii', han: 2, kuisagari: false })
  } else if (ctx.isRiichi) {
    yaku.push({ name: 'riichi', han: 1, kuisagari: false })
  }
  if (ctx.isIppatsu) yaku.push({ name: 'ippatsu', han: 1, kuisagari: false })
  if (ctx.player.isMenzen && ctx.isTsumo) yaku.push({ name: 'menzen_tsumo', han: 1, kuisagari: false })
  if (ctx.isRinshan) yaku.push({ name: 'rinshan', han: 1, kuisagari: false })
  if (ctx.isChankan) yaku.push({ name: 'chankan', han: 1, kuisagari: false })
  if (ctx.isHaitei) yaku.push({ name: 'haitei', han: 1, kuisagari: false })
  if (ctx.isHoutei) yaku.push({ name: 'houtei', han: 1, kuisagari: false })

  // Hand-based yaku
  // Tanyao is always 1 han, open or closed (NOT kuisagari). Marking it
  // kuisagari subtracted the only han off open tanyao hands and dropped
  // the yaku entirely, causing tens of thousands of mismatches in L1.5+
  // replay against real tenhou logs.
  if (checkTanyao(allTiles, isOpen)) yaku.push({ name: 'tanyao', han: 1, kuisagari: false })
  addYakuhai(ctx, counts, yaku)
  if (checkPinhu(ctx, decomp)) yaku.push({ name: 'pinhu', han: 1, kuisagari: false })
  if (checkIipeikou(decomp, isOpen)) yaku.push({ name: 'iipeikou', han: 1, kuisagari: true })

  // allMentsu = concealed mentsu (from decomp) + open mentsu (from melds).
  // Required for shape-based yaku that span the entire hand (ittsu,
  // sanshoku-doujun, chanta, junchan).
  const allMentsu: Mentsu[] = [...decomp.mentsu, ...meldsAsMentsu(ctx.melds)]

  // 2-han yaku
  if (checkToitoi(decomp, ctx.melds)) yaku.push({ name: 'toitoi', han: 2, kuisagari: false })
  if (decomp.type === 'seven_pairs') yaku.push({ name: 'chiitoitsu', han: 2, kuisagari: false })
  if (checkSanAnkou(decomp, ctx)) yaku.push({ name: 'san_ankou', han: 2, kuisagari: false })
  if (checkSanshokuDoujun(allMentsu)) yaku.push({ name: 'sanshoku_doujun', han: 2, kuisagari: true })
  if (checkIkkitsuukan(allMentsu)) yaku.push({ name: 'ikkitsuukan', han: 2, kuisagari: true })
  if (checkChanta(decomp, allTiles, allMentsu)) yaku.push({ name: 'chanta', han: 2, kuisagari: true })
  // 三色同刻 is a fixed 2-han yaku — NOT kuisagari. (Only the sequence/
  // shape yaku take an open penalty: sanshoku-doujun, ittsu, chanta,
  // junchan, hon'itsu, chinitsu. The triplet-based sanshoku-doukou stays
  // 2 han whether the triplets are open or concealed.)
  if (checkSanshokuDoukou(decomp, ctx.melds)) yaku.push({ name: 'sanshoku_doukou', han: 2, kuisagari: false })
  if (checkSankantsu(ctx.melds)) yaku.push({ name: 'sankantsu', han: 2, kuisagari: false })
  if (checkShousangen(decomp, counts)) yaku.push({ name: 'shousangen', han: 2, kuisagari: false })
  if (checkHonroutou(allTiles)) yaku.push({ name: 'honroutou', han: 2, kuisagari: false })

  // 3-han yaku
  if (checkHonitsu(allTiles, isOpen)) yaku.push({ name: 'honitsu', han: 3, kuisagari: true })
  if (checkRyanpeikou(decomp, isOpen)) yaku.push({ name: 'ryanpeikou', han: 3, kuisagari: true })
  if (checkJunchan(decomp, counts, allMentsu)) yaku.push({ name: 'junchan', han: 3, kuisagari: true })

  // 6-han yaku
  if (checkChinitsu(allTiles, isOpen)) yaku.push({ name: 'chinitsu', han: 6, kuisagari: true })

  let totalHan = 0
  for (const y of yaku) {
    totalHan += (isOpen && y.kuisagari) ? y.han - 1 : y.han
  }

  return { yaku, totalHan, isYakuman: false }
}

function checkTanyao(tiles: TileType[], isOpen: boolean): boolean {
  return tiles.every(t => !isTerminalOrHonor(t))
}

function addYakuhai(ctx: YakuContext, counts: number[], yaku: YakuEntry[]): void {
  const names = ['yakuhai_haku', 'yakuhai_hatsu', 'yakuhai_chun']
  for (let d = DRAGON_START; d <= DRAGON_END; d++) {
    if (counts[d] >= 3) yaku.push({ name: names[d - DRAGON_START], han: 1, kuisagari: false })
  }
  const roundWindTile = WIND_START + ctx.roundWind
  if (counts[roundWindTile] >= 3) yaku.push({ name: 'yakuhai_bakaze', han: 1, kuisagari: false })
  const seatWindTile = WIND_START + ctx.seatWind
  // Double-yakuhai (連風牌): if the wind tile is BOTH the seat wind AND
  // the round wind (e.g. South seat in South round), the triplet scores
  // *two* yakuhai = 2 han. The previous `!==` guard suppressed the second
  // yakuhai and was off by 1 han for every such hand. Tenhou rule.
  if (counts[seatWindTile] >= 3) {
    yaku.push({ name: 'yakuhai_jikaze', han: 1, kuisagari: false })
  }
}

function checkPinhu(ctx: YakuContext, decomp: HandDecomposition): boolean {
  if (!ctx.player.isMenzen) return false
  if (decomp.type !== 'regular') return false
  if (!decomp.mentsu.every(m => m.tiles[0] !== m.tiles[1])) return false
  // Ankan keeps the hand menzen but is still a kan (treated as a triplet
  // for set-shape purposes). Pinfu requires ALL four sets to be sequences,
  // so any ankan disqualifies. kakan/daiminkan already fail isMenzen above.
  if (ctx.melds.some(m => m.type === 'ankan')) return false
  if (isDragon(decomp.pair)) return false
  if (decomp.pair === WIND_START + ctx.roundWind) return false
  if (decomp.pair === WIND_START + ctx.seatWind) return false

  // Audit fix G: pinhu requires a ryanmen (two-sided) wait. Excludes
  // tanki/penchan/kanchan even if the rest of the hand is all-sequence.
  for (const m of decomp.mentsu) {
    const first = m.tiles[0]
    const rank = first % 9
    // Won the bottom of seq T-T+1-T+2 (player had T+1 / T+2, ryanmen low).
    // Excludes T at rank 6 (7-8-9 sequence): there 7 is penchan, not ryanmen.
    if (rank < 6 && first === ctx.winningTile) return true
    // Won the top of seq (player had T / T+1, ryanmen high). Excludes T at
    // rank 0 (1-2-3 sequence): there 3 from 1-2 is penchan.
    if (rank > 0 && first + 2 === ctx.winningTile) return true
  }
  return false
}

function checkIipeikou(decomp: HandDecomposition, isOpen: boolean): boolean {
  if (isOpen || decomp.type !== 'regular') return false
  if (checkRyanpeikou(decomp, isOpen)) return false
  const keys = decomp.mentsu.map(m => m.tiles.join(','))
  return new Set(keys).size < keys.length
}

function checkToitoi(decomp: HandDecomposition, melds: Meld[]): boolean {
  if (decomp.type !== 'regular') return false
  const handTriplets = decomp.mentsu.every(m => m.tiles[0] === m.tiles[1])
  if (!handTriplets) return false
  return melds.every(m => m.type === 'pon' || m.type === 'ankan' || m.type === 'kakan' || m.type === 'daiminkan')
}

function checkSanAnkou(decomp: HandDecomposition, ctx: YakuContext): boolean {
  if (decomp.type !== 'regular') return false
  // Concealed kotsu count: triplets in the concealed decomposition + any
  // ankan in melds. The "ron downgrades ankou" rule applies ONLY when the
  // ron tile actually completes the triplet (shanpon wait). If the same
  // ron tile also appears in a sequence in the decomp (e.g. 11,11,11
  // ankou + 10,11,12 seq with ron=11), the ron is on the sequence and
  // the triplet stays concealed — matching the fu calculator's
  // per-decomp logic. Tsumo never downgrades.
  const ronOnSequence = !ctx.isTsumo && decomp.mentsu.some(m =>
    m.tiles[0] !== m.tiles[1] && m.tiles.includes(ctx.winningTile),
  )
  let concealedTriplets = 0
  for (const m of decomp.mentsu) {
    if (m.tiles[0] !== m.tiles[1]) continue // sequence
    if (!ctx.isTsumo && m.tiles[0] === ctx.winningTile && !ronOnSequence) continue
    concealedTriplets++
  }
  const ankans = ctx.melds.filter(m => m.type === 'ankan').length
  return concealedTriplets + ankans >= 3
}

function checkSanshokuDoujun(allMentsu: Mentsu[]): boolean {
  const sequences = allMentsu.filter(m => m.tiles[0] !== m.tiles[1])
  for (const seq of sequences) {
    const rank = seq.tiles[0] % 9
    const hasMan = sequences.some(s => s.tiles[0] % 9 === rank && s.tiles[0] <= 8)
    const hasPin = sequences.some(s => s.tiles[0] % 9 === rank && s.tiles[0] >= 9 && s.tiles[0] <= 17)
    const hasSou = sequences.some(s => s.tiles[0] % 9 === rank && s.tiles[0] >= 18 && s.tiles[0] <= 26)
    if (hasMan && hasPin && hasSou) return true
  }
  return false
}

function checkIkkitsuukan(allMentsu: Mentsu[]): boolean {
  for (const base of [0, 9, 18]) {
    const ranks = new Set<number>()
    for (const m of allMentsu) {
      if (m.tiles[0] === m.tiles[1]) continue // skip triplets
      if (m.tiles[0]! >= base && m.tiles[0]! < base + 9) {
        ranks.add(m.tiles[0]! - base)
      }
    }
    // Old check looked at the first three sorted ranks, which broke when a
    // fourth sequence in the same suit (e.g. an extra chi) split the rank
    // ordering — `{0, 2, 3, 6}` would test ranks[1] === 3 against rank 2
    // and miss. Real ittsu only requires the {0, 3, 6} *subset* anywhere in
    // the suit.
    if (ranks.has(0) && ranks.has(3) && ranks.has(6)) return true
  }
  return false
}

function checkHonitsu(tiles: TileType[], isOpen: boolean): boolean {
  const suits = new Set(tiles.map(tileSuit))
  return suits.size === 2 && suits.has(Suit.Honor)
}

function checkChinitsu(tiles: TileType[], isOpen: boolean): boolean {
  const suits = new Set(tiles.map(tileSuit))
  return suits.size === 1 && !suits.has(Suit.Honor)
}

function checkRyanpeikou(decomp: HandDecomposition, isOpen: boolean): boolean {
  if (isOpen || decomp.type !== 'regular') return false
  const keys = decomp.mentsu.map(m => m.tiles.join(','))
  const counts: Record<string, number> = {}
  for (const k of keys) counts[k] = (counts[k] || 0) + 1
  const pairs = Object.values(counts).filter(c => c >= 2).length
  return pairs >= 2
}

function checkChanta(decomp: HandDecomposition, allTiles: TileType[], allMentsu: Mentsu[]): boolean {
  if (decomp.type !== 'regular') return false
  // Audit fix E: chanta must (1) contain at least one honor tile to
  // distinguish from junchan (no honors → junchan, 3 han) and (2) contain
  // at least one sequence to distinguish from honroutou (all triplets +
  // pair of terminals/honors). Without these checks the same hand could
  // match both yaku and the han count would double up.
  if (!allTiles.some(t => t >= 27)) return false
  if (allMentsu.every(m => m.tiles[0] === m.tiles[1])) return false
  return allMentsu.every(m => m.tiles.some(t => isTerminalOrHonor(t))) && isTerminalOrHonor(decomp.pair)
}

function checkJunchan(decomp: HandDecomposition, counts: number[], allMentsu: Mentsu[]): boolean {
  if (decomp.type !== 'regular') return false
  const isPureTerminal = (t: TileType) => t <= 26 && (t % 9 === 0 || t % 9 === 8)
  return allMentsu.every(m => m.tiles.some(t => isPureTerminal(t))) && isPureTerminal(decomp.pair)
}

function checkHonroutou(allTiles: TileType[]): boolean {
  return allTiles.every(t => isTerminalOrHonor(t))
}

function checkShousangen(decomp: HandDecomposition, counts: number[]): boolean {
  if (decomp.type !== 'regular') return false
  let dragonTriplets = 0
  for (let d = DRAGON_START; d <= DRAGON_END; d++) {
    if (counts[d] >= 3) dragonTriplets++
  }
  return dragonTriplets === 2 && isDragon(decomp.pair)
}

function checkSanshokuDoukou(decomp: HandDecomposition, melds: Meld[]): boolean {
  if (decomp.type !== 'regular') return false

  // Audit fix H: counts[X]=3 does not prove a triplet of X — three sequences
  // sharing a tile would also satisfy counts[X]>=3. Aggregate triplet base
  // tiles from decomp (in-hand triplets) AND melds (called triplets/kans).
  const tripletBases = new Set<TileType>()
  for (const m of decomp.mentsu) {
    if (m.tiles[0] === m.tiles[1]) tripletBases.add(m.tiles[0])
  }
  for (const meld of melds) {
    if (meld.type === 'pon' || meld.type === 'ankan' || meld.type === 'kakan' || meld.type === 'daiminkan') {
      tripletBases.add(meld.tiles[0])
    }
  }

  for (let rank = 0; rank < 9; rank++) {
    if (tripletBases.has(rank as TileType)
      && tripletBases.has((9 + rank) as TileType)
      && tripletBases.has((18 + rank) as TileType)) {
      return true
    }
  }
  return false
}

function checkSankantsu(melds: Meld[]): boolean {
  return melds.filter(m => m.type === 'ankan' || m.type === 'kakan' || m.type === 'daiminkan').length >= 3
}

// --- Yakuman ---

function checkYakuman(
  ctx: YakuContext,
  decomp: HandDecomposition | null,
  counts: number[],
  allTiles: TileType[],
): YakuEntry[] {
  const yakuman: YakuEntry[] = []

  if (ctx.isFirstTurn && ctx.isTsumo) {
    yakuman.push({ name: ctx.seatWind === 0 ? 'tenhou' : 'chiihou', han: 13, kuisagari: false })
  }

  if (decomp?.type === 'kokushi') {
    yakuman.push({ name: 'kokushi', han: 13, kuisagari: false })
  }

  if (decomp?.type === 'regular') {
    // 四暗刻 requires four concealed triplets. Ankan (declared concealed
    // kan) counts as a concealed triplet for this yakuman — it's only
    // daiminkan/kakan/pon that disqualify a set. Previously we only
    // counted triplets out of `decomp.mentsu`, missing hands with 3
    // ankou + 1 ankan + pair that should still score yakuman.
    const ankouFromDecomp = decomp.mentsu.filter(m => m.tiles[0] === m.tiles[1]).length
    const ankouFromMelds = ctx.melds.filter(m => m.type === 'ankan').length
    const totalAnkou = ankouFromDecomp + ankouFromMelds
    // Tanki ron on the pair is allowed; any other ron downgrades the
    // ron-completed triplet to a minkou, leaving only san_ankou.
    const fourAnkou = totalAnkou === 4 && (ctx.isTsumo || decomp.pair === ctx.winningTile)
    // 四暗刻単騎 and 四暗刻 are mutually exclusive — never stack. Tenhou's
    // mjai logs consistently pay single yakuman (8000 basic) for both
    // forms, so we treat them as 13 han each. (Some rule variants score
    // suu_ankou_tanki as W役満 / 26 han; if needed in the future, gate
    // that on a koyaku-style flag rather than stacking on top of regular
    // suu_ankou.)
    if (fourAnkou && decomp.pair === ctx.winningTile) {
      yakuman.push({ name: 'suu_ankou_tanki', han: 13, kuisagari: false })
    } else if (fourAnkou) {
      yakuman.push({ name: 'suu_ankou', han: 13, kuisagari: false })
    }

    if ([31, 32, 33].every(d => counts[d] >= 3)) {
      yakuman.push({ name: 'daisangen', han: 13, kuisagari: false })
    }

    if (counts[27] >= 3 && counts[28] >= 3 && counts[29] >= 3 && counts[30] >= 3) {
      yakuman.push({ name: 'daisuushii', han: 13, kuisagari: false })
    }

    let windTriplets = 0
    for (let w = WIND_START; w <= WIND_END; w++) {
      if (counts[w] >= 3) windTriplets++
    }
    if (windTriplets === 3 && isWind(decomp.pair)) {
      yakuman.push({ name: 'shousuushii', han: 13, kuisagari: false })
    }

    // 九蓮宝燈 is a menzen-only yakuman. An open hand may still satisfy the
    // 1112345678999 shape check (e.g. chinitsu-shape ron with a chi/pon),
    // but it does NOT count as chuuren — at most it scores as chinitsu.
    // Without this guard, L1.5+ replay saw open chinitsu-shape rons
    // wrongly inflated from mangan (~2000 basic) to yakuman (8000 basic).
    const suits = new Set(allTiles.map(tileSuit))
    if (ctx.player.isMenzen && suits.size === 1 && !suits.has(Suit.Honor)) {
      const chuurenKind = checkChuuren(allTiles, ctx.winningTile)
      if (chuurenKind === 'junsei') {
        yakuman.push({ name: 'junsei_chuuren', han: 26, kuisagari: false })
      } else if (chuurenKind === 'normal') {
        yakuman.push({ name: 'chuuren', han: 13, kuisagari: false })
      }
    }
  }

  const greenTiles = new Set([19, 20, 21, 23, 25, 32])
  if (allTiles.every(t => greenTiles.has(t))) {
    yakuman.push({ name: 'ryuiisou', han: 13, kuisagari: false })
  }

  // 大七星 (字一色 七対) — 古役 only. When koyakuMode is enabled and the
  // hand is chiitoi shape + all honors, emit daichisei (W役満) and suppress
  // the regular tsuuiisou push below.
  const isAllHonors = allTiles.every(t => t >= 27)
  const isDaichisei = !!ctx.koyakuMode
    && decomp?.type === 'seven_pairs'
    && isAllHonors
  if (isDaichisei) {
    yakuman.push({ name: 'daichisei', han: 26, kuisagari: false })
  } else if (isAllHonors) {
    yakuman.push({ name: 'tsuuiisou', han: 13, kuisagari: false })
  }

  if (allTiles.every(t => t <= 26 && (t % 9 === 0 || t % 9 === 8))) {
    yakuman.push({ name: 'chinroutou', han: 13, kuisagari: false })
  }

  const kanCount = ctx.melds.filter(m => m.type === 'ankan' || m.type === 'kakan' || m.type === 'daiminkan').length
  if (kanCount === 4) yakuman.push({ name: 'suu_kantsu', han: 13, kuisagari: false })

  return yakuman
}

/**
 * Detect 九蓮宝燈 shape on the full 14-tile hand. Returns:
 *  - 'junsei' for 純正九蓮宝燈 (W役満): the 13-tile hand prior to winning was
 *    exactly the [3,1,1,1,1,1,1,1,3] pattern, i.e. the winning tile is the
 *    "extra" copy on top of the pattern (9-面待ち).
 *  - 'normal' for 九蓮宝燈 (single yakuman): the hand passes the chuuren
 *    shape check but is not the perfect 9-wait.
 *  - 'none' otherwise.
 */
function checkChuuren(tiles: TileType[], winningTile: TileType): 'none' | 'normal' | 'junsei' {
  const counts = countTiles(tiles)
  const suit = tileSuit(tiles[0])
  const base = suit === 0 ? 0 : suit === 1 ? 9 : 18
  const pattern = [3, 1, 1, 1, 1, 1, 1, 1, 3]
  let extra = 0
  for (let i = 0; i < 9; i++) {
    if (counts[base + i] < pattern[i]) return 'none'
    extra += counts[base + i] - pattern[i]
  }
  if (extra !== 1) return 'none'
  // The extra tile is whichever position has count > pattern. Junsei iff
  // that position is the winning tile (so the 13-tile pre-win hand is
  // exactly the pattern).
  if (winningTile < base || winningTile >= base + 9) return 'normal'
  const winRank = winningTile - base
  return counts[winningTile] > pattern[winRank] ? 'junsei' : 'normal'
}
