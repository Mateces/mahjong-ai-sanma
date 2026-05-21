#!/usr/bin/env -S npx tsx
/**
 * Replay tenhou MJAI logs against our TS engine to find rule disagreements.
 *
 * Phase L1: for every `hora` event in the log, verify isWinningHand returns
 * true on the player's actual winning shape. The log was produced by a real
 * mahjong server enforcing real rules, so every hora is by construction a
 * legitimate win. Anywhere our isWinningHand says "no" is a bug in our
 * hand-decomposition logic.
 *
 * Usage:
 *     npx tsx scripts/replay-mjai.ts <path>...
 * Paths can be files or directories; directories are recursed for *.mjson.
 *
 * Output:
 *     - Per-failure: one JSON line {file, line, kyoku, hand, melds, winTile}
 *       to stderr.
 *     - Summary: total games, hora events, failures, to stdout.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as zlib from 'node:zlib'
import { isWinningHand } from '../src/game/hand-analysis'
import { mjaiToTile } from '../src/ai/mjai/tile'
import { evaluateYaku } from '../src/game/yaku'
import { evaluateWin } from '../src/game/win-evaluation'
import { HONBA_RON, HONBA_TSUMO, KYOTAKU_VALUE } from '../src/game/constants'
import type { TileType, PlayerState, Wind, Player, GameState, Meld as EngineMeld } from '../src/game/types'
import { getValidActions, applyAction } from '../src/game/engine'
import { mjaiReactionToAction } from '../src/ai/mjai/emit'

interface MjaiEvent {
  type: string
  actor?: number
  target?: number
  pai?: string
  consumed?: string[]
  tehais?: string[][]
  bakaze?: string
  kyoku?: number
  honba?: number
  oya?: number
  tsumogiri?: boolean
  deltas?: number[]
  [k: string]: unknown
}

interface Meld {
  type: 'chi' | 'pon' | 'daiminkan' | 'ankan' | 'kakan'
  tiles: TileType[]
}

interface Failure {
  file: string
  line: number
  kyoku: { bakaze: string; kyoku: number; honba: number } | null
  actor: number
  isTsumo: boolean
  winTile: TileType | null
  concealed: TileType[]
  melds: Meld[]
  reason: string
  /** Only set on L1.5+ delta failures. */
  expected?: number[]
  computed?: number[]
  han?: number
  fu?: number
  yakuNames?: string[]
  akaCount?: number
}

function bakazeToWind(s: string): Wind {
  switch (s) {
    case 'E': return 0
    case 'S': return 1
    case 'W': return 2
    case 'N': return 3
    default: return 0
  }
}

class GameTracker {
  hands: TileType[][] = [[], [], [], []]
  melds: Meld[][] = [[], [], [], []]
  isMenzen: boolean[] = [true, true, true, true]
  riichi: boolean[] = [false, false, false, false]
  lastDrawn: (TileType | null)[] = [null, null, null, null]
  lastDahai: TileType | null = null
  lastDahaiActor: number | null = null
  /** Was the most recent dahai an aka tile? Used so that a ron on that
   *  dahai correctly credits the winning hand with +1 aka-dora han. */
  lastDahaiIsAka: boolean = false
  /** Was the most recent kakan'd tile an aka? Same for chankan ron. */
  lastKakanIsAka: boolean = false
  /** Set by ankan/kakan/daiminkan; cleared by any other event from the same
   *  actor. Used to detect rinshan tsumo (hora on a rinshan draw). */
  pendingRinshanActor: number | null = null
  /** Set by `kakan` event; cleared by the next non-hora event. A hora event
   *  immediately following a kakan represents chankan (robbing the kan):
   *  the winning tile is the kakan'd tile, not the previous dahai. */
  pendingChankanTile: TileType | null = null
  pendingChankanActor: number | null = null
  /** True after a kan (any type) + rinshan tsumo, cleared after the
   *  subsequent dahai. Used to clear ippatsu after kan finalization. */
  kanRinshanPending: boolean = false
  bakaze: Wind = 0
  oya: number = 0
  /** Mirrors libriichi's per-kyoku `tiles_left = 70` budget. */
  tilesLeft: number = 70
  /** Per-player score in points (1000-multiples). Set from start_kyoku. */
  scores: number[] = [25000, 25000, 25000, 25000]
  /** Active dora indicators (first + any kan-dora added). */
  doraMarkers: TileType[] = []
  honba: number = 0
  kyotaku: number = 0
  /** Aka-dora counter per player. */
  akaCount: number[] = [0, 0, 0, 0]
  /** Per-player ippatsu validity. True from reach_accepted until that
   *  player's next own discard, or until anyone calls (chi/pon/kan). */
  ippatsuActive: boolean[] = [false, false, false, false]
  /** Per-player count of own dahais played this kyoku. Used to detect
   *  whether a riichi declaration was on the player's first own discard
   *  (one criterion for daburii). Incremented on each dahai event. */
  ownDahaiCount: number[] = [0, 0, 0, 0]
  /** True once any chi/pon/kan/kakan/daiminkan/ankan has fired in this
   *  kyoku. Daburii requires this to be false at reach_accepted time. */
  anyCallMade: boolean = false
  /** Per-player W立直 (double riichi). Set true on reach_accepted iff this
   *  was the player's first own dahai AND no calls had happened yet.
   *  Persists through scoring; daburii does not get cancelled by later
   *  calls. */
  daburii: boolean[] = [false, false, false, false]
  /** Per-player discard pile. Populated on dahai; popped on chi/pon/daiminkan
   *  (the called tile is removed from the discarder's pile). */
  discards: TileType[][] = [[], [], [], []]
  /** Who the engine considers the current player. Updated on tsumo/chi/pon/kan. */
  currentPlayer: number = 0
  /** Number of tsumo events this kyoku. Used for kyushukyuhai / first-draw check. */
  turnCount: number = 0
  currentKyoku: { bakaze: string; kyoku: number; honba: number } | null = null
  /** Per-player pao target (null if no pao active). Set when a pon/daiminkan
   *  call completes 大三元 (all 3 dragons) or 大四喜 (all 4 winds).
   *  The value is the player whose discard was taken for the completing call. */
  paoTarget: (number | null)[] = [null, null, null, null]

