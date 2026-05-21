import type { GameState, Player, PlayerState, Action, TileType, Wind } from './types'
import { ActionKind } from './types'
import { createWall, dealHaipai, drawTile, drawRinshan, getDoraMarkers, type Wall } from './wall'
import { calculateShanten } from './shanten'
import { isWinningHand } from './hand-analysis'
import { evaluateWin, previewWin } from './win-evaluation'
import { MjaiEmitter } from '../ai/mjai/emit'
import type { MjaiEvent } from '../ai/mjai/types'
import {
  STARTING_SCORE_YONMA,
  STARTING_SCORE_SANMA,
  HONBA_TSUMO,
  HONBA_RON,
  KYOTAKU_VALUE,
} from './constants'

export interface CreateGameOptions {
  /** 3 = sanma, 4 = yonma. Default 4. */
  playerCount?: 3 | 4
  /** Total rounds. 4 = east-only, 8 = east+south. Default 8. */
  endRound?: number
  /**
   * Start dealer (起家) for this hanchan. Defaults to P0. In standard
   * Japanese mahjong, the starting dealer is random or rotated between
   * matches — verify benchmarks should cycle this so each player gets
   * equal time as initial East and seat advantages cancel out.
   */
  startDealer?: Player
  /**
   * Enable 古役 (classical yaku). Default false to match Mahjong Soul.
   * Currently only affects 大七星 detection.
   */
  koyakuMode?: boolean
  /** Enable 三家和 (triple ron abortive draw). Default false. */
  sanwahou?: boolean
  /** Fixed wall tiles for testing. If provided, skips shuffle. */
  fixedWall?: TileType[]
  /** Fixed hands per player for testing. Overrides dealt hands. */
  fixedHands?: TileType[][]
  /** Aka tiles per player hand (indices into the tile type, e.g. 4=5m, 13=5p, 22=5s). */
  fixedAka?: TileType[][]
}

export function createGame(opts: CreateGameOptions = {}): GameState {
  const playerCount = opts.playerCount ?? 4
  // Sanma has only 3 dealers, so each round set is 3 hands (not 4). The
  // CLI / callers pass 4/8 as a "east-only / hanchan" mode flag; we
  // normalize here so internal round logic (wind transition, end-of-game
  // check) sees the actual round count: yonma 4/8, sanma 3/6.
  const requested = opts.endRound ?? 8
  const endRound = playerCount === 3
    ? (requested === 4 ? 3 : requested === 8 ? 6 : requested)
    : requested
  const wall = opts.fixedWall
    ? { tiles: opts.fixedWall, drawIndex: 0, rinshanIndex: opts.fixedWall.length, doraCount: 1, akaPositions: new Set<number>() }
    : createWall(playerCount)
  const { hands, akaInHand } = opts.fixedHands
    ? { hands: opts.fixedHands, akaInHand: opts.fixedAka ?? opts.fixedHands.map(() => [] as TileType[]) }
    : dealHaipai(wall, playerCount)
  const doraMarkers = getDoraMarkers(wall)
  const dealer: Player = ((opts.startDealer ?? 0) % playerCount) as Player
  const startingScore = playerCount === 3 ? STARTING_SCORE_SANMA : STARTING_SCORE_YONMA

  const makePlayer = (hand: TileType[], idx: number): PlayerState => ({
    hand: hand.sort((a, b) => a - b),
    melds: [],
    discards: [],
    riichi: false,
    riichiTurn: 0,
    score: startingScore,
    isMenzen: true,
    kitaCount: 0,
    akaCount: akaInHand[idx]!.length,
    akaInHand: akaInHand[idx]!.slice(),
    akaInMelds: [],
  })

  return {
    playerCount,
    endRound,
    wall: wall.tiles,
    wallIndex: wall.drawIndex,
    rinshanIndex: wall.rinshanIndex,
    akaPositions: wall.akaPositions,
    doraMarkers,
    players: hands.map(makePlayer),
    currentPlayer: dealer,
    dealer,
    roundWind: 0,
    roundNumber: 1,
    honba: 0,
    kyotaku: 0,
    phase: 'draw',
    turnCount: 0,
    lastDiscard: null,
    lastDiscardPlayer: null,
    lastDrawnTile: null,
    ippatsu: false,
    koyakuMode: opts.koyakuMode ?? false,
    sanwahou: opts.sanwahou ?? false,
    paoTarget: null,
  }
}

function getWall(state: GameState): Wall {
  return {
    tiles: state.wall,
    drawIndex: state.wallIndex,
    rinshanIndex: state.rinshanIndex,
    doraCount: state.doraMarkers.length,
    akaPositions: state.akaPositions ?? new Set<number>(),
  }
}

/** Aka tile kinds (4=5m, 13=5p, 22=5s). */
const AKA_KIND = new Set<TileType>([4, 13, 22])

/** Recompute akaCount as the sum of akaInHand + akaInMelds. */
function akaTotal(p: PlayerState): number {
  return (p.akaInHand?.length ?? 0) + (p.akaInMelds?.length ?? 0)
}

/**
 * When the player discards `tile`, decide if the discard is the aka copy.
 * Rule: prefer to keep aka in hand — discard a regular copy if any
 * non-aka copy exists. Returns the updated PlayerState (including
 * akaInHand and akaCount) and whether the discarded tile was aka.
 */
function discardAkaTransition(
  p: PlayerState,
  tile: TileType,
  // hand state AFTER the tile was already physically removed (used for counting)
  handAfter: TileType[],
): { player: PlayerState; akaDiscarded: boolean } {
  if (!AKA_KIND.has(tile) || !(p.akaInHand?.includes(tile))) {
    return { player: p, akaDiscarded: false }
  }
  // Was the discarded copy the aka? Only if no regular copies remain.
  // Pre-discard there were (handAfter.count(tile) + 1) copies. Aka count
  // for this tile is 1 (each tile has only one aka). If pre-discard
  // count > 1, regular still around → discard regular; aka stays.
  const remaining = handAfter.filter(t => t === tile).length
  if (remaining >= 1) {
    return { player: p, akaDiscarded: false }
  }
  // No copies left → the aka was discarded.
  const newAkaInHand = (p.akaInHand ?? []).filter(t => t !== tile)
  return {
    player: {
      ...p,
      akaInHand: newAkaInHand,
      akaCount: newAkaInHand.length + (p.akaInMelds?.length ?? 0),
    },
    akaDiscarded: true,
  }
}

/**
 * When `consumedFromHand` tiles move out of hand into a meld, transfer
 * aka membership where forced. Same "prefer to keep aka in hand" rule
 * applies: if both regular and aka copies of a kind exist, the regular
 * goes to the meld; aka only goes if no regular copy remains in hand.
 */
