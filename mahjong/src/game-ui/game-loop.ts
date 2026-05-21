/**
 * GameLoop — orchestrates a game between multiple SeatAgents.
 *
 * Each seat has an agent (human or AI). The loop advances the engine state,
 * asks the appropriate agent(s) for decisions, resolves priorities, and
 * emits state updates for the UI.
 *
 * Design goals:
 * - Human agent returns decisions asynchronously (waits for UI input)
 * - AI agent returns decisions synchronously (wrapped in resolved Promise)
 * - Respond phase collects all agents' intentions, then resolves priority
 * - Decoupled from React — the UI subscribes to state changes via callback
 */

import type { Action, GameState, Player, TileType } from '../game/types'
import { ActionKind } from '../game/types'
import { applyAction, createGame, getValidActions } from '../game/engine'
import { isWinningHand } from '../game/hand-analysis'
import { chooseAction } from '../ai/ai-controller'
import { debugLog } from './DebugPanel'

// ---------------------------------------------------------------------------
// SeatAgent interface
// ---------------------------------------------------------------------------

export interface RespondOptions {
  /** Actions available to this specific seat in the current respond phase. */
  actions: Action[]
  /** The tile that was discarded (or kakan'd). */
  tile: TileType
  /** Who discarded it. */
  from: Player
}

export interface DiscardOptions {
  /** All valid actions for this seat (Discard[], Riichi[], Tsumo, Ankan, Kakan, Kyushukyuhai). */
  actions: Action[]
}

export interface SeatAgent {
  /** Called when another player discards and this seat can respond. */
  respond(state: GameState, opts: RespondOptions): Promise<Action>
  /** Called when it's this seat's turn to discard (or declare tsumo/kan/riichi). */
  discard(state: GameState, opts: DiscardOptions): Promise<Action>
}

// ---------------------------------------------------------------------------
// Scripted Agent — follows a predefined action sequence
// ---------------------------------------------------------------------------

export class ScriptedAgent implements SeatAgent {
  private script: Action[]
  private index = 0

  constructor(script: Action[]) {
    this.script = script
  }

  respond(_state: GameState, opts: RespondOptions): Promise<Action> {
    // If script has a next action that matches available options, use it
    if (this.index < this.script.length) {
      const next = this.script[this.index]!
      if (opts.actions.some(a => a.kind === next.kind)) {
        this.index++
        return Promise.resolve(next)
      }
    }
    // Default: pass
    return Promise.resolve({ kind: ActionKind.Pass })
  }

  discard(state: GameState, opts: DiscardOptions): Promise<Action> {
    // If script has a next action, use it
    if (this.index < this.script.length) {
      const next = this.script[this.index]!
      if (opts.actions.some(a => a.kind === next.kind && ('tile' in a && 'tile' in next ? (a as {tile:number}).tile === (next as {tile:number}).tile : true))) {
        this.index++
        return Promise.resolve(next)
      }
    }
    // Default: discard first available
    const discard = opts.actions.find(a => a.kind === ActionKind.Discard)
    return Promise.resolve(discard ?? { kind: ActionKind.Pass })
  }
}

// ---------------------------------------------------------------------------
// AI Agent
// ---------------------------------------------------------------------------

export class AiAgent implements SeatAgent {
  constructor(private seat: Player, private difficulty: number = 0) {}

  respond(_state: GameState, opts: RespondOptions): Promise<Action> {
    // Use the same logic as chooseAction for this seat
    const action = chooseAction(_state, opts.actions, this.difficulty, this.seat)
    return Promise.resolve(action)
  }

  discard(state: GameState, opts: DiscardOptions): Promise<Action> {
    const action = chooseAction(state, opts.actions, this.difficulty, this.seat)
    return Promise.resolve(action)
  }
}

// ---------------------------------------------------------------------------
// Human Agent — resolves when UI calls the provided callbacks
// ---------------------------------------------------------------------------

export type HumanPendingDecision =
  | { phase: 'respond'; actions: Action[]; resolve: (a: Action) => void }
  | { phase: 'discard'; actions: Action[]; resolve: (a: Action) => void }

export class HumanAgent implements SeatAgent {
  /** Set by the game loop; the UI reads this to know what to show. */
  onPending: ((pending: HumanPendingDecision | null) => void) | null = null

