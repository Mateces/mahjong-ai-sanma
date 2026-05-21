import type { GameState, Player, TileType, Wind } from './types'
import { evaluateYaku, evaluateYakuForDecomp, type YakuEntry, type YakuContext, type YakuResult } from './yaku'
import { basicPoints, calculateFu, calculatePoints, type ScoreResult } from './scoring'
import { decomposeAllWinningHands, type HandDecomposition } from './hand-analysis'
import { doraFromIndicator } from './tile-utils'
import { remainingTiles } from './wall'

/**
 * Result of evaluating a complete winning hand: yaku list, dora count,
 * fu, and computed point payments. `hasYaku` is the gate for whether the
 * win is legal (no-yaku ron/tsumo is rejected before this is consulted).
 */
export interface WinEvaluation {
  winner: Player
  yakuList: YakuEntry[]
  /** Han from yaku only (excludes dora). */
  yakuHan: number
  /** Dora indicator dora + uradora (none yet) + sanma kita (1 per kita,
   *  +1 again per kita if any dora indicator points to North). */
  doraCount: number
  /** yakuHan + doraCount. */
  totalHan: number
  fu: number
  scoreResult: ScoreResult
  isYakuman: boolean
  /** True iff the winning hand has at least one yaku (yakuman counts).
   *  Dora and kita alone do not satisfy this. */
  hasYaku: boolean
}

/**
 * Compute seat wind for a player relative to the current dealer.
 */
function seatWindOf(player: Player, dealer: Player, playerCount: 3 | 4): Wind {
  return ((player - dealer + playerCount) % playerCount) as Wind
}

/**
 * Build the YakuContext for the given winning player. The "hand" passed
 * to evaluateYaku must be 13 tiles (i.e. without the winning tile);
 * evaluateYaku adds the winning tile internally.
 */
function buildYakuContext(
  state: GameState,
  winner: Player,
  isTsumo: boolean,
  winningTile: TileType,
): YakuContext {
  const player = state.players[winner]

  // Engine convention:
  //   - tsumo: winner.hand is 14 tiles (already drew the winning tile)
  //   - ron:   winner.hand is 13 tiles, winningTile is the called tile
  //   - chankita ron: winner.hand is 13 tiles, winningTile = 30 (北)
  // evaluateYaku expects a 13-tile hand. For tsumo we strip one copy of the
  // winning tile; if the winning tile isn't in the hand for some reason
  // (shouldn't happen), we leave it as-is.
  let hand = player.hand
  if (isTsumo) {
    const idx = hand.indexOf(winningTile)
    if (idx !== -1) {
      hand = [...hand.slice(0, idx), ...hand.slice(idx + 1)]
    }
  }

  const seatWind = seatWindOf(winner, state.dealer, state.playerCount)

  return {
    hand,
    melds: player.melds,
    player,
    roundWind: state.roundWind,
    seatWind,
    isTsumo,
    isRiichi: player.riichi,
    isIppatsu: state.ippatsu && player.riichi,
    // Rinshan kaihou: the winning tsumo was a rinshan draw (state.atRinshan
    // set true by applyAnkan/Kakan/Daiminkan, cleared on discard).
    isRinshan: isTsumo && state.atRinshan === true,
    // Chankan: ron during the kakan respond window.
    isChankan: !isTsumo && state.chankan != null,
    // Haitei: winning tsumo with no live-wall tiles left after this draw.
    // Houtei: winning ron on a dahai made with the wall already exhausted.
    // remainingTiles() respects the kan-shrinks-live-wall rule. Rinshan
    // and haitei are MUTUALLY EXCLUSIVE — a rinshan tile isn't a
    // live-wall tile, so a kan-and-tsumo-on-rinshan doesn't also award
    // haitei even when the live wall is already depleted.
    isHaitei: isTsumo && state.atRinshan !== true && remainingTiles({
      tiles: state.wall, drawIndex: state.wallIndex,
      rinshanIndex: state.rinshanIndex, doraCount: state.doraMarkers.length,
    }) === 0,
    isHoutei: !isTsumo && !state.chankan && remainingTiles({
      tiles: state.wall, drawIndex: state.wallIndex,
      rinshanIndex: state.rinshanIndex, doraCount: state.doraMarkers.length,
    }) === 0,
    // First turn = before any player has called/discarded a 2nd time.
    // Conservative: require turnCount <= playerCount AND all players still
    // menzen (no calls yet). This captures tenhou/chiihou and daburii.
    // Sanma: Mahjong Soul rule — any 抜き北 declaration also breaks first
    // turn (mirrors mahjong-helper's isPlayerDaburii kita check). Without
    // this, daburi could falsely fire if an opponent kita'd then a player
    // declared riichi on turn 1.
    isFirstTurn: state.turnCount <= state.playerCount
      && state.players.every(p => p.isMenzen)
      && (state.playerCount !== 3 || state.players.every(p => p.kitaCount === 0)),
    winningTile,
    koyakuMode: state.koyakuMode,
  }
}