function meldAkaTransition(
  p: PlayerState,
  consumedFromHand: TileType[],
  handAfter: TileType[],
): PlayerState {
  let akaInHand = (p.akaInHand ?? []).slice()
  let akaInMelds = (p.akaInMelds ?? []).slice()
  for (const t of consumedFromHand) {
    if (!AKA_KIND.has(t) || !akaInHand.includes(t)) continue
    // Were all remaining copies (incl. aka) needed? consumedFromHand may
    // include this tile multiple times. handAfter is post-consumption.
    const remaining = handAfter.filter(x => x === t).length
    if (remaining >= 1) continue // a regular copy stayed
    // Move the aka into the meld.
    akaInHand = akaInHand.filter(x => x !== t)
    akaInMelds.push(t)
  }
  return {
    ...p,
    akaInHand,
    akaInMelds,
    akaCount: akaInHand.length + akaInMelds.length,
  }
}

export function getValidActions(state: GameState): Action[] {
  const actions: Action[] = []

  switch (state.phase) {
    case 'draw': {
      actions.push({ kind: ActionKind.Pass }) // trigger auto-draw
      break
    }

    case 'discard': {
      const player = state.players[state.currentPlayer]
      const uniqueTiles = [...new Set(player.hand)]
      const forbidden = new Set(state.kuikae ?? [])

      for (const t of uniqueTiles) {
        if (!forbidden.has(t)) {
          actions.push({ kind: ActionKind.Discard, tile: t })
        }
      }

      // Tsumo — only if the hand has at least one yaku (no-yaku tsumo
      // is illegal under MJSoul rules).
      if (isWinningHand(player.hand)
          && state.lastDrawnTile !== null
          && previewWin(state, state.currentPlayer, true, state.lastDrawnTile)) {
        actions.push({ kind: ActionKind.Tsumo })
      }

      // Riichi: requires menzen, not already riichi, and ≥1000 points to put
      // down the riichi stick (Mahjong Soul rule). Generates one candidate
      // PER qualifying discard tile so the AI can pick which tile to riichi
      // on, not just the first one found.
      if (player.isMenzen && !player.riichi && player.score >= 1000) {
        for (const t of uniqueTiles) {
          const remaining = [...player.hand]
          const idx = remaining.indexOf(t)
          remaining.splice(idx, 1)
          if (calculateShanten(remaining, player.melds.length) === 0) {
            actions.push({ kind: ActionKind.Riichi, tile: t })
          }
        }
      }

      // Ankan
      for (const t of uniqueTiles) {
        if (player.hand.filter(x => x === t).length === 4) {
          actions.push({ kind: ActionKind.Ankan, tile: t })
        }
      }

      // Kakan
      for (const meld of player.melds) {
        if (meld.type === 'pon' && player.hand.includes(meld.tiles[0])) {
          actions.push({ kind: ActionKind.Kakan, tile: meld.tiles[0] })
        }
      }

      // 九種九牌: declarable by ANY player on THEIR first draw of the
      // round, provided no call (pon/chi/kan including ankan) has been
      // made by any seat. Two equivalent rule statements:
      //   - first 巡, before any call
      //   - my discards still empty AND no melds anywhere
      // The second form is what we check (turnCount alone wouldn't tell
      // us whether the current player has already discarded once).
      //
      // Previous code used `turnCount <= 1`, which silently restricted
      // the option to the dealer's first draw — non-dealers with 9
      // unique 幺九字 could not declare. Rule violation.
      const myFirstDraw = player.discards.length === 0
      const noCallsYet = state.players.every(p => p.melds.length === 0)
      if (myFirstDraw && noCallsYet) {
        const terminalSet = new Set(player.hand.filter(t =>
          [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33].includes(t)
        ))
        if (terminalSet.size >= 9) {
          actions.push({ kind: ActionKind.Kyushukyuhai })
        }
      }

      // Sanma 抜き北: if the player holds any North in hand during their
      // discard phase, they can declare kita as a free dora boost. Allowed
      // even after riichi (kita doesn't change the hand structure).
      if (state.playerCount === 3 && player.hand.includes(30)) {
        actions.push({ kind: ActionKind.Kita })
      }
      break
    }

    case 'respond': {
      // Chankan branch: the only legal response to a kakan is Ron on the
      // kakan'd tile (chankan yaku). No chi/pon/daiminkan.
      if (state.chankan) {
        const tile = state.chankan.tile
        const kaker = state.chankan.kaker
        for (let offset = 1; offset <= state.playerCount - 1; offset++) {
          const p = ((kaker as number) + offset) % state.playerCount as Player
          if (isWinningHand([...state.players[p].hand, tile])
              && previewWin(state, p, false, tile)) {
            actions.push({ kind: ActionKind.Ron, called: tile })
            break
          }
        }
        actions.push({ kind: ActionKind.Pass })
        break
      }

      const discarded = state.lastDiscard!
      const discardedBy = state.lastDiscardPlayer!
      const lastOffset = state.playerCount - 1

      // Ron (highest priority) — only if the responder has a yaku on the
      // discarded tile AND is not in furiten. No-yaku ron is illegal under
      // MJSoul rules; furiten ron is illegal under standard rules.
      // 三家家: if 3+ players can ron, suppress the Ron action — the
      // hand will be voided in applyPass instead.
      let ronPlayer: Player | null = null
      let ronCount = 0
      for (let offset = 1; offset <= lastOffset; offset++) {
        const p = ((discardedBy as number) + offset) % state.playerCount as Player
        if (!isWinningHand([...state.players[p].hand, discarded])) continue
        if (!previewWin(state, p, false, discarded)) continue
        if (isPermanentFuriten(state.players[p])) continue
        ronCount++
        if (ronPlayer === null) ronPlayer = p
      }
      if (ronPlayer !== null && !(state.sanwahou && ronCount >= 3)) {
        actions.push({ kind: ActionKind.Ron, called: discarded })
      }

      // Daiminkan — riichi locks the hand, no calls allowed.
      for (let offset = 1; offset <= lastOffset; offset++) {
        const p = ((discardedBy as number) + offset) % state.playerCount as Player
        if (state.players[p].riichi) continue
        if (state.players[p].hand.filter(t => t === discarded).length === 3) {
          actions.push({ kind: ActionKind.Daiminkan, called: discarded })
          break
        }
      }

      // Pon — same riichi restriction.
      for (let offset = 1; offset <= lastOffset; offset++) {
        const p = ((discardedBy as number) + offset) % state.playerCount as Player
        if (state.players[p].riichi) continue
        if (state.players[p].hand.filter(t => t === discarded).length >= 2) {
          actions.push({ kind: ActionKind.Pon, called: discarded })
          break
        }
      }

      // Chi (next player only) — disabled in sanma per Mahjong Soul rules.
      // Also disabled when the next player is in riichi.
      if (state.playerCount === 4) {
        const nextPlayer = ((discardedBy as number) + 1) % state.playerCount as Player
        if (!state.players[nextPlayer].riichi) {
          actions.push(...getChiActions(state.players[nextPlayer].hand, discarded, state.players[nextPlayer].akaInHand))
        }
      }

      actions.push({ kind: ActionKind.Pass })
      break
    }

    case 'kita_declare': {
      // Sanma chankita: anyone (other than the kita declarer) who can win on
      // North gets a Ron option, but only if they have at least one yaku.
      // Otherwise, Pass moves to engine-side resolution (declare kita,
      // drawRinshan, recurse if also North).
      const declarer = state.currentPlayer
      for (let offset = 1; offset <= state.playerCount - 1; offset++) {
        const p = ((declarer as number) + offset) % state.playerCount as Player
        if (isWinningHand([...state.players[p].hand, 30])
            && previewWin(state, p, false, 30)) {
          actions.push({ kind: ActionKind.Ron, called: 30 })
          break
        }
      }
      actions.push({ kind: ActionKind.Pass })
      break
    }
  }

  return actions
}