  resetKyoku(ev: MjaiEvent) {
    if (!ev.tehais) return
    this.hands = ev.tehais.map(h => h.map(s => mjaiToTile(s)).sort((a, b) => a - b))
    this.akaCount = ev.tehais.map(h => h.filter(s => s.endsWith('r')).length)
    this.ippatsuActive = [false, false, false, false]
    this.ownDahaiCount = [0, 0, 0, 0]
    this.anyCallMade = false
    this.daburii = [false, false, false, false]
    this.discards = [[], [], [], []]
    this.currentPlayer = ev.oya ?? 0
    this.turnCount = 0
    this.melds = [[], [], [], []]
    this.isMenzen = [true, true, true, true]
    this.riichi = [false, false, false, false]
    this.lastDrawn = [null, null, null, null]
    this.lastDahai = null
    this.lastDahaiActor = null
    this.pendingRinshanActor = null
    this.pendingChankanTile = null
    this.pendingChankanActor = null
    this.kanRinshanPending = false
    this.paoTarget = [null, null, null, null]
    this.bakaze = bakazeToWind(ev.bakaze ?? 'E')
    this.oya = ev.oya ?? 0
    this.tilesLeft = 70
    this.scores = (ev.scores as number[]) ?? [25000, 25000, 25000, 25000]
    this.doraMarkers = ev.dora_marker ? [mjaiToTile(ev.dora_marker as string)] : []
    this.honba = ev.honba ?? 0
    this.kyotaku = ev.kyotaku ?? 0
    this.currentKyoku = {
      bakaze: ev.bakaze ?? 'E',
      kyoku: ev.kyoku ?? 1,
      honba: ev.honba ?? 0,
    }
  }

  /** Seat wind for `actor` relative to the dealer. E=0 for dealer, then S,W,N. */
  seatWind(actor: number): Wind {
    return (((actor - this.oya) % 4 + 4) % 4) as Wind
  }

