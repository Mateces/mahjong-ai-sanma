import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from 'node:child_process'
import { writeSync, readSync, appendFileSync } from 'node:fs'
import type { Action, GameState, Player } from '../../game/types'
import { MjaiEmitter, mjaiReactionToAction } from '../mjai/emit'
import type { MjaiEvent } from '../mjai/types'
import type { Strategy } from '../strategy'

interface MortalBridgeOptions {
  checkpoint: string
  pythonExe?: string
  serverScript?: string
  device?: string
  debug?: boolean
}

/**
 * MortalBridge: routes one seat's decisions to a persistent Python subprocess
 * running our trained DQN model behind libriichi's MJAI Bot.
 *
 * Lifecycle:
 *     - First decide() call spawns the subprocess and performs the setup
 *       handshake (player_id, checkpoint path).
 *     - Each subsequent action in the game (any seat) must be reported via
 *       observe(before, action, after). The bridge translates the change
 *       into MJAI events and feeds them to the subprocess.
 *     - decide() flushes any pending observed events, then waits on the
 *       subprocess for its action when it sees the bot's turn.
 *
 * The Python subprocess speaks line-delimited JSON over stdin/stdout. Each
 * event we send produces exactly one response line ("none" if no action).
 */
export class MortalBridge implements Strategy {
  readonly name = 'mortal'
  private child: ChildProcessWithoutNullStreams | null = null
  private stdinFd = -1
  private stdoutFd = -1
  private stdoutBuf = ''
  private playerId: Player
  private emitter = new MjaiEmitter()
  private opts: MortalBridgeOptions
  /** Events observed since last decide() that haven't been forwarded yet. */
  private pendingEvents: MjaiEvent[] = []
  private pendingReaction: { type: string; pai?: string; consumed?: string[] } | null = null
  /** Per-decide() wall-time samples in ms, only collected when MORTAL_TIMING=1. */
  private decideTimings: number[] = []

  constructor(playerId: Player, opts: MortalBridgeOptions) {
    this.playerId = playerId
    this.opts = opts
  }

  private ensureStarted(): void {
    if (this.child) return
    const python = this.opts.pythonExe ?? 'python3'
    const script = this.opts.serverScript ?? 'scripts/mortal_bot_server.py'
    // -u: unbuffered I/O; otherwise Python may buffer stdout in non-tty mode
    // and our readSync() blocks indefinitely waiting for a flush.
    // stderr 'inherit' so any python traceback surfaces in the verify log.
    const child = spawn(python, ['-u', script], {
      stdio: ['pipe', 'pipe', 'inherit'],
    })
    this.child = child
    // Node doesn't expose subprocess pipe fds publicly. The Socket's
    // internal `_handle.fd` is the only path we have. If that fails on this
    // platform we fall back to letting the stream buffer + sync via spin.
    const stdinHandle = (child.stdin as unknown as { _handle?: { fd?: number } })._handle
    const stdoutHandle = (child.stdout as unknown as { _handle?: { fd?: number } })._handle
    if (stdinHandle?.fd == null || stdoutHandle?.fd == null) {
      throw new Error(
        `mortal-bridge: subprocess stdio fds not exposed by Node. ` +
          `stdin._handle.fd=${stdinHandle?.fd} stdout._handle.fd=${stdoutHandle?.fd}`,
      )
    }
    this.stdinFd = stdinHandle.fd
    this.stdoutFd = stdoutHandle.fd
    // Drop the streams' default reading; we use fs.readSync manually.
    child.stdout.pause()

    this.writeLine({
      type: 'setup',
      player_id: this.playerId,
      checkpoint: this.opts.checkpoint,
      device: this.opts.device ?? 'cpu',
    })
    const ready = this.readJsonLine()
    if (ready.type !== 'ready') {
      throw new Error(`mortal-bridge: setup failed: ${JSON.stringify(ready)}`)
    }
  }

  /** Tell the Python server to rebuild its libriichi Bot with a different
   *  player_id. The model engine (loaded weights) is preserved, so this is
   *  much cheaper than killing/respawning the subprocess. Used when the
   *  verifier shuffles seats between hanchans: this strategy was constructed
   *  for one seat but is now sitting at another. Must be called BEFORE any
   *  events for the new hanchan are drained — drain order is: re_setup →
   *  start_game/start_kyoku/... → first reaction. */
  private rePlayerId(newPlayerId: Player): void {
    this.writeLine({ type: 're_setup', player_id: newPlayerId })
    const ready = this.readJsonLine()
    if (ready.type !== 'ready') {
      throw new Error(`mortal-bridge: re_setup failed: ${JSON.stringify(ready)}`)
    }
    this.playerId = newPlayerId
  }

  /** Forward MJAI events from the game loop. Preferred over `observe`:
   *  events come straight from the engine instead of reconstructed from
   *  state diffs, eliminating an entire class of desync bugs. */
  feedEvents(events: readonly MjaiEvent[]): void {
    if (!events.length) return
    this.pendingEvents.push(...events)
  }