function getChiActions(hand: TileType[], discarded: TileType, akaInHand?: TileType[]): Action[] {
  const actions: Action[] = []
  if (discarded >= 27) return actions

  const suitStart = Math.floor(discarded / 9) * 9
  const rank = discarded - suitStart

  for (let lo = rank - 2; lo <= rank; lo++) {
    if (lo < 0 || lo + 2 >= 9) continue
    const seq = [suitStart + lo, suitStart + lo + 1, suitStart + lo + 2]
    if (!seq.includes(discarded)) continue

    const needed = seq.filter(t => t !== discarded) as [TileType, TileType]
    const handCopy = [...hand]
    let canChi = true
    for (const n of needed) {
      const idx = handCopy.indexOf(n)
      if (idx === -1) { canChi = false; break }
      handCopy.splice(idx, 1)
    }
    if (canChi) {
      // Check if any needed tile has both aka and non-aka copies in hand
      const akaSet = new Set(akaInHand ?? [])
      const hasAkaChoice = needed.some(t =>
        AKA_KIND.has(t) && akaSet.has(t) && hand.filter(x => x === t).length >= 2
      )
      if (hasAkaChoice) {
        actions.push({ kind: ActionKind.Chi, tiles: needed, called: discarded, useAka: false })
        actions.push({ kind: ActionKind.Chi, tiles: needed, called: discarded, useAka: true })
      } else {
        actions.push({ kind: ActionKind.Chi, tiles: needed, called: discarded })
      }
    }
  }

  return actions
}

/**
 * Apply an action and ALSO produce the MJAI event stream that describes
 * the transition. Equivalent to `applyAction(state, action)` for state,
 * plus the resulting MJAI events for any downstream consumer (mortal
 * bridge, MJAI log exporter, replay tools).
 *
 * The caller owns an `MjaiEmitter` instance and is responsible for
 * resetting it between hanchans (`new MjaiEmitter()`) — the emitter
 * carries kyoku transition state across calls.
 */
export function applyActionWithEvents(
  state: GameState,
  action: Action,
  emitter: MjaiEmitter,
): { state: GameState; events: MjaiEvent[] } {
  const before = state
  const after = applyAction(state, action)
  const events = emitter.observeAction(before, action, after)
  return { state: after, events }
}

// ── Abortive draw helpers ──────────────────────────────────────────

const KAN_TYPES = new Set(['ankan', 'kakan', 'daiminkan'])

/** Count total kan melds across all players. */
function totalKanCount(players: GameState['players']): number {
  let n = 0
  for (const p of players) for (const m of p.melds) if (KAN_TYPES.has(m.type)) n++
  return n
}

/**
 * 四開槓 (suu_kai_kan): 4+ kan melds exist from 2+ different players.
 * If one player has all 4 kans, that's 四槓子 yakuman, not abortive draw.
 */
function isSuuKaiKan(players: GameState['players']): boolean {
  if (totalKanCount(players) < 4) return false
  let kanPlayers = 0
  for (const p of players) {
    if (p.melds.some(m => KAN_TYPES.has(m.type))) kanPlayers++
  }
  return kanPlayers >= 2
}

/**
 * 四風連打 (suu_fuu_renda): first orbit, no calls, all 4 players discarded
 * the same wind tile. Tiles 27-30 are E/S/W/N winds.
 */
/** Dragon tiles: 中(31), 發(32), 白(33). */
const DRAGON_TILES = new Set([31, 32, 33])

/** Wind tiles: E(27), S(28), W(29), N(30). */
const WIND_TILES = new Set([27, 28, 29, 30])

/**
 * Check if a newly completed pon/daiminkan triggers 包牌 (pao).
 * Pao applies when the new call completes a deterministic yakuman:
 * - 大三元: the player now has pon of all 3 dragon types
 * - 大四喜: the player now has pon of all 4 wind types
 * Returns the paoTarget player (who discarded the completing tile) or null.
 */
function checkPao(players: GameState['players'], caller: number, calledTile: TileType, discardedBy: Player): Player | null {
  const melds = players[caller]?.melds
  if (!melds) return null

  // 大三元 pao: calledTile is a dragon, and after this pon, player has all 3
  if (DRAGON_TILES.has(calledTile)) {
    const dragonTypes = new Set<number>()
    for (const m of melds) {
      if ((m.type === 'pon' || m.type === 'daiminkan' || m.type === 'kakan') && DRAGON_TILES.has(m.tiles[0]!)) {
        dragonTypes.add(m.tiles[0]!)
      }
    }
    if (dragonTypes.size === 3) return discardedBy
  }

  // 大四喜 pao: calledTile is a wind, and after this pon, player has all 4
  if (WIND_TILES.has(calledTile)) {
    const windTypes = new Set<number>()
    for (const m of melds) {
      if ((m.type === 'pon' || m.type === 'daiminkan' || m.type === 'kakan') && WIND_TILES.has(m.tiles[0]!)) {
        windTypes.add(m.tiles[0]!)
      }
    }
    if (windTypes.size === 4) return discardedBy
  }

  return null
}

function isSuuFuuRenda(state: GameState): boolean {
  if (state.playerCount !== 4) return false
  if (state.turnCount > 4) return false
  if (!state.players.every(p => p.melds.length === 0)) return false
  if (!state.players.every(p => p.discards.length === 1)) return false
  const first = state.players[0].discards[0].tile
  if (first < 27 || first > 30) return false
  return state.players.every(p => p.discards[0].tile === first)
}