  applyEvent(ev: MjaiEvent): void {
    // Clear chankan window on any event other than the actual hora that
    // would consume it.
    if (ev.type !== 'kakan' && ev.type !== 'hora') {
      this.pendingChankanTile = null
      this.pendingChankanActor = null
    }
    // Clear rinshan window when a dahai happens (player's rinshan turn ends)
    // or any event other than the kan + immediate-tsumo flow.
    if (ev.type === 'dahai' || ev.type === 'hora') {
      // hora directly after rinshan tsumo counts as rinshan kaihou — let
      // hora handler peek this flag before we clear it on the next event.
    } else if (ev.type !== 'ankan' && ev.type !== 'kakan' && ev.type !== 'daiminkan' && ev.type !== 'tsumo' && ev.type !== 'dora') {
      this.pendingRinshanActor = null
    }
    switch (ev.type) {
      case 'start_kyoku':
        this.resetKyoku(ev)
        return
      case 'tsumo': {
        const a = ev.actor!
        const t = mjaiToTile(ev.pai!)
        if ((ev.pai as string).endsWith('r')) this.akaCount[a] += 1
        this.hands[a].push(t)
        this.hands[a].sort((x, y) => x - y)
        this.lastDrawn[a] = t
        // If this tsumo is a rinshan draw (after kan), flag it so the
        // subsequent dahai clears ippatsu for all players.
        if (this.pendingRinshanActor === a) this.kanRinshanPending = true
        this.tilesLeft -= 1
        this.currentPlayer = a
        this.turnCount += 1
        return
      }
      case 'dahai': {
        const a = ev.actor!
        const t = mjaiToTile(ev.pai!)
        const isAka = (ev.pai as string).endsWith('r')
        if (isAka && this.akaCount[a]! > 0) this.akaCount[a]! -= 1
        const idx = this.hands[a].indexOf(t)
        if (idx >= 0) this.hands[a].splice(idx, 1)
        this.lastDahai = t
        this.lastDahaiActor = a
        this.lastDahaiIsAka = isAka
        // If this dahai follows a kan+rinshan, clear everyone's ippatsu.
        if (this.kanRinshanPending) {
          this.ippatsuActive = [false, false, false, false]
          this.kanRinshanPending = false
        }
        this.pendingRinshanActor = null
        this.ownDahaiCount[a]! += 1
        this.discards[a].push(t)
        // Ippatsu closes for the discarder after their *own* discard
        // (the discard at riichi declaration is the window opener; the
        // NEXT own discard is what closes it). The riichi-declaration
        // discard is reach + dahai + reach_accepted; ippatsuActive is
        // set on reach_accepted (after that dahai), so this clear correctly
        // applies only to subsequent discards.
        if (this.ippatsuActive[a]) this.ippatsuActive[a] = false
        return
      }
      case 'chi':
      case 'pon': {
        const a = ev.actor!
        const called = mjaiToTile(ev.pai!)
        if ((ev.pai as string).endsWith('r')) this.akaCount[a] += 1
        const consumedTiles = (ev.consumed ?? []).map(s => mjaiToTile(s))
        for (const t of consumedTiles) {
          const idx = this.hands[a].indexOf(t)
          if (idx >= 0) this.hands[a].splice(idx, 1)
        }
        const meldTiles = [called, ...consumedTiles].sort((x, y) => x - y)
        this.melds[a].push({ type: ev.type as Meld['type'], tiles: meldTiles })
        this.isMenzen[a] = false
        // Check pao: if this pon completes 大三元 or 大四喜
        if (ev.type === 'pon' && this.lastDahaiActor != null) {
          this.checkPao(a, called, this.lastDahaiActor)
        }
        this.ippatsuActive = [false, false, false, false]
        this.anyCallMade = true
        if (this.lastDahaiActor != null) this.discards[this.lastDahaiActor].pop()
        this.lastDrawn[a] = null
        this.currentPlayer = a
        return
      }
      case 'daiminkan': {
        const a = ev.actor!
        const called = mjaiToTile(ev.pai!)
        if ((ev.pai as string).endsWith('r')) this.akaCount[a] += 1
        const consumedTiles = (ev.consumed ?? []).map(s => mjaiToTile(s))
        for (const t of consumedTiles) {
          const idx = this.hands[a].indexOf(t)
          if (idx >= 0) this.hands[a].splice(idx, 1)
        }
        const meldTiles = [called, ...consumedTiles].sort((x, y) => x - y)
        this.melds[a].push({ type: 'daiminkan', tiles: meldTiles })
        this.isMenzen[a] = false
        // Check pao: if this daiminkan completes 大三元 or 大四喜
        if (this.lastDahaiActor != null) {
          this.checkPao(a, called, this.lastDahaiActor)
        }
        this.pendingRinshanActor = a
        this.ippatsuActive = [false, false, false, false]
        this.anyCallMade = true
        if (this.lastDahaiActor != null) this.discards[this.lastDahaiActor].pop()
        this.currentPlayer = a
        return
      }
      case 'ankan': {
        const a = ev.actor!
        const consumedTiles = (ev.consumed ?? []).map(s => mjaiToTile(s))
        for (const t of consumedTiles) {
          const idx = this.hands[a].indexOf(t)
          if (idx >= 0) this.hands[a].splice(idx, 1)
        }
        this.melds[a].push({ type: 'ankan', tiles: consumedTiles })
        this.pendingRinshanActor = a
        this.ippatsuActive = [false, false, false, false]
        this.anyCallMade = true
        this.currentPlayer = a
        return
      }
      case 'kakan': {
        const a = ev.actor!
        const t = mjaiToTile(ev.pai!)
        const isAka = (ev.pai as string).endsWith('r')
        const idx = this.hands[a].indexOf(t)
        if (idx >= 0) this.hands[a].splice(idx, 1)
        const ponIdx = this.melds[a].findIndex(m => m.type === 'pon' && m.tiles[0] === t)
        if (ponIdx >= 0) {
          const old = this.melds[a][ponIdx]!
          this.melds[a][ponIdx] = { type: 'kakan', tiles: [...old.tiles, t] }
        }
        this.pendingChankanTile = t
        this.pendingChankanActor = a
        this.lastKakanIsAka = isAka
        this.pendingRinshanActor = a
        // Don't clear ippatsu here — kakan is not "complete" until the kaker
        // draws rinshan and discards. If someone chankans (rons on this kakan),
        // it happens before the call is finalized, so ippatsu stays active.
        // Ippatsu will be cleared naturally when the kaker discards (dahai).
        this.anyCallMade = true
        this.currentPlayer = a
        return
      }
      case 'reach':
        return
      case 'reach_accepted':
        if (ev.actor != null) {
          this.riichi[ev.actor] = true
          this.scores[ev.actor]! -= 1000
          this.kyotaku += 1
          // Ippatsu window opens for this player. It will close on their
          // own next discard or on any call by anyone (chi/pon/kan).
          this.ippatsuActive[ev.actor] = true
          // Daburii (W立直) is locked in here: valid iff the riichi
          // declaration was on the player's FIRST own discard AND no
          // chi/pon/kan has happened yet. The riichi-declaration dahai
          // has already fired before reach_accepted, so ownDahaiCount=1
          // is the daburii condition. Later calls cannot cancel daburii
          // for a player who has already qualified.
          if (this.ownDahaiCount[ev.actor]! === 1 && !this.anyCallMade) {
            this.daburii[ev.actor] = true
          }
        }
        return
      case 'dora':
        if (ev.dora_marker) this.doraMarkers.push(mjaiToTile(ev.dora_marker as string))
        return
      case 'hora':
        // The first hora in a kyoku claims all kyotaku on the table AND
        // the honba bonus from the loser. For double-ron (ダブロン), the
        // closer-to-discarder seat wins sticks + honba first; the second
        // winner gets only their own ronPayment. Clearing both here makes
        // the *next* hora in the same kyoku (if any) compute without the
        // already-consumed honba/kyotaku. Inter-kyoku resets happen on
        // start_kyoku from ev.honba/ev.kyotaku, so this is safe to clear.
        this.kyotaku = 0
        this.honba = 0
        return
      default:
        return
    }
  }