  /** Legacy state-diff path. Kept for callers that haven't switched to
   *  the engine's `applyActionWithEvents` yet — the new path is
   *  `feedEvents`. */
  observe(before: GameState, action: Action, after: GameState): void {
    if (before.playerCount !== 4) return // sanma unsupported
    const events = this.emitter.observeAction(before, action, after)
    this.pendingEvents.push(...events)
  }

  /** Strategy.decide entrypoint. Flushes pending events and waits for the
   *  subprocess's action.
   *
   *  Failure policy: when the subprocess dies (libriichi panic, OOM, etc.),
   *  we re-throw and let the verifier abort the run. Previously we silently
   *  fell back to a default "pass / first-discard" action, which turned a
   *  crashed mortal seat into an effectively-passive player and contaminated
   *  aggregate stats without warning. A loud stop is strictly better:
   *  partial-run results in this case were never trustworthy. */
  decide(state: GameState, actions: Action[], asPlayer: Player): Action {
    if (state.playerCount !== 4) return actions[0]!
    // Seat reassignment (SHUFFLE_SEATS): when this strategy plays at a
    // different engine seat than its construct-time playerId, the libriichi
    // Bot inside the Python server is keyed to the wrong player_id and will
    // ignore events meant for "us". Sync the seat before we touch the
    // subprocess. No-op when seats aren't shuffled.
    if (asPlayer !== this.playerId) {
      if (this.child) {
        // Subprocess running: send re_setup so the server can rebuild Bot
        // with the new player_id while keeping the loaded model engine.
        this.rePlayerId(asPlayer)
      } else {
        // Subprocess not started yet — let ensureStarted() use the new id.
        this.playerId = asPlayer
      }
    }
    const timing = process.env.MORTAL_TIMING === '1'
    const t0 = timing ? performance.now() : 0
    try {
      return this.decideViaBot(actions)
    } catch (e) {
      // Dump the seat's hand state so the operator can reproduce the desync
      // by hand. The decideViaBot throw only knows the bot's reaction and
      // the kind list; the actual hand+melds+lastDrawnTile lives in state.
      const player = state.players[this.playerId]
      const dump = {
        playerId: this.playerId,
        asPlayer,
        phase: state.phase,
        currentPlayer: state.currentPlayer,
        hand: player?.hand ?? [],
        melds: player?.melds ?? [],
        riichi: player?.riichi ?? false,
        isMenzen: player?.isMenzen ?? null,
        lastDrawnTile: state.lastDrawnTile,
        lastDiscard: state.lastDiscard,
        lastDiscardPlayer: state.lastDiscardPlayer,
        roundWind: state.roundWind,
        kyoku: state.kyoku,
        honba: state.honba,
        actionsKinds: actions.map(a => a.kind),
      }
      process.stderr.write(
        `mortal-bridge[P${this.playerId}]: subprocess died (${(e as Error).message})\n` +
          `mortal-bridge[P${this.playerId}] state dump: ${JSON.stringify(dump)}\n` +
          `aborting run rather than degrading silently\n`,
      )
      this.close()
      throw e
    } finally {
      if (timing) this.decideTimings.push(performance.now() - t0)
    }
  }