/**
 * 三家和 (san_wa_hou): 3 players can all declare ron on the last discard.
 */
function isSanwahou(state: GameState): boolean {
  if (state.playerCount !== 4) return false
  const discarded = state.lastDiscard
  const discardedBy = state.lastDiscardPlayer
  if (discarded == null || discardedBy == null) return false
  let ronCount = 0
  for (let offset = 1; offset <= 3; offset++) {
    const p = ((discardedBy as number) + offset) % 4 as Player
    if (isWinningHand([...state.players[p].hand, discarded])
        && previewWin(state, p, false, discarded)
        && !isPermanentFuriten(state.players[p])) {
      ronCount++
    }
  }
  return ronCount >= 3
}

export function applyAction(state: GameState, action: Action): GameState {
  switch (action.kind) {
    case ActionKind.Pass:
      return applyPass(state)
    case ActionKind.Discard:
      return applyDiscard(state, action)
    case ActionKind.Tsumo:
      return applyTsumo(state)
    case ActionKind.Ron:
      return applyRon(state, action)
    case ActionKind.Pon:
      return applyPon(state, action)
    case ActionKind.Chi:
      return applyChi(state, action)
    case ActionKind.Riichi:
      return applyRiichi(state, action)
    case ActionKind.Ankan:
      return applyAnkan(state, action)
    case ActionKind.Kakan:
      return applyKakan(state, action)
    case ActionKind.Daiminkan:
      return applyDaiminkan(state, action)
    case ActionKind.Kyushukyuhai:
      return applyRyukyokuTenpaiPayments({ ...state, phase: 'ryukyoku' })
    case ActionKind.Kita:
      // Sanma manual kita: transition to kita_declare phase. The 北 stays in
      // hand so chankita responders can simulate winning on it; resolveKita
      // removes it and draws a rinshan replacement after the chankita check.
      return { ...state, phase: 'kita_declare' }
    default:
      console.warn(`engine: applyAction — unknown action kind: ${(action as Action).kind}`)
      return state
  }
}

function applyPass(state: GameState): GameState {
  if (state.phase === 'draw') {
    return advanceToDraw(state, state.currentPlayer)
  }
  if (state.phase === 'respond') {
    // Chankan respond resolved with no ron: return to the kaker's discard
    // phase, keeping the rinshan-drawn tile already in hand. No wall draw.
    if (state.chankan) {
      return {
        ...state,
        phase: 'discard',
        currentPlayer: state.chankan.kaker,
        chankan: null,
      }
    }
    // 四開槓: 4 kans from 2+ players, and the kan player has now discarded
    // without anyone claiming ron → abortive draw. Must check BEFORE
    // advancing to next player's draw.
    if (isSuuKaiKan(state.players)) {
      return applyRyukyokuTenpaiPayments({ ...state, phase: 'ryukyoku' })
    }
    // 四風連打: first orbit, no calls, all 4 discards are the same wind
    if (isSuuFuuRenda(state)) {
      return applyRyukyokuTenpaiPayments({ ...state, phase: 'ryukyoku' })
    }
    // 三家家: 3 players can ron on this discard
    if (state.sanwahou && isSanwahou(state)) {
      return applyRyukyokuTenpaiPayments({ ...state, phase: 'ryukyoku' })
    }
    const nextPlayer = ((state.lastDiscardPlayer! as number) + 1) % state.playerCount as Player
    return advanceToDraw(state, nextPlayer)
  }
  if (state.phase === 'kita_declare') {
    return resolveKita(state)
  }
  console.warn(`engine: applyPass in unexpected phase: ${state.phase}`)
  return state
}

/**
 * Sanma kita resolution after all opponents pass on the chankita ron
 * opportunity: remove the North from the declarer's hand, increment
 * kitaCount, draw a replacement from the dead wall. If the replacement is
 * also North, re-enter kita_declare (recursive).
 */
function resolveKita(state: GameState): GameState {
  const player = state.currentPlayer
  const players = state.players.map((p, i) => {
    if (i !== player) return p
    const hand = [...p.hand]
    const idx = hand.indexOf(30)
    if (idx !== -1) hand.splice(idx, 1)
    return { ...p, hand, kitaCount: p.kitaCount + 1 }
  }) as GameState['players']

  const wall = getWall({ ...state, players })
  const result = drawRinshan(wall)
  if (!result) return applyRyukyokuTenpaiPayments({ ...state, players, phase: 'ryukyoku' })

  const playersWithDraw = players.map((p, i) => {
    if (i !== player) return p
    return {
      ...p,
      hand: [...p.hand, result.tile].sort((a, b) => a - b),
      akaInHand: result.aka ? [...(p.akaInHand ?? []), result.tile] : (p.akaInHand ?? []),
      akaCount: ((p.akaInHand?.length ?? 0) + (result.aka ? 1 : 0)) + (p.akaInMelds?.length ?? 0),
    }
  }) as GameState['players']

  const newState: GameState = {
    ...state,
    players: playersWithDraw,
    wall: result.wall.tiles,
    wallIndex: result.wall.drawIndex,
    rinshanIndex: result.wall.rinshanIndex,
    doraMarkers: getDoraMarkers(result.wall),
    lastDrawnTile: result.tile,
    phase: result.tile === 30 ? 'kita_declare' : 'discard',
  }
  return newState
}

function advanceToDraw(state: GameState, player: Player): GameState {
  const wall = getWall(state)
  const result = drawTile(wall)
  if (!result) return applyRyukyokuTenpaiPayments({ ...state, phase: 'ryukyoku' })

  const players = state.players.map((p, i) => {
    if (i !== player) return p
    return {
      ...p,
      hand: [...p.hand, result.tile].sort((a, b) => a - b),
      akaInHand: result.aka ? [...(p.akaInHand ?? []), result.tile] : (p.akaInHand ?? []),
      akaCount: (p.akaCount ?? 0) + (result.aka ? 1 : 0),
    }
  }) as GameState['players']

  // Sanma: drawing North auto-enters kita_declare. Opponents may chankita-ron;
  // if all pass, the engine resolves to declare kita + draw replacement.
  const isKitaTrigger = state.playerCount === 3 && result.tile === 30

  return {
    ...state,
    wall: result.wall.tiles,
    wallIndex: result.wall.drawIndex,
    rinshanIndex: result.wall.rinshanIndex,
    doraMarkers: getDoraMarkers(result.wall),
    players,
    currentPlayer: player,
    phase: isKitaTrigger ? 'kita_declare' : 'discard',
    turnCount: state.turnCount + 1,
    lastDiscard: null,
    lastDiscardPlayer: null,
    lastDrawnTile: result.tile,
  }
}