  /** Snapshot for the actor's winning-hand check. Win tile depends on the
   *  preceding event:
   *    - tsumo win: tile already in concealed (the preceding tsumo added it).
   *    - chankan (hora directly after a kakan, target == kakan actor):
   *      win tile is the kakan'd tile, not the previous dahai.
   *    - normal ron: win tile is lastDahai. */
  /** Check if a newly completed pon/daiminkan triggers pao (包牌).
   *  Called after the meld is added to this.melds[caller]. */
  checkPao(caller: number, calledTile: TileType, discardedBy: number): void {
    const melds = this.melds[caller]
    // 大三元: calledTile is a dragon (31-33), and caller has all 3
    if (calledTile >= 31 && calledTile <= 33) {
      const dragonTypes = new Set<number>()
      for (const m of melds) {
        if ((m.type === 'pon' || m.type === 'daiminkan' || m.type === 'kakan') && m.tiles[0]! >= 31 && m.tiles[0]! <= 33) {
          dragonTypes.add(m.tiles[0]!)
        }
      }
      if (dragonTypes.size === 3) {
        this.paoTarget[caller] = discardedBy
        return
      }
    }
    // 大四喜: calledTile is a wind (27-30), and caller has all 4
    if (calledTile >= 27 && calledTile <= 30) {
      const windTypes = new Set<number>()
      for (const m of melds) {
        if ((m.type === 'pon' || m.type === 'daiminkan' || m.type === 'kakan') && m.tiles[0]! >= 27 && m.tiles[0]! <= 30) {
          windTypes.add(m.tiles[0]!)
        }
      }
      if (windTypes.size === 4) {
        this.paoTarget[caller] = discardedBy
        return
      }
    }
  }

  winShape(actor: number, target: number, isTsumo: boolean): { concealed: TileType[]; winTile: TileType | null; isChankan: boolean } {
    const concealed = this.hands[actor].slice()
    if (isTsumo) {
      return { concealed, winTile: this.lastDrawn[actor], isChankan: false }
    }
    if (this.pendingChankanTile != null && this.pendingChankanActor === target) {
      const t = this.pendingChankanTile
      return { concealed: [...concealed, t].sort((x, y) => x - y), winTile: t, isChankan: true }
    }
    if (this.lastDahai == null) return { concealed, winTile: null, isChankan: false }
    return { concealed: [...concealed, this.lastDahai].sort((x, y) => x - y), winTile: this.lastDahai, isChankan: false }
  }

  /** Build a minimal PlayerState for yaku evaluation. */
  playerState(actor: number): PlayerState {
    return {
      hand: this.hands[actor].slice(),
      melds: this.melds[actor].map(m => ({ ...m })) as EngineMeld[],
      discards: [],
      riichi: this.riichi[actor]!,
      riichiTurn: 0,
      score: this.scores[actor]!,
      isMenzen: this.isMenzen[actor]!,
      kitaCount: 0,
      akaCount: this.akaCount[actor],
      daburii: this.daburii[actor]!,
    } as unknown as PlayerState
  }

  /** Synthesize a GameState rich enough for evaluateWin + delta calc. */
  syntheticState(actor: number): GameState {
    const players: PlayerState[] = []
    for (let i = 0; i < 4; i++) players.push(this.playerState(i))
    // Encode this.tilesLeft into a synthetic wall so remainingTiles(wall)
    // returns the expected count. wall.length = 14 + tilesLeft;
    // wallIndex = 0; rinshanIndex = wall.length - 1.
    const wallLen = 14 + Math.max(this.tilesLeft, 0)
    const fakeWall: TileType[] = new Array(wallLen).fill(0)
    // Chankan state: a hora event whose target == pendingChankanActor is
    // a robbing-the-kan. Synthesizing state.chankan lets evaluateWin set
    // ctx.isChankan = true (which awards chankan yaku, 1 han).
    const chankan = (this.pendingChankanTile != null && this.pendingChankanActor != null)
      ? { tile: this.pendingChankanTile, kaker: this.pendingChankanActor as Player }
      : null
    return {
      playerCount: 4,
      endRound: 8,
      wall: fakeWall,
      wallIndex: 0,
      rinshanIndex: wallLen - 1,
      doraMarkers: this.doraMarkers.slice(),
      players,
      currentPlayer: actor as Player,
      dealer: this.oya as Player,
      roundWind: this.bakaze,
      roundNumber: 1,
      honba: this.honba,
      kyotaku: this.kyotaku,
      phase: 'discard',
      // turnCount used for tenhou/chiihou first-turn detection.
      turnCount: this.turnCount,
      lastDiscard: this.lastDahai,
      lastDiscardPlayer: this.lastDahaiActor as Player | null,
      lastDrawnTile: this.lastDrawn[actor],
      ippatsu: this.ippatsuActive[actor] === true,
      // atRinshan: only true if THIS actor just drew a rinshan tile.
      atRinshan: this.pendingRinshanActor === actor,
      chankan,
      koyakuMode: false,
      paoTarget: this.paoTarget[actor] as Player | null,
    } as unknown as GameState
  }
}