  /** Print a one-line summary of decide() latency. Called from reset()
   *  between hanchans and from close() at end of run. No-op when no
   *  samples were collected. */
  printTimingSummary(label: string): void {
    if (this.decideTimings.length === 0) return
    const s = [...this.decideTimings].sort((a, b) => a - b)
    const pct = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))]!
    const sum = s.reduce((a, b) => a + b, 0)
    process.stderr.write(
      `mortal-bridge[${label} P${this.playerId}]: ` +
        `n=${s.length} ` +
        `p50=${pct(0.5).toFixed(1)}ms ` +
        `p95=${pct(0.95).toFixed(1)}ms ` +
        `max=${s[s.length - 1]!.toFixed(1)}ms ` +
        `mean=${(sum / s.length).toFixed(1)}ms ` +
        `total=${(sum / 1000).toFixed(1)}s\n`,
    )
    this.decideTimings = []
  }

  private decideViaBot(actions: Action[]): Action {
    this.ensureStarted()

    // chooseRespondAction polls each potential responder in three phases
    // (Ron → Pon/Daiminkan → Chi) with a *restricted* action set per phase.
    // The bot however sees the dahai event exactly once and returns its
    // single preferred call. If that preference is "chi" but we currently
    // ask "do you want to pon?", we must NOT raise — we should pass on
    // pon and reuse the cached chi reply when the chi phase asks. We
    // cache the bot's reply across same-respond-cycle decide() calls via
    // `pendingReaction`; it's refreshed whenever new events drain in.

    // 1) Drain any queued events; each produces exactly one bot response.
    const drainedCount = this.pendingEvents.length
    let lastReaction: { type: string; pai?: string; consumed?: string[] } | null = null
    for (const ev of this.pendingEvents) {
      this.writeLine(ev)
      const resp = this.readJsonLine()
      if (resp.type !== 'none') {
        lastReaction = resp
      }
    }
    this.pendingEvents = []

    // 2) Choose which reaction to consider.
    // - If we just drained events, that is the bot's authoritative reply
    //   for this turn; overwrite any stale cached reaction.
    // - If we drained nothing (later phases of the same respond cycle),
    //   keep using whatever we cached from the first decide() this cycle.
    if (drainedCount > 0) {
      this.pendingReaction = lastReaction
    }
    const reaction = this.pendingReaction

    // 3) Interpret reaction == null.
    // The bot replied "none" to every event — i.e. no call/declaration.
    // In any respond phase (Pass legal) that's the bot saying "I pass".
    // In a required-decision phase (no Pass) it's a real desync — abort.
    if (!reaction) {
      const passAction = actions.find(a => a.kind === 'pass')
      if (passAction) return passAction
      throw new Error(
        `mortal-bridge[P${this.playerId}]: bot returned "none" to all ` +
          `${drainedCount} events, but Pass is not in the legal action set ` +
          `(actions=${JSON.stringify(actions.map(a => a.kind))}) — likely ` +
          `desync: the bot's turn event was not delivered or arrived out of order`,
      )
    }

    // 4) Try to map the bot's preferred reaction to a currently-legal action.
    const mapped = mjaiReactionToAction(reaction, actions)
    if (mapped) {
      this.pendingReaction = null // consumed
      return mapped
    }

    // 5) Reaction doesn't match this phase's restricted action set
    //    (e.g. bot wants Chi while we're asking Pon). Pass in this phase
    //    and keep the cached reaction so a later phase can use it.
    const passAction = actions.find(a => a.kind === 'pass')
    if (passAction) return passAction

    // 6) Can't pass and the reaction is wrong shape for the legal set:
    //    model hallucination (e.g. wants to discard a tile not in hand).
    //    Log warning and fall back to the first legal action rather than crash.
    const fallback = actions[0]!
    process.stderr.write(
      `mortal-bridge[P${this.playerId}] WARNING: model returned illegal ` +
        `action, falling back to ${JSON.stringify(fallback.kind)}. ` +
        `reaction=${JSON.stringify(reaction)} ` +
        `legal_actions=${JSON.stringify(actions.map(a => a.kind))}\n`,
    )
    this.pendingReaction = null
    return fallback
  }

  close(): void {
    if (!this.child) return
    try {
      this.child.kill()
    } catch {
      /* ignore */
    }
    this.child = null
  }

  /** Reset between hanchans. Keeps the subprocess alive (saves a ~5s model
   *  reload per hanchan) but clears emitter + pending state. The next
   *  observed action will trigger a fresh `start_game`/`start_kyoku`. */
  reset(): void {
    this.printTimingSummary('hanchan-end')
    this.emitter = new MjaiEmitter()
    this.pendingEvents = []
    this.pendingReaction = null
  }

  // --- low-level pipe IO ---

  private writeLine(obj: unknown): void {
    const line = JSON.stringify(obj) + '\n'
    if (process.env.MORTAL_TRACE) {
      appendFileSync(
        process.env.MORTAL_TRACE,
        `[P${this.playerId} pid=${process.pid}] >>> ${line}`,
      )
    }
    writeSync(this.stdinFd, line)
  }

  private readJsonLine(): { type: string; [k: string]: unknown } {
    // Accumulate stdout bytes until we see a \n. Node makes subprocess
    // pipes non-blocking, so readSync may throw EAGAIN when no data is
    // ready; in that case we spin-sleep 1ms via Atomics.wait.
    const sleepBuf = new Int32Array(new SharedArrayBuffer(4))
    while (!this.stdoutBuf.includes('\n')) {
      const buf = Buffer.alloc(4096)
      let n: number
      try {
        n = readSync(this.stdoutFd, buf, 0, buf.length, null)
      } catch (e) {
        const err = e as NodeJS.ErrnoException
        if (err.code === 'EAGAIN') {
          Atomics.wait(sleepBuf, 0, 0, 1)
          continue
        }
        throw e
      }
      if (n === 0) throw new Error('mortal-bridge: subprocess closed stdout')
      this.stdoutBuf += buf.slice(0, n).toString('utf8')
    }
    const idx = this.stdoutBuf.indexOf('\n')
    const line = this.stdoutBuf.slice(0, idx)
    this.stdoutBuf = this.stdoutBuf.slice(idx + 1)
    if (process.env.MORTAL_TRACE) {
      appendFileSync(
        process.env.MORTAL_TRACE,
        `[P${this.playerId} pid=${process.pid}] <<< ${line}\n`,
      )
    }
    return JSON.parse(line)
  }
}