function applyDiscard(state: GameState, action: { tile: TileType }): GameState {
  const tsumogiri = action.tile === state.lastDrawnTile
  const players = state.players.map((p, i) => {
    if (i !== state.currentPlayer) return p
    const hand = [...p.hand]
    const idx = hand.indexOf(action.tile)
    hand.splice(idx, 1)
    const withDiscard: PlayerState = {
      ...p,
      hand,
      discards: [...p.discards, { tile: action.tile, tsumogiri }],
    }
    return discardAkaTransition(withDiscard, action.tile, hand).player
  }) as GameState['players']

  return {
    ...state,
    players,
    lastDiscard: action.tile,
    lastDiscardPlayer: state.currentPlayer,
    phase: 'respond',
    atRinshan: false,
    kuikae: undefined,
  }
}

/**
 * Tsumo settlement: winner = state.currentPlayer, winningTile = the tile
 * just drawn. Computes the win evaluation, transfers points (including
 * honba and any kyotaku on the table), and sets phase to tsumo_win.
 *
 * Yaku gating: getValidActions() only exposes the Tsumo action when the
 * hand has at least one yaku. As a defensive backstop, this function
 * also rejects no-yaku tsumo by returning the state unchanged.
 */
export function checkTobi(state: GameState): boolean {
  return state.players.some(p => p.score < 0)
}

export interface FinalStanding {
  player: Player
  score: number
  rank: number  // 1 = highest
}

export function finalRanking(state: GameState): FinalStanding[] {
  const sorted = state.players
    .map((p, i) => ({ player: i as Player, score: p.score }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      if (a.player === state.dealer) return -1
      if (b.player === state.dealer) return 1
      return a.player - b.player
    })
  return sorted.map((entry, i) => ({ ...entry, rank: i + 1 }))
}

function finalizeGame(state: GameState): GameState {
  if (state.kyotaku > 0) {
    const ranking = finalRanking(state)
    const top = ranking[0].player
    const players = state.players.map((p, i) =>
      i === top ? { ...p, score: p.score + state.kyotaku * 1000 } : p
    )
    return { ...state, players, kyotaku: 0, phase: 'game_over' }
  }
  return { ...state, phase: 'game_over' }
}

export function applyTsumo(state: GameState): GameState {
  const winner = state.currentPlayer
  const winningTile = state.lastDrawnTile
  if (winningTile === null) {
    console.warn(`engine: applyTsumo with no winningTile (phase=${state.phase} player=${winner})`)
    return state
  }

  const evalResult = evaluateWin(state, winner, true, winningTile)
  if (!evalResult.hasYaku) {
    console.warn(`engine: applyTsumo rejected — no yaku (player=${winner})`)
    return state
  }

  const isDealerWin = winner === state.dealer
  const honbaPay = HONBA_TSUMO * state.honba
  const newScores = state.players.map(p => p.score)
  const pao = state.paoTarget != null && evalResult.isYakuman ? state.paoTarget : null

  let totalCollected = 0
  for (let i = 0; i < state.playerCount; i++) {
    if (i === winner) continue
    let pay: number
    if (isDealerWin) {
      pay = evalResult.scoreResult.tsumoDealer
    } else {
      pay = (i === state.dealer)
        ? evalResult.scoreResult.tsumoDealerPays
        : evalResult.scoreResult.tsumoChild
    }
    pay += honbaPay
    if (pao != null) {
      // Pao: the pao target pays for everyone. Non-pao non-winner players pay 0.
      if (i === pao) {
        // Accumulate total that everyone would pay
        totalCollected += pay
      }
      // Don't deduct from other players yet — we'll deduct total from pao target
    } else {
      newScores[i] -= pay
      totalCollected += pay
    }
  }
  if (pao != null) {
    newScores[pao] -= totalCollected
  }
  newScores[winner] += totalCollected + state.kyotaku * KYOTAKU_VALUE

  const newPlayers = state.players.map((p, i) => ({
    ...p,
    score: newScores[i],
  })) as GameState['players']

  return {
    ...state,
    players: newPlayers,
    kyotaku: 0,
    phase: 'tsumo_win',
  }
}

/**
 * Ron settlement (including chankita). Identifies the loser and the winner
 * by walking forward from the source player, validates the win has at
 * least one yaku, and transfers points: loser pays ronPayment + honba,
 * winner collects same + kyotaku. Triple-ron is resolved by head-bump
 * (the existing nearest-first loop), per Mahjong Soul rules.
 *
 * Yaku gating: getValidActions() exposes Ron only when previewWin is true.
 * applyRon repeats the check defensively (no-yaku ron returns the state
 * unchanged).
 */
function applyRon(state: GameState, action: { called: TileType }): GameState {
  // Loser depends on the respond phase variant:
  // - chankita (sanma): the kita declarer in state.currentPlayer.
  // - chankan: the kakan-er stored in state.chankan.kaker.
  // - normal ron: the player who just discarded (state.lastDiscardPlayer).
  const isChankita = state.phase === 'kita_declare'
  const isChankan = state.phase === 'respond' && state.chankan != null
  const loser: Player = isChankita
    ? state.currentPlayer
    : isChankan
      ? state.chankan!.kaker
      : state.lastDiscardPlayer!
  const calledTile = action.called

  // Find winner by head-bump (nearest player after the loser).
  let winner: Player | null = null
  for (let offset = 1; offset <= state.playerCount - 1; offset++) {
    const p = ((loser as number) + offset) % state.playerCount as Player
    if (isWinningHand([...state.players[p].hand, calledTile])
        && previewWin(state, p, false, calledTile)) {
      winner = p
      break
    }
  }
  if (winner === null) {
    console.warn(`engine: applyRon — no valid winner (loser=${loser} called=${calledTile})`)
    return state
  }

  const evalResult = evaluateWin(state, winner, false, calledTile)
  if (!evalResult.hasYaku) {
    console.warn(`engine: applyRon rejected — no yaku (winner=${winner} called=${calledTile})`)
    return state
  }

  const honbaPay = HONBA_RON * state.honba
  const pao = state.paoTarget != null && evalResult.isYakuman ? state.paoTarget : null

  const newScores = state.players.map(p => p.score)
  if (pao != null) {
    // Pao for ron: pao target and discarder split the base payment.
    // Pao target pays basePayment/2 + honba, loser pays basePayment/2.
    const halfBase = Math.floor(evalResult.scoreResult.ronPayment / 2)
    newScores[pao] -= (evalResult.scoreResult.ronPayment - halfBase + honbaPay)
    newScores[loser] -= halfBase
  } else {
    const totalFromLoser = evalResult.scoreResult.ronPayment + honbaPay
    newScores[loser] -= totalFromLoser
  }
  const totalCollected = evalResult.scoreResult.ronPayment + honbaPay
  newScores[winner] += totalCollected + state.kyotaku * KYOTAKU_VALUE

  const newPlayers = state.players.map((p, i) => ({
    ...p,
    score: newScores[i],
  })) as GameState['players']

  return {
    ...state,
    players: newPlayers,
    currentPlayer: winner,
    kyotaku: 0,
    phase: 'ron_win',
  }
}