/**
 * Count dora in the (full 14-tile) winning hand including melds. Each copy
 * of a dora tile counts once.
 *
 * In sanma the player's kitaCount adds 1 dora per kita declared. If a dora
 * indicator points to North (i.e. the dora itself is 北 = tile index 30),
 * each kita counts as 2 dora total (the kita's own dora + the indicator
 * matching it). Aka dora is not implemented.
 */
function countDora(
  state: GameState,
  winner: Player,
  isTsumo: boolean,
  winningTile: TileType,
): number {
  const isSanma = state.playerCount === 3
  const player = state.players[winner]

  // Build the multiset of all tiles in the winning hand (concealed +
  // every tile in every meld + winning tile for ron; tsumo's winning tile
  // is already in hand). Each kan-tile counts (4 tiles, all dora-eligible).
  const allTiles: TileType[] = []
  for (const t of player.hand) allTiles.push(t)
  for (const m of player.melds) {
    for (const t of m.tiles) allTiles.push(t)
  }
  if (!isTsumo) {
    allTiles.push(winningTile)
  }

  let count = 0
  for (const indicator of state.doraMarkers) {
    const doraTile = doraFromIndicator(indicator, isSanma)
    for (const t of allTiles) {
      if (t === doraTile) count++
    }
  }

  // Aka-dora: +1 han per red-5 tile owned by the winner. The engine's
  // own wall doesn't currently flag aka tiles, so player.akaCount stays
  // 0 in self-play. External replays (mjai logs with `5mr`/`5pr`/`5sr`)
  // populate this field via the replay bridge.
  if (player.akaCount && player.akaCount > 0) {
    count += player.akaCount
  }

  // Sanma: kita itself is +1 dora per kita.
  if (isSanma && player.kitaCount > 0) {
    count += player.kitaCount
    // If any dora indicator points to North (tile 30), each kita counts
    // again (the kita tiles themselves are dora indicated tiles).
    for (const indicator of state.doraMarkers) {
      if (doraFromIndicator(indicator, isSanma) === 30) {
        count += player.kitaCount
      }
    }
  }

  return count
}

/**
 * Full evaluation: yaku, dora, fu, points. The caller is responsible for
 * not invoking this with an illegal winning condition; if `hasYaku` is
 * false the returned scoreResult is meaningless and the caller must
 * reject the win.
 */