  respond(_state: GameState, opts: RespondOptions): Promise<Action> {
    return new Promise(resolve => {
      this.onPending?.({ phase: 'respond', actions: opts.actions, resolve })
    })
  }

  discard(_state: GameState, opts: DiscardOptions): Promise<Action> {
    return new Promise(resolve => {
      this.onPending?.({ phase: 'discard', actions: opts.actions, resolve })
    })
  }
}

// ---------------------------------------------------------------------------
// GameLoop
// ---------------------------------------------------------------------------

export interface GameLoopConfig {
  playerCount: 3 | 4
  endRound: 4 | 8
  agents: SeatAgent[]
  /** Called whenever state changes — UI subscribes here. */
  onStateChange: (state: GameState) => void
  /** Delay (ms) between AI actions for visual pacing. */
  aiDelay?: number
  /** Fixed hands for scenario testing. */
  fixedHands?: TileType[][]
  /** Aka tiles per player for scenario testing. */
  fixedAka?: TileType[][]
  /** Fixed wall for scenario testing. */
  fixedWall?: TileType[]
  /** Starting dealer for scenario testing. */
  startDealer?: 0 | 1 | 2 | 3
}

export class GameLoop {
  private state: GameState
  private agents: SeatAgent[]
  private onStateChange: (state: GameState) => void
  private aiDelay: number
  private running = false
  private aborted = false

  constructor(config: GameLoopConfig) {
    this.state = createGame({
      playerCount: config.playerCount,
      endRound: config.endRound,
      fixedHands: config.fixedHands,
      fixedAka: config.fixedAka,
      fixedWall: config.fixedWall,
      startDealer: config.startDealer,
    })
    this.agents = config.agents
    this.onStateChange = config.onStateChange
    this.aiDelay = config.aiDelay ?? 300
  }

  start() {
    this.running = true
    this.aborted = false
    this.onStateChange(this.state)
    this.tick()
  }

  stop() {
    this.aborted = true
    this.running = false
  }

  private emit() {
    this.onStateChange(this.state)
  }

  private async tick() {
    if (this.aborted) return

    const s = this.state
    const phase = s.phase
    debugLog(`tick: phase=${phase} currentPlayer=${s.currentPlayer}`)

    if (phase === 'game_over' || phase === 'tsumo_win' || phase === 'ron_win' || phase === 'ryukyoku') {
      debugLog(`game ended: ${phase}`)
      this.running = false
      return
    }

    if (phase === 'draw') {
      this.advance({ kind: ActionKind.Pass })
      return
    }

    if (phase === 'discard') {
      const actions = getValidActions(s)
      const agent = this.agents[s.currentPlayer]!
      const isAi = agent instanceof AiAgent
      debugLog(`discard: P${s.currentPlayer} ${isAi ? 'AI' : 'HUMAN'} actions=${actions.map(a=>a.kind).join(',')}`)
      if (isAi) await this.delay()
      const action = await agent.discard(s, { actions })
      if (this.aborted) return
      debugLog(`discard: P${s.currentPlayer} chose ${action.kind}${'tile' in action ? ' tile=' + (action as {tile:number}).tile : ''}`)
      this.advance(action)
      return
    }

    if (phase === 'respond') {
      await this.resolveRespond()
      return
    }

    if (phase === 'kita_declare') {
      // Simplified: auto-pass for now
      this.advance({ kind: ActionKind.Pass })
      return
    }
  }