function applyPon(state: GameState, action: { called: TileType }): GameState {
  const discardedBy = state.lastDiscardPlayer!
  for (let offset = 1; offset <= state.playerCount - 1; offset++) {
    const p = ((discardedBy as number) + offset) % state.playerCount as Player
    if (state.players[p].hand.filter(t => t === action.called).length >= 2) {
      const players = state.players.map((pl, i) => {
        if (i !== p) return pl
        const hand = [...pl.hand]
        for (let k = 0; k < 2; k++) {
          const idx = hand.indexOf(action.called)
          hand.splice(idx, 1)
        }
        const consumed = [action.called, action.called]
        const withMeld: PlayerState = {
          ...pl,
          hand,
          melds: [...pl.melds, {
            type: 'pon' as const,
            tiles: [action.called, action.called, action.called],
            calledFrom: discardedBy,
          }],
          isMenzen: false,
        }
        return meldAkaTransition(withMeld, consumed, hand)
      }) as GameState['players']

      // Remove from discarder's discards
      const discarderPlayers = players.map((pl, i) => {
        if (i !== discardedBy) return pl
        const discards = [...pl.discards]
        discards.pop()
        return { ...pl, discards }
      }) as GameState['players']

      // Check if this pon triggers pao (包牌)
      const paoTarget = state.paoTarget ?? checkPao(discarderPlayers, p, action.called, discardedBy)

      return {
        ...state,
        players: discarderPlayers,
        currentPlayer: p,
        phase: 'discard',
        lastDiscard: null,
        lastDiscardPlayer: null,
        lastDrawnTile: null,
        paoTarget,
        kuikae: [action.called],
      }
    }
  }
  console.warn(`engine: applyPon — no valid responder (called=${action.called})`)
  return state
}

/**
 * Kuikae (食替) for chi: cannot discard the called tile or the tile that
 * would complete the sequence from the other end (suji-kuikae).
 * E.g. chi 4+5 with called 3 → cannot discard 3 or 6.
 * E.g. chi 3+5 with called 4 → cannot discard 4 (only the called tile).
 */
function chiKuikae(tiles: [TileType, TileType], called: TileType): TileType[] {
  const sorted = [tiles[0], tiles[1], called].sort((a, b) => a - b)
  const forbidden: TileType[] = [called]
  const suit = Math.floor(called / 9)
  // If called is at the low end, the suji tile is sorted[2]+1
  if (called === sorted[0]) {
    const suji = sorted[2] + 1
    if (Math.floor(suji / 9) === suit && suji % 9 < 9) forbidden.push(suji)
  }
  // If called is at the high end, the suji tile is sorted[0]-1
  else if (called === sorted[2]) {
    const suji = sorted[0] - 1
    if (Math.floor(suji / 9) === suit && suji % 9 >= 0 && suji >= suit * 9) forbidden.push(suji)
  }
  // If called is in the middle (kanchan), only the called tile is forbidden
  return forbidden
}

function applyChi(state: GameState, action: { tiles: [TileType, TileType]; called: TileType; useAka?: boolean }): GameState {
  if (state.playerCount === 3) return state // chi is disabled in sanma
  const nextPlayer = ((state.lastDiscardPlayer! as number) + 1) % state.playerCount as Player
  const players = state.players.map((p, i) => {
    if (i !== nextPlayer) return p
    const hand = [...p.hand]
    for (const t of action.tiles) {
      const idx = hand.indexOf(t)
      hand.splice(idx, 1)
    }
    const withMeld: PlayerState = {
      ...p,
      hand,
      melds: [...p.melds, {
        type: 'chi' as const,
        tiles: [...action.tiles, action.called].sort((a, b) => a - b),
        calledFrom: state.lastDiscardPlayer!,
      }],
      isMenzen: false,
    }
    let result = meldAkaTransition(withMeld, [...action.tiles], hand)
    // Handle explicit aka choice
    if (action.useAka === true) {
      // Force aka into meld
      const akaTile = action.tiles.find(t => AKA_KIND.has(t) && (result.akaInHand ?? []).includes(t))
      if (akaTile != null) {
        result = { ...result, akaInHand: (result.akaInHand ?? []).filter(x => x !== akaTile), akaInMelds: [...(result.akaInMelds ?? []), akaTile], akaCount: result.akaCount }
      }
    } else if (action.useAka === false) {
      // Force aka to stay in hand (undo if meldAkaTransition moved it)
      const akaTile = action.tiles.find(t => AKA_KIND.has(t) && (result.akaInMelds ?? []).includes(t) && !(p.akaInMelds ?? []).includes(t))
      if (akaTile != null) {
        result = { ...result, akaInHand: [...(result.akaInHand ?? []), akaTile], akaInMelds: (result.akaInMelds ?? []).filter(x => x !== akaTile), akaCount: result.akaCount }
      }
    }
    return result
  }) as GameState['players']

  // Remove from discarder's discards
  const discardedBy = state.lastDiscardPlayer!
  const fixedPlayers = players.map((pl, i) => {
    if (i !== discardedBy) return pl
    const discards = [...pl.discards]
    discards.pop()
    return { ...pl, discards }
  }) as GameState['players']

  return {
    ...state,
    players: fixedPlayers,
    currentPlayer: nextPlayer,
    phase: 'discard',
    lastDiscard: null,
    lastDiscardPlayer: null,
    lastDrawnTile: null,
    kuikae: chiKuikae(action.tiles, action.called),
  }
}