export function evaluateWin(
  state: GameState,
  winner: Player,
  isTsumo: boolean,
  winningTile: TileType,
): WinEvaluation {
  const ctx = buildYakuContext(state, winner, isTsumo, winningTile)
  const player = state.players[winner]
  const isDealer = winner === state.dealer

  // Dora is independent of decomposition (it counts tile copies, not
  // shape), so compute it once. Yakuman ignores dora.
  const doraCount = countDora(state, winner, isTsumo, winningTile)

  // Enumerate every valid decomposition of (hand13 + winTile) and score
  // each one fully (yaku + fu + basicPoints). Pick the decomp with the
  // highest basicPoints. Yakuman wins beat any non-yakuman regardless of
  // basic. When han ties, fu breaks the tie naturally via basicPoints.
  //
  // Example: ron on the 6 of [4,5,6,6,6,17,17,17,...]. Two decomps —
  //   (A) 4-5-6 sequence + 6-6-6 minkou (shanpon, ron-downgraded): 40 fu
  //   (B) 4-5-6 sequence completed by ron (ryanmen) + 6-6-6 ankou:  50 fu
  // Both give the same yaku set (riichi only). Tenhou claims (B), the
  // higher fu. Without per-decomp fu scoring we would silently pick (A).
  const hand13 = ctx.hand
  const concealedPlusWin = [...hand13, winningTile]
  const decomps = decomposeAllWinningHands(concealedPlusWin)

  let bestYaku: YakuResult = { yaku: [], totalHan: 0, isYakuman: false }
  let bestFu = 30
  let bestBasic = -1
  let bestScore: ScoreResult | null = null
  let bestTotalHan = 0

  for (const decomp of decomps) {
    const yakuResult = evaluateYakuForDecomp(ctx, decomp, concealedPlusWin)
    if (yakuResult.yaku.length === 0) continue

    const totalHan = yakuResult.isYakuman
      ? yakuResult.totalHan
      : yakuResult.totalHan + doraCount

    const fu = computeFu(decomp, ctx, player.melds, yakuResult.yaku, winningTile, isTsumo)
    const basic = basicPoints(totalHan, fu)

    // Compare: yakuman beats anything; then basicPoints; then yaku-count
    // (richer description wins as a stable tiebreaker).
    const isImprovement =
      bestBasic < 0 ||
      (yakuResult.isYakuman && !bestYaku.isYakuman) ||
      (yakuResult.isYakuman === bestYaku.isYakuman && basic > bestBasic) ||
      (yakuResult.isYakuman === bestYaku.isYakuman && basic === bestBasic &&
        yakuResult.yaku.length > bestYaku.yaku.length)

    if (isImprovement) {
      bestYaku = yakuResult
      bestFu = fu
      bestBasic = basic
      bestTotalHan = totalHan
      bestScore = calculatePoints({
        han: totalHan, fu, isDealer, isTsumo, playerCount: state.playerCount,
      })
    }
  }

  const hasYaku = bestYaku.yaku.length > 0
  // If no decomposition produced any yaku, fall back to a no-yaku result.
  // calculatePoints would still produce something meaningful with han=0
  // but callers gate on hasYaku.
  const fallbackScore = calculatePoints({
    han: 0, fu: 30, isDealer, isTsumo, playerCount: state.playerCount,
  })

  return {
    winner,
    yakuList: bestYaku.yaku,
    yakuHan: bestYaku.totalHan,
    doraCount: hasYaku ? doraCount : 0,
    totalHan: hasYaku ? bestTotalHan : 0,
    fu: hasYaku ? bestFu : 30,
    scoreResult: bestScore ?? fallbackScore,
    isYakuman: bestYaku.isYakuman,
    hasYaku,
  }
}

/**
 * Light-weight version of evaluateWin that only computes whether the hand
 * has at least one yaku. Used by getValidActions to filter no-yaku
 * wins out of the action set without paying for fu/score computation.
 */
export function previewWin(
  state: GameState,
  winner: Player,
  isTsumo: boolean,
  winningTile: TileType,
): boolean {
  const ctx = buildYakuContext(state, winner, isTsumo, winningTile)
  const yakuResult = evaluateYaku(ctx)
  return yakuResult.yaku.length > 0
}

function computeFu(
  decomp: HandDecomposition,
  ctx: YakuContext,
  melds: YakuContext['melds'],
  yakuList: YakuEntry[],
  winningTile: TileType,
  isTsumo: boolean,
): number {
  // Chiitoi has fixed 25 fu (calculateFu handles via isChiitoi flag).
  if (decomp.type === 'seven_pairs') {
    return calculateFu({
      winningTile,
      isTsumo,
      isPinhu: false,
      isMenzen: ctx.player.isMenzen,
      isChiitoi: true,
      melds,
      pair: decomp.pair,
      mentsu: [],
      seatWind: ctx.seatWind,
      roundWind: ctx.roundWind,
    })
  }

  // Kokushi: fu is irrelevant (yakuman ignores fu); return a sensible
  // placeholder so callers don't get NaN.
  if (decomp.type === 'kokushi') {
    return 30
  }

  const isPinhu = yakuList.some(y => y.name === 'pinhu')
  return calculateFu({
    winningTile,
    isTsumo,
    isPinhu,
    isMenzen: ctx.player.isMenzen,
    isChiitoi: false,
    melds,
    pair: decomp.pair,
    mentsu: decomp.mentsu,
    seatWind: ctx.seatWind,
    roundWind: ctx.roundWind,
  })
}