/** Compute the per-player score deltas the engine would apply for this
 *  hora, mirroring applyTsumo / applyRon. Returns null if our engine
 *  refuses to score the hand (no yaku per our rules). */
function computeOurDeltas(
  tracker: GameTracker,
  actor: number,
  target: number,
  isTsumo: boolean,
  winTile: TileType,
  uraMarkers: TileType[] = [],
): { deltas: number[]; han: number; fu: number; yakuman: boolean; yakuNames: string[] } | null {
  const state = tracker.syntheticState(actor)
  // For riichi winners, fold uraDora markers into the regular doraMarkers
  // list so the engine's countDora picks them up. The engine has no
  // explicit ura-dora field yet (a known limitation); this stand-in works
  // because ura and regular dora score identically (1 han per copy).
  if (tracker.riichi[actor] && uraMarkers.length > 0) {
    ;(state as { doraMarkers: TileType[] }).doraMarkers = [
      ...state.doraMarkers,
      ...uraMarkers,
    ]
  }
  // If the winning tile itself is aka — i.e. the discard the winner is
  // ronning was aka, or the chankan'd tile is aka — the winner picks it
  // up at settlement and gets +1 aka han. Tracker.akaCount counts aka
  // already in hand/melds before settlement; bump it by 1 here so
  // countDora awards the extra han. Tsumo case is already handled by
  // the per-event tsumo handler in the tracker.
  if (!isTsumo) {
    const winTileIsAka = tracker.pendingChankanActor === target
      ? tracker.lastKakanIsAka
      : tracker.lastDahaiIsAka
    if (winTileIsAka) {
      const winnerState = state.players[actor] as { akaCount?: number }
      winnerState.akaCount = (winnerState.akaCount ?? 0) + 1
    }
  }
  const evalResult = evaluateWin(state, actor as Player, isTsumo, winTile)
  if (!evalResult.hasYaku) return null

  const deltas = [0, 0, 0, 0]
  const isDealerWin = actor === state.dealer

  // Pao (包牌): if the winner has an active pao target and this is a
  // yakuman win, the pao target pays for everyone.
  const pao = tracker.paoTarget[actor] != null && evalResult.isYakuman
    ? tracker.paoTarget[actor] : null

  if (isTsumo) {
    const honbaPay = HONBA_TSUMO * state.honba
    let totalCollected = 0
    for (let i = 0; i < 4; i++) {
      if (i === actor) continue
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
        // Pao target pays for everyone — accumulate total
        totalCollected += pay
      } else {
        deltas[i] -= pay
        totalCollected += pay
      }
    }
    if (pao != null) deltas[pao] -= totalCollected
    deltas[actor] += totalCollected + state.kyotaku * KYOTAKU_VALUE
  } else {
    const honbaPay = HONBA_RON * state.honba
    const totalFromLoser = evalResult.scoreResult.ronPayment + honbaPay
    // Pao for ron: pao target and discarder split responsibility.
    // Pao target pays basePayment/2 + honba, discarder pays basePayment/2.
    if (pao != null) {
      const halfBase = Math.floor(evalResult.scoreResult.ronPayment / 2)
      const loserPays = halfBase
      const paoPays = evalResult.scoreResult.ronPayment - halfBase + honbaPay
      deltas[pao] -= paoPays
      deltas[target] -= loserPays
    } else {
      deltas[target] -= totalFromLoser
    }
    deltas[actor] += totalFromLoser + state.kyotaku * KYOTAKU_VALUE
  }

  return {
    deltas,
    han: evalResult.totalHan,
    fu: evalResult.fu,
    yakuman: evalResult.isYakuman,
    yakuNames: evalResult.yakuList.map(y => y.name),
  }
}

// ── L2: per-event action-legality check ────────────────────────────

const L2_CHECKABLE = new Set(['dahai', 'chi', 'pon', 'daiminkan', 'ankan', 'kakan', 'reach', 'hora'])

/** Events for which we verify state transitions after applyAction.
 *  Excludes 'reach' (engine does riichi+discard in one step, tracker splits)
 *  and 'hora' (scoring already verified by L1.5+).  Kan actions skip hand
 *  content checks because the fake wall produces wrong rinshan tiles. */
const L2_STATE_EVENTS = new Set(['dahai', 'chi', 'pon', 'ankan', 'kakan', 'daiminkan'])