function applyRiichi(state: GameState, action: { tile: TileType }): GameState {
  // Daburii (W立直) eligibility is locked AT declaration: still in the first
  // orbit (turnCount <= playerCount) and no chi/pon/kan has happened
  // anywhere yet (every player still has zero melds — meld count covers
  // ankan too, which keeps the player menzen but is still a call). Daburii
  // does NOT get cancelled by later calls in the same hand.
  const daburiiEligible =
    state.turnCount <= state.playerCount &&
    state.players.every(p => p.melds.length === 0)
  const players = state.players.map((p, i) => {
    if (i !== state.currentPlayer) return p
    return {
      ...p,
      riichi: true,
      riichiTurn: state.turnCount,
      score: p.score - 1000,
      daburii: daburiiEligible,
    }
  }) as GameState['players']

  // Defense in depth: if the riichi -1000 deduction pushes the player below
  // zero, end the game immediately. getValidActions's score>=1000 guard
  // should prevent this from triggering in normal play.
  const declarer = players[state.currentPlayer]
  if (declarer.score < 0) {
    return finalizeGame({ ...state, players, kyotaku: state.kyotaku + 1 })
  }

  const discardState = applyDiscard({ ...state, players }, { tile: action.tile })
  return { ...discardState, kyotaku: state.kyotaku + 1 }
}

function applyAnkan(state: GameState, action: { tile: TileType }): GameState {
  const players = state.players.map((p, i) => {
    if (i !== state.currentPlayer) return p
    const hand = [...p.hand]
    for (let k = 0; k < 4; k++) {
      const idx = hand.indexOf(action.tile)
      hand.splice(idx, 1)
    }
    // Ankan absorbs all 4 copies of action.tile. Any aka of this tile in
    // hand moves to the meld (akaInMelds), out of akaInHand.
    const hadAkaOfTile = (p.akaInHand ?? []).includes(action.tile)
    return {
      ...p,
      hand,
      melds: [...p.melds, {
        type: 'ankan' as const,
        tiles: [action.tile, action.tile, action.tile, action.tile],
        calledFrom: i as Player,
      }],
      akaInHand: (p.akaInHand ?? []).filter(t => t !== action.tile),
      akaInMelds: hadAkaOfTile ? [...(p.akaInMelds ?? []), action.tile] : (p.akaInMelds ?? []),
    }
  }) as GameState['players']

  const wall = getWall({ ...state, players })
  const result = drawRinshan(wall)
  if (!result) return { ...state, players, phase: 'ryukyoku' }

  const playersWithDraw = players.map((p, i) => {
    if (i !== state.currentPlayer) return p
    return {
      ...p,
      hand: [...p.hand, result.tile].sort((a, b) => a - b),
      akaInHand: result.aka ? [...(p.akaInHand ?? []), result.tile] : (p.akaInHand ?? []),
      akaCount: ((p.akaInHand ?? []).length + (result.aka ? 1 : 0)) + (p.akaInMelds ?? []).length,
    }
  }) as GameState['players']

  return {
    ...state,
    players: playersWithDraw,
    wall: result.wall.tiles,
    wallIndex: result.wall.drawIndex,
    rinshanIndex: result.wall.rinshanIndex,
    doraMarkers: getDoraMarkers(result.wall),
    phase: 'discard',
    lastDrawnTile: result.tile,
    atRinshan: true,
  }
}

function applyKakan(state: GameState, action: { tile: TileType }): GameState {
  const players = state.players.map((p, i) => {
    if (i !== state.currentPlayer) return p
    const hand = [...p.hand]
    const idx = hand.indexOf(action.tile)
    hand.splice(idx, 1)
    const melds = p.melds.map(m =>
      m.type === 'pon' && m.tiles[0] === action.tile
        ? { ...m, type: 'kakan' as const, tiles: [...m.tiles, action.tile] }
        : m
    )
    // Kakan: 1 of `action.tile` moves from hand to existing pon-now-kakan
    // meld. If it was the aka copy, transfer it.
    const withMeld: PlayerState = { ...p, hand, melds }
    return meldAkaTransition(withMeld, [action.tile], hand)
  }) as GameState['players']

  const wall = getWall({ ...state, players })
  const result = drawRinshan(wall)
  if (!result) return { ...state, players, phase: 'ryukyoku' }

  const playersWithDraw = players.map((p, i) => {
    if (i !== state.currentPlayer) return p
    return {
      ...p,
      hand: [...p.hand, result.tile].sort((a, b) => a - b),
      akaInHand: result.aka ? [...(p.akaInHand ?? []), result.tile] : (p.akaInHand ?? []),
      akaCount: ((p.akaInHand?.length ?? 0) + (result.aka ? 1 : 0)) + (p.akaInMelds?.length ?? 0),
    }
  }) as GameState['players']

  return {
    ...state,
    players: playersWithDraw,
    wall: result.wall.tiles,
    wallIndex: result.wall.drawIndex,
    rinshanIndex: result.wall.rinshanIndex,
    doraMarkers: getDoraMarkers(result.wall),
    // Open the chankan window. Respond machinery uses state.chankan (set
    // here) to know we're in robbing-the-kan mode, where only Ron is a
    // legal response and the called tile is `action.tile` (not the stale
    // lastDiscard). applyPass in chankan mode returns to the kaker's
    // discard phase without advancing the wall.
    phase: 'respond',
    chankan: { tile: action.tile, kaker: state.currentPlayer },
    lastDrawnTile: result.tile,
    atRinshan: true,
  }
}

function applyDaiminkan(state: GameState, action: { called: TileType }): GameState {
  const discardedBy = state.lastDiscardPlayer!
  for (let offset = 1; offset <= state.playerCount - 1; offset++) {
    const p = ((discardedBy as number) + offset) % state.playerCount as Player
    if (state.players[p].hand.filter(t => t === action.called).length === 3) {
      const players = state.players.map((pl, i) => {
        if (i !== p) return pl
        const hand = [...pl.hand]
        for (let k = 0; k < 3; k++) {
          const idx = hand.indexOf(action.called)
          hand.splice(idx, 1)
        }
        // Daiminkan: all 3 copies of action.called from hand go to meld.
        // If the aka was among them (we always had at most 1 aka per tile
        // kind), it must move.
        const consumed = [action.called, action.called, action.called]
        const withMeld: PlayerState = {
          ...pl,
          hand,
          melds: [...pl.melds, {
            type: 'daiminkan' as const,
            tiles: [action.called, action.called, action.called, action.called],
            calledFrom: discardedBy,
          }],
          isMenzen: false,
        }
        return meldAkaTransition(withMeld, consumed, hand)
      }) as GameState['players']

      // 四開槓 check moved to applyPass (must wait for discard + no ron)
      const wall = getWall({ ...state, players, currentPlayer: p })
      const result = drawRinshan(wall)
      if (!result) return { ...state, players, phase: 'ryukyoku' }

      const playersWithDraw = players.map((pl, i) => {
        if (i !== p) return pl
        return {
          ...pl,
          hand: [...pl.hand, result.tile].sort((a, b) => a - b),
          akaInHand: result.aka ? [...(pl.akaInHand ?? []), result.tile] : (pl.akaInHand ?? []),
          akaCount: ((pl.akaInHand?.length ?? 0) + (result.aka ? 1 : 0)) + (pl.akaInMelds?.length ?? 0),
        }
      }) as GameState['players']

      // Check if this daiminkan triggers pao (包牌)
      const paoTarget = state.paoTarget ?? checkPao(players, p, action.called, discardedBy)

      return {
        ...state,
        players: playersWithDraw,
        currentPlayer: p,
        wall: result.wall.tiles,
        wallIndex: result.wall.drawIndex,
        rinshanIndex: result.wall.rinshanIndex,
        doraMarkers: getDoraMarkers(result.wall),
        phase: 'discard',
        lastDiscard: null,
        lastDiscardPlayer: null,
        lastDrawnTile: result.tile,
        atRinshan: true,
        paoTarget,
      }
    }
  }
  console.warn(`engine: applyDaiminkan — no valid responder (called=${action.called})`)
  return state
}