  /**
   * Respond phase: collect each eligible seat's intention in parallel,
   * then apply priority (Ron > Pon/Daiminkan > Chi > Pass).
   */
  private async resolveRespond() {
    const s = this.state
    const discardedBy = s.lastDiscardPlayer
    if (discardedBy == null) { this.advance({ kind: ActionKind.Pass }); return }

    const discarded = s.lastDiscard!
    const playerCount = s.playerCount

    // Determine per-seat available actions
    const seatActions = this.getPerSeatRespondActions(s, discardedBy, discarded)
    debugLog(`respond: discardedBy=P${discardedBy} tile=${discarded} seats=${seatActions.map(e => e ? `P${e.seat}:[${e.actions.map(a=>a.kind)}]` : 'null').join(' ')}`)

    // Collect decisions from all seats in parallel
    const decisions = await Promise.all(
      seatActions.map(async (entry) => {
        if (!entry) return null
        const { seat, actions } = entry
        const agent = this.agents[seat]!
        const isAi = agent instanceof AiAgent
        if (isAi) await this.delay()
        const action = await agent.respond(s, { actions, tile: discarded, from: discardedBy })
        debugLog(`respond: P${seat} chose ${action.kind}`)
        return { seat, action }
      })
    )
    if (this.aborted) return

    // Priority resolution: Ron > Pon/Daiminkan > Chi
    const ron = decisions.find(d => d?.action.kind === ActionKind.Ron)
    if (ron) { this.advance(ron.action); return }

    const ponOrKan = decisions.find(d =>
      d?.action.kind === ActionKind.Pon || d?.action.kind === ActionKind.Daiminkan)
    if (ponOrKan) { this.advance(ponOrKan.action); return }

    const chi = decisions.find(d => d?.action.kind === ActionKind.Chi)
    if (chi) { this.advance(chi.action); return }

    this.advance({ kind: ActionKind.Pass })
  }

  /**
   * Compute which actions each seat can take in the current respond phase.
   * Returns an array of { seat, actions } for seats that have options beyond Pass.
   */
  private getPerSeatRespondActions(
    s: GameState, discardedBy: Player, discarded: TileType
  ): ({ seat: Player; actions: Action[] } | null)[] {
    const results: ({ seat: Player; actions: Action[] } | null)[] = []
    const playerCount = s.playerCount

    for (let offset = 1; offset < playerCount; offset++) {
      const seat = ((discardedBy as number + offset) % playerCount) as Player
      const player = s.players[seat]
      const actions: Action[] = []

      // Ron check
      if (!player.riichi || true) { // riichi players can still ron
        if (isWinningHand([...player.hand, discarded])) {
          actions.push({ kind: ActionKind.Ron, called: discarded })
        }
      }

      // Skip calls if in riichi
      if (!player.riichi) {
        // Daiminkan
        if (player.hand.filter(t => t === discarded).length === 3) {
          actions.push({ kind: ActionKind.Daiminkan, called: discarded })
        }

        // Pon
        if (player.hand.filter(t => t === discarded).length >= 2) {
          actions.push({ kind: ActionKind.Pon, called: discarded })
        }

        // Chi (next seat only, yonma only)
        if (offset === 1 && playerCount === 4) {
          const chiActions = this.getChiOptions(player.hand, discarded, player.akaInHand)
          actions.push(...chiActions)
        }
      }

      if (actions.length > 0) {
        actions.push({ kind: ActionKind.Pass })
        results.push({ seat, actions })
      } else {
        results.push(null)
      }
    }
    return results
  }

  private getChiOptions(hand: readonly TileType[], called: TileType, akaInHand?: TileType[]): Action[] {
    if (called >= 27) return [] // honors can't chi
    const suit = Math.floor(called / 9)
    const rank = called % 9
    const suitTiles = hand.filter(t => Math.floor(t / 9) === suit && t !== called)
    const actions: Action[] = []
    const akaSet = new Set(akaInHand ?? [])
    const AKA = new Set([4, 13, 22])

    // Check all possible pairs that form a sequence with `called`
    for (let startRank = Math.max(0, rank - 2); startRank <= Math.min(6, rank); startRank++) {
      const needed = [0, 1, 2].map(i => suit * 9 + startRank + i).filter(t => t !== called)
      if (needed.length === 2 && needed.every(t => suitTiles.includes(t))) {
        const hasAkaChoice = needed.some(t =>
          AKA.has(t) && akaSet.has(t) && hand.filter(x => x === t).length >= 2
        )
        if (hasAkaChoice) {
          actions.push({ kind: ActionKind.Chi, tiles: needed as [TileType, TileType], called, useAka: false })
          actions.push({ kind: ActionKind.Chi, tiles: needed as [TileType, TileType], called, useAka: true })
        } else {
          actions.push({ kind: ActionKind.Chi, tiles: needed as [TileType, TileType], called })
        }
      }
    }
    return actions
  }

  private advance(action: Action) {
    this.state = applyAction(this.state, action)
    this.emit()
    // Schedule next tick
    setTimeout(() => this.tick(), 0)
  }

  private delay(): Promise<void> {
    return new Promise(r => setTimeout(r, this.aiDelay))
  }
}