function verifyPostState(
  tracker: GameTracker,
  postEngine: GameState,
  ev: MjaiEvent,
  file: string,
  line: number,
): Failure | null {
  const actor = ev.actor ?? 0
  const issues: string[] = []

  switch (ev.type) {
    case 'dahai': {
      if (postEngine.phase !== 'respond') issues.push(`phase=${postEngine.phase}`)
      if (postEngine.lastDiscardPlayer !== actor) issues.push(`lastDiscardPlayer=${postEngine.lastDiscardPlayer}`)
      const eh = postEngine.players[actor].hand.length
      const th = tracker.hands[actor].length
      if (eh !== th) issues.push(`hand.len=${eh}!=${th}`)
      const ed = postEngine.players[actor].discards.length
      const td = tracker.discards[actor].length
      if (ed !== td) issues.push(`discards.len=${ed}!=${td}`)
      break
    }
    case 'chi':
    case 'pon': {
      if (postEngine.phase !== 'discard') issues.push(`phase=${postEngine.phase}`)
      if (postEngine.currentPlayer !== actor) issues.push(`currentPlayer=${postEngine.currentPlayer}`)
      const em = postEngine.players[actor].melds.length
      const tm = tracker.melds[actor].length
      if (em !== tm) issues.push(`melds=${em}!=${tm}`)
      const eh = postEngine.players[actor].hand.length
      const th = tracker.hands[actor].length
      if (eh !== th) issues.push(`hand.len=${eh}!=${th}`)
      // Called tile removed from discarder's pile
      const dlr = tracker.lastDahaiActor
      if (dlr != null) {
        const engineDlrDisc = postEngine.players[dlr].discards.length
        const trackerDlrDisc = tracker.discards[dlr].length
        if (engineDlrDisc !== trackerDlrDisc) issues.push(`discarder.discards=${engineDlrDisc}!=${trackerDlrDisc}`)
      }
      break
    }
    case 'ankan': {
      if (postEngine.currentPlayer !== actor) issues.push(`currentPlayer=${postEngine.currentPlayer}`)
      const em = postEngine.players[actor].melds.length
      const tm = tracker.melds[actor].length
      if (em !== tm) issues.push(`melds=${em}!=${tm}`)
      // Skip hand.len: fake wall rinshan draw makes engine hand differ
      break
    }
    case 'kakan': {
      if (postEngine.phase !== 'respond') issues.push(`phase=${postEngine.phase}`)
      if (postEngine.chankan == null) issues.push('chankan=null')
      break
    }
    case 'daiminkan': {
      if (postEngine.currentPlayer !== actor) issues.push(`currentPlayer=${postEngine.currentPlayer}`)
      const em = postEngine.players[actor].melds.length
      const tm = tracker.melds[actor].length
      if (em !== tm) issues.push(`melds=${em}!=${tm}`)
      break
    }
  }

  if (issues.length === 0) return null
  return {
    file, line,
    kyoku: tracker.currentKyoku,
    actor, isTsumo: ev.actor === ev.target, winTile: null,
    concealed: tracker.hands[actor].slice(),
    melds: tracker.melds[actor].map(m => ({ type: m.type, tiles: m.tiles.slice() })),
    reason: `L2-state(${ev.type}): ${issues.join('; ')}`,
  }
}

function inferPhase(ev: MjaiEvent): 'discard' | 'respond' {
  switch (ev.type) {
    case 'chi': case 'pon': case 'daiminkan':
      return 'respond'
    case 'hora':
      return ev.actor === ev.target ? 'discard' : 'respond'
    default: // dahai, ankan, kakan, reach
      return 'discard'
  }
}

function checkL2(tracker: GameTracker, ev: MjaiEvent): { failure: Failure | null; postEngine: GameState | null } {
  const phase = inferPhase(ev)
  const actor = ev.actor ?? 0
  const state = tracker.syntheticState(actor)

  // Override fields that syntheticState hardcodes for L1.5 scoring
  state.phase = phase
  state.turnCount = tracker.turnCount
  if (phase === 'discard') {
    state.currentPlayer = actor as Player
  } else {
    state.currentPlayer = tracker.currentPlayer as Player
  }
  // Populate real discards (syntheticState hardcodes [])
  for (let i = 0; i < 4; i++) {
    ;(state.players[i] as PlayerState).discards =
      tracker.discards[i].map(t => ({ tile: t, tsumogiri: false }))
  }
  // Chankan respond window: hora on a kakan'd tile
  if (ev.type === 'hora' && ev.actor !== ev.target && tracker.pendingChankanTile != null) {
    state.chankan = { tile: tracker.pendingChankanTile, kaker: tracker.pendingChankanActor as Player }
  }

  const validActions = getValidActions(state)
  // Normalize aka suffix: MJAI uses "5mr"/"5pr"/"5sr" but tileToMjai outputs
  // "5m"/"5p"/"5s".  Strip the trailing 'r' so mjaiReactionToAction can match.
  const stripAka = (s?: string) => s?.endsWith('r') ? s.slice(0, -1) : s
  const normalized = {
    type: ev.type,
    pai: stripAka(ev.pai as string | undefined),
    consumed: (ev.consumed as string[] | undefined)?.map(stripAka),
    actor: ev.actor,
  }
  const action = mjaiReactionToAction(normalized as { type: string; pai?: string; consumed?: string[]; actor?: number }, validActions)
  if (action === null) {
    return {
      failure: {
        file: '',  line: 0,
        kyoku: tracker.currentKyoku, actor, isTsumo: ev.actor === ev.target, winTile: null,
        concealed: tracker.hands[actor].slice(),
        melds: tracker.melds[actor].map(m => ({ type: m.type, tiles: m.tiles.slice() })),
        reason: `L2: ${ev.type}(${ev.pai ?? ''}) not in getValidActions (phase=${phase} valid=${validActions.length} actor=${actor} target=${ev.target ?? '-'})`,
      },
      postEngine: null,
    }
  }

  // Apply the action and return post-engine state for transition verification
  try {
    const postEngine = applyAction(state, action)
    return { failure: null, postEngine }
  } catch (e) {
    return {
      failure: {
        file: '',  line: 0,
        kyoku: tracker.currentKyoku, actor, isTsumo: ev.actor === ev.target, winTile: null,
        concealed: tracker.hands[actor].slice(),
        melds: tracker.melds[actor].map(m => ({ type: m.type, tiles: m.tiles.slice() })),
        reason: `L2: applyAction threw on ${ev.type}: ${(e as Error).message}`,
      },
      postEngine: null,
    }
  }
}