function isPlayerTenpai(p: PlayerState): boolean {
  if (p.riichi) return true
  return calculateShanten(p.hand, p.melds.length) === 0
}

/**
 * Permanent (this-round) furiten: the player has at least one wait tile
 * that they themselves have already discarded. They cannot ron on ANY of
 * their wait tiles for the rest of the round, only tsumo.
 *
 * Wait set = every tile T for which `isWinningHand(hand + T)` is true.
 * Iteration is bounded by 34 tile kinds (yonma) so this is cheap.
 *
 * Temporary furiten (passed-up ron earlier in same go-around) is not yet
 * tracked. Riichi furiten (post-riichi missed ron forces furiten for the
 * remaining round) reduces to permanent here too, so we don't need a
 * separate branch as long as `discards` is comprehensive.
 */
export function isPermanentFuriten(p: PlayerState): boolean {
  const discardSet = new Set<TileType>()
  for (const d of p.discards) discardSet.add(d.tile)
  if (discardSet.size === 0) return false
  // Enumerate possible wait tiles. 0..33 covers all tile kinds (m/p/s/honor).
  for (let t = 0 as TileType; t < 34; t = (t + 1) as TileType) {
    if (isWinningHand([...p.hand, t])) {
      if (discardSet.has(t)) return true
    }
  }
  return false
}

function applyRyukyokuTenpaiPayments(state: GameState): GameState {
  const tenpai = state.players.map(isPlayerTenpai)
  const tenpaiCount = tenpai.filter(Boolean).length
  const notenCount = state.playerCount - tenpaiCount

  // All tenpai or all noten: no payment
  if (tenpaiCount === 0 || tenpaiCount === state.playerCount) return state

  const perTenpai = 3000 / tenpaiCount
  const perNoten = 3000 / notenCount

  const players = state.players.map((p, i) => ({
    ...p,
    score: p.score + (tenpai[i] ? perTenpai : -perNoten),
  }))
  return { ...state, players }
}

export function nextRound(state: GameState): GameState {
  if (state.phase !== 'tsumo_win' && state.phase !== 'ron_win' && state.phase !== 'ryukyoku') {
    return state
  }

  // Tobi check: any player score < 0 → game over
  if (checkTobi(state)) {
    return finalizeGame(state)
  }

  // Dealer win (tsumo or ron): dealer stays, honba +1
  const isDealerWin = (state.phase === 'tsumo_win' || state.phase === 'ron_win') && state.currentPlayer === state.dealer
  if (isDealerWin) {
    return newRound(state, state.dealer, state.roundNumber, state.roundWind, state.honba + 1)
  }

  // Ryukyoku: check dealer tenpai
  if (state.phase === 'ryukyoku') {
    const dealerTenpai = isPlayerTenpai(state.players[state.dealer])
    if (dealerTenpai) {
      // Dealer tenpai → renchan, honba +1
      return newRound(state, state.dealer, state.roundNumber, state.roundWind, state.honba + 1)
    }
    // Dealer noten → dealer rotates, round advances, honba +1
    const newDealer = ((state.dealer as number) + 1) % state.playerCount as Player
    const newRoundNumber = state.roundNumber + 1
    let newRoundWind: Wind = state.roundWind
    // East round has 4 hands in yonma, 3 in sanma. South starts at the round
    // immediately after the last east hand.
    const eastRounds = state.playerCount === 3 ? 3 : 4
    if (newRoundNumber === eastRounds + 1) newRoundWind = 1
    if (newRoundNumber > state.endRound) return finalizeGame(state)
    return newRound(state, newDealer, newRoundNumber, newRoundWind, state.honba + 1)
  }

  // Child win (tsumo or ron): dealer rotates, honba resets to 0
  const newDealer = ((state.dealer as number) + 1) % state.playerCount as Player
  let newRoundNumber = state.roundNumber + 1
  let newRoundWind: Wind = state.roundWind

  // East round has 4 hands in yonma, 3 in sanma. South starts at round
  // (eastRounds + 1).
  const eastRounds = state.playerCount === 3 ? 3 : 4
  if (newRoundNumber === eastRounds + 1) newRoundWind = 1
  if (newRoundNumber > state.endRound) return finalizeGame(state)

  return newRound(state, newDealer, newRoundNumber, newRoundWind, 0)
}

function newRound(
  state: GameState,
  dealer: Player,
  roundNumber: number,
  roundWind: Wind,
  honba: number,
): GameState {
  const wall = createWall(state.playerCount)
  const { hands, akaInHand } = dealHaipai(wall, state.playerCount)

  const makePlayer = (hand: TileType[], oldPlayer: PlayerState, idx: number): PlayerState => ({
    ...oldPlayer,
    hand: hand.sort((a, b) => a - b),
    melds: [],
    discards: [],
    riichi: false,
    riichiTurn: 0,
    isMenzen: true,
    kitaCount: 0,
    akaCount: akaInHand[idx]!.length,
    akaInHand: akaInHand[idx]!.slice(),
    akaInMelds: [],
  })

  return {
    playerCount: state.playerCount,
    endRound: state.endRound,
    wall: wall.tiles,
    wallIndex: wall.drawIndex,
    rinshanIndex: wall.rinshanIndex,
    akaPositions: wall.akaPositions,
    doraMarkers: getDoraMarkers(wall),
    players: hands.map((h, i) => makePlayer(h, state.players[i], i)),
    currentPlayer: dealer,
    dealer,
    roundWind,
    roundNumber,
    honba,
    kyotaku: state.kyotaku,
    phase: 'draw',
    turnCount: 0,
    lastDiscard: null,
    lastDiscardPlayer: null,
    lastDrawnTile: null,
    ippatsu: false,
    koyakuMode: state.koyakuMode,
    sanwahou: state.sanwahou,
    paoTarget: null,
  }
}