function replayFile(file: string, mode?: string): { games: number; horas: number; failures: Failure[] } {
  // Some yearly corpora ship raw mjson, others are gzip-compressed. Sniff
  // by gzip magic bytes (`1f 8b`).
  const buf = fs.readFileSync(file)
  const content = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b
    ? zlib.gunzipSync(buf).toString('utf8')
    : buf.toString('utf8')
  const lines = content.split('\n').filter(l => l.length > 0)
  const failures: Failure[] = []
  let games = 0
  let horas = 0
  const tracker = new GameTracker()

  for (let i = 0; i < lines.length; i++) {
    let ev: MjaiEvent
    try {
      ev = JSON.parse(lines[i]!)
    } catch {
      continue
    }
    if (ev.type === 'start_game') {
      games += 1
    }
    if (ev.type === 'hora') {
      horas += 1
      const actor = ev.actor!
      const target = ev.target!
      const isTsumo = actor === target
      const { concealed, winTile, isChankan } = tracker.winShape(actor, target, isTsumo)
      // L1: shape decomposes as a winning hand
      if (!isWinningHand(concealed)) {
        failures.push({
          file,
          line: i + 1,
          kyoku: tracker.currentKyoku,
          actor,
          isTsumo,
          winTile,
          concealed,
          melds: tracker.melds[actor].map(m => ({ type: m.type, tiles: m.tiles.slice() })),
          reason: `L1: isWinningHand returned false (concealed.length=${concealed.length})`,
        })
      } else if (winTile != null) {
        // L1.5: hand yields at least one yaku. Real hora must have a yaku
        // (tenhou enforces this); zero yaku means our evaluateYaku missed
        // something. Skip if winTile is unknown.
        const isRinshan = isTsumo && tracker.pendingRinshanActor === actor
        // After a rinshan tsumo, the tile came from the dead wall, not the
        // live wall, so haitei does not apply. Standard haitei = tsumo on
        // the very last live-wall tile, i.e. tracker.tilesLeft is 0 right
        // after the preceding tsumo event decremented it.
        const isHaitei = isTsumo && !isRinshan && tracker.tilesLeft === 0
        // Houtei = ron on a discard made after the wall ran out.
        const isHoutei = !isTsumo && !isChankan && tracker.tilesLeft === 0
        // Build hand WITHOUT the winning tile for the yaku context — yaku
        // helpers re-add it via ctx.winningTile.
        const handWithoutWin = concealed.slice()
        const wtIdx = handWithoutWin.indexOf(winTile)
        if (wtIdx >= 0) handWithoutWin.splice(wtIdx, 1)
        const ctx = {
          hand: handWithoutWin,
          melds: tracker.melds[actor].map(m => ({ ...m })),
          player: tracker.playerState(actor),
          roundWind: tracker.bakaze,
          seatWind: tracker.seatWind(actor),
          isTsumo,
          isRiichi: tracker.riichi[actor]!,
          isIppatsu: false,
          isRinshan,
          isChankan,
          isHaitei,
          isHoutei,
          isFirstTurn: false,
          winningTile: winTile,
        }
        try {
          const yakuResult = evaluateYaku(ctx as never)
          if (yakuResult.totalHan === 0 && yakuResult.yaku.length === 0) {
            failures.push({
              file,
              line: i + 1,
              kyoku: tracker.currentKyoku,
              actor,
              isTsumo,
              winTile,
              concealed,
              melds: tracker.melds[actor].map(m => ({ type: m.type, tiles: m.tiles.slice() })),
              reason: `L1.5: evaluateYaku returned 0 yaku for a real hora (isRiichi=${ctx.isRiichi} isChankan=${isChankan} isRinshan=${isRinshan} isMenzen=${tracker.isMenzen[actor]})`,
            })
          } else {
            // L1.5+ : compare engine-computed deltas against mjai-recorded deltas.
            // mjai includes aka/ura/situational yaku that our tracker may miss,
            // so a mismatch isn't always our bug — but the patterns help.
            const expected = (ev.deltas as number[]) ?? null
            if (expected) {
              const ura = ((ev.ura_markers as string[]) ?? []).map(s => mjaiToTile(s))
              const our = computeOurDeltas(tracker, actor, target, isTsumo, winTile, ura)
              if (our) {
                // Permissible delta gap from aka-dora the engine doesn't track:
                // each aka in the winner's tiles adds 1 han, which shifts the
                // payment by a fu-and-han-dependent step. We can't reverse this
                // exactly without re-scoring, but we can tag the failure.
                const match = expected.length === our.deltas.length &&
                  expected.every((v, i) => v === our.deltas[i])
                if (!match) {
                  failures.push({
                    file,
                    line: i + 1,
                    kyoku: tracker.currentKyoku,
                    actor,
                    isTsumo,
                    winTile,
                    concealed,
                    melds: tracker.melds[actor].map(m => ({ type: m.type, tiles: m.tiles.slice() })),
                    reason: `L1.5+: delta mismatch (han=${our.han} fu=${our.fu} yakuman=${our.yakuman} aka=${tracker.akaCount[actor]} yaku=[${our.yakuNames.join(',')}])`,
                    expected,
                    computed: our.deltas,
                    han: our.han,
                    fu: our.fu,
                    yakuNames: our.yakuNames,
                    akaCount: tracker.akaCount[actor],
                  })
                }
              }
            }
          }
        } catch (e) {
          failures.push({
            file,
            line: i + 1,
            kyoku: tracker.currentKyoku,
            actor,
            isTsumo,
            winTile,
            concealed,
            melds: tracker.melds[actor].map(m => ({ type: m.type, tiles: m.tiles.slice() })),
            reason: `L1.5: evaluateYaku threw: ${(e as Error).message}`,
          })
        }
      }
    }
    // L2: check that the engine would offer this event's action
    let l2PostEngine: GameState | null = null
    if (mode === 'L2' && L2_CHECKABLE.has(ev.type)) {
      const result = checkL2(tracker, ev)
      if (result.failure) {
        result.failure.file = file
        result.failure.line = i + 1
        failures.push(result.failure)
      }
      l2PostEngine = result.postEngine
    }
    tracker.applyEvent(ev)
    // L2: verify state transition matches tracker
    if (l2PostEngine && L2_STATE_EVENTS.has(ev.type)) {
      const postFail = verifyPostState(tracker, l2PostEngine, ev, file, i + 1)
      if (postFail) failures.push(postFail)
    }
  }
  return { games, horas, failures }
}

function* iterateLogs(p: string): Generator<string> {
  const st = fs.statSync(p)
  if (st.isFile()) {
    if (p.endsWith('.mjson')) yield p
    return
  }
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(p)) {
      yield* iterateLogs(path.join(p, name))
    }
  }
}

async function main() {
  const rawArgs = process.argv.slice(2)
  if (rawArgs.length === 0) {
    process.stderr.write('usage: replay-mjai.ts [--mode=L2] <path>...\n')
    process.exit(1)
  }
  const mode = rawArgs.find(a => a.startsWith('--mode='))?.slice(7)
  const args = rawArgs.filter(a => !a.startsWith('--'))
  if (args.length === 0) {
    process.stderr.write('usage: replay-mjai.ts [--mode=L2] <path>...\n')
    process.exit(1)
  }

  const start = Date.now()
  let totalFiles = 0
  let totalGames = 0
  let totalHoras = 0
  let totalFailures = 0
  const failedFiles = new Set<string>()

  for (const root of args) {
    for (const file of iterateLogs(root)) {
      totalFiles += 1
      try {
        const r = replayFile(file, mode)
        totalGames += r.games
        totalHoras += r.horas
        totalFailures += r.failures.length
        if (r.failures.length > 0) failedFiles.add(file)
        for (const f of r.failures) {
          process.stderr.write(JSON.stringify(f) + '\n')
        }
        if (totalFiles % 1000 === 0) {
          const elapsed = (Date.now() - start) / 1000
          process.stdout.write(
            `[${elapsed.toFixed(1)}s] files=${totalFiles} games=${totalGames} ` +
              `horas=${totalHoras} failures=${totalFailures}\n`,
          )
        }
      } catch (e) {
        process.stderr.write(`ERROR reading ${file}: ${(e as Error).message}\n`)
      }
    }
  }

  const elapsed = (Date.now() - start) / 1000
  process.stdout.write(
    `\n=== summary${mode ? ` (mode=${mode})` : ''} ===\n` +
      `files       : ${totalFiles}\n` +
      `games       : ${totalGames}\n` +
      `hora events : ${totalHoras}\n` +
      `failures    : ${totalFailures}\n` +
      `files w/fail: ${failedFiles.size}\n` +
      `elapsed     : ${elapsed.toFixed(1)}s\n`,
  )
}

main()
