import { parentPort, workerData } from 'node:worker_threads'
import { createGame, getValidActions, applyAction, applyActionWithEvents, nextRound, finalRanking } from '../src/game/engine'
import { MjaiEmitter } from '../src/ai/mjai/emit'
import { chooseAction, chooseRespondAction, chooseKitaDeclareAction } from '../src/ai/ai-controller'
import { ActionKind } from '../src/game/types'
import type { Player } from '../src/game/types'
import { getStrategy, listStrategies } from '../src/ai/strategies/registry'
import type { Strategy } from '../src/ai/strategy'
import { calculateShanten } from '../src/game/shanten'
import { MortalBridge } from '../src/ai/strategies/mortal-bridge'
import { randomFillSync } from 'node:crypto'
// Side-effect: registers all built-in strategies before we resolve names.
import '../src/ai/strategies'

// Worker that runs `hanchans` games with the given difficulty seats and
// reports per-player stats. The main process aggregates across workers.
//
// Each hanchan is fully independent (engine starts a fresh wall and hands
// in createGame), so distributing across workers is a clean parallel split.

interface WorkerInput {
  hanchans: number
  difficulties: number[]
  playerCount: 3 | 4
  endRound: number
  workerIndex: number
  /** Optional per-seat strategy names. Empty entries = default AI. */
  strategyNames?: (string | null)[]
}

interface PlayerStats {
  wins: number
  tsumo: number
  ron: number
  dealIns: number
  riichi: number
  fuuro: number
  kita: number
  rankSum: number
  scoreSum: number
  rankDist: number[]
  /** Rounds where this player made at least one Pon/Chi/Daiminkan. */
  fuuroRounds: number
  /** Of fuuroRounds, ones ending in ryukyoku (call-then-stuck signal). */
  fuuroRyukyoku: number
  /** Rounds ending in ryukyoku with this player tenpai (≥ pushing). */
  tenpaiRyukyoku: number
  /** Rounds ending ryukyoku noten with: opponent threat present AND
   *  this player stayed menzen — inferred "likely defended". */
  defendedLikely: number
  /** Hanchans where this player's final score < 0 (被飞). */
  bankrupt: number
}

interface WorkerOutput {
  perPlayer: PlayerStats[]
  ryukyoku: number
  totalRounds: number
  hanchansCompleted: number
}

const { hanchans, difficulties, playerCount, endRound, workerIndex, strategyNames } = workerData as WorkerInput
const SAFETY_LIMIT = 5000

// Resolve per-seat strategy names against the registry. Unknown names fail
// loudly so a typo doesn't silently fall back to default AI and contaminate
// the comparison. The special name 'mortal' instantiates MortalBridge with
// $MORTAL_CHECKPOINT (and optional $MORTAL_PYTHON, $MORTAL_DEVICE).
const strategies: (Strategy | null)[] = (strategyNames ?? []).map((name, idx) => {
  let checkpoint: string | undefined
  let device: string | undefined
  let actualName = name
  if (name.startsWith('mortal:')) {
    let path = name.slice('mortal:'.length)
    const atIdx = path.lastIndexOf('@')
    if (atIdx > 0) {
      device = path.slice(atIdx + 1)
      path = path.slice(0, atIdx)
    }
    checkpoint = path
    actualName = 'mortal'
  } else if (name === 'mortal') {
    checkpoint = process.env.MORTAL_CHECKPOINT
  }
  if (actualName === 'mortal') {
    if (!checkpoint) {
      throw new Error("strategy 'mortal' requires env MORTAL_CHECKPOINT or mortal:/path syntax")
    }
    return new MortalBridge(idx as Player, {
      checkpoint,
      pythonExe: process.env.MORTAL_PYTHON ?? 'python3',
      serverScript: process.env.MORTAL_SERVER ?? 'scripts/mortal_bot_server.py',
      device: device ?? process.env.MORTAL_DEVICE ?? 'cpu',
      debug: process.env.MORTAL_DEBUG === '1',
    })
  }
  const s = getStrategy(name)
  if (!s) {
    throw new Error(
      `Unknown strategy '${name}'. Registered: [${listStrategies().join(', ') || '(none)'}, mortal]`,
    )
  }
  return s
})

const mortalBridges: MortalBridge[] = strategies.filter(
  (s): s is MortalBridge => s instanceof MortalBridge,
)

const stats: WorkerOutput = {
  perPlayer: Array.from({ length: playerCount }, () => ({
    wins: 0, tsumo: 0, ron: 0, dealIns: 0, riichi: 0, fuuro: 0, kita: 0,
    rankSum: 0, scoreSum: 0, rankDist: new Array(playerCount).fill(0),
    fuuroRounds: 0, fuuroRyukyoku: 0, tenpaiRyukyoku: 0, defendedLikely: 0,
    bankrupt: 0,
  })),
  ryukyoku: 0,
  totalRounds: 0,
  hanchansCompleted: 0,
}

// Per-round flags, reset on every nextRound. Used to attribute the round's
// outcome back to per-player behavior (副露 / 防守).
let didFuuroThisRound = new Array<boolean>(playerCount).fill(false)
let threatPresentThisRound = false

function resetRoundFlags(): void {
  for (let i = 0; i < playerCount; i++) didFuuroThisRound[i] = false
  threatPresentThisRound = false
}

function isTenpai(hand: readonly number[]): boolean {
  // 13-tile hands at ryukyoku: shanten 0 = tenpai.
  // 14-tile hand should not occur at ryukyoku, but tolerate shanten ≤ 0.
  return calculateShanten([...hand]) <= 0
}

function attributeRyukyoku(state: { players: readonly { hand: readonly number[]; isMenzen: boolean }[] }): void {
  for (let p = 0; p < playerCount; p++) {
    const player = state.players[p]
    const tenpai = isTenpai(player.hand)
    const origIdx = currentSeatPerm[p]!

    if (didFuuroThisRound[p]) {
      stats.perPlayer[origIdx].fuuroRounds++
      stats.perPlayer[origIdx].fuuroRyukyoku++
    }
    if (tenpai) {
      stats.perPlayer[origIdx].tenpaiRyukyoku++
    }
    if (threatPresentThisRound && player.isMenzen && !tenpai) {
      stats.perPlayer[origIdx].defendedLikely++
    }
  }
}

function attributeWinOutcome(winner: Player): void {
  for (let p = 0; p < playerCount; p++) {
    if (didFuuroThisRound[p]) stats.perPlayer[currentSeatPerm[p]!].fuuroRounds++
  }
  void winner
}

/** Fisher-Yates shuffle using crypto randomness. Returns a new array. */
function shuffleArray(n: number): number[] {
  const arr = Array.from({ length: n }, (_, i) => i)
  const bytes = new Uint8Array(n)
  randomFillSync(bytes)
  for (let i = n - 1; i > 0; i--) {
    const j = bytes[i]! % (i + 1)
    ;[arr[i], arr[j]] = [arr[j]!, arr[i]!]
  }
  return arr
}

// Cycle the start dealer (起家) across hanchans so each player serves as
// initial East an equal share of the time.
//
// When --shuffle-seats is active, each hanchan independently randomizes
// which strategy sits at which engine seat. The mapping is:
//   seatPerm[engineSeat] = originalStrategyIndex
// So seat 0 (engine P0) plays as strategy seatPerm[0], etc.
// Stats are accumulated per originalStrategyIndex so the final report
// reflects each strategy's true strength regardless of seating luck.
const SHUFFLE_SEATS = (process.env.SHUFFLE_SEATS ?? '0') === '1'
const seatCounts = new Array(playerCount).fill(0) // debug: how many times each strategy sat at each seat

// currentSeatPerm is set at the start of each hanchan and read by
// attributeRyukyoku / attributeWinOutcome to map engine seats → stats.
let currentSeatPerm: number[] = Array.from({ length: playerCount }, (_, i) => i)

let dealerCycle = workerIndex
for (let g = 0; g < hanchans; g++) {
  const startDealer = (dealerCycle % playerCount) as Player
  dealerCycle++

  // Determine seat assignment for this hanchan.
  // seatPerm[engineSeat] = which original strategy index occupies that seat.
  if (SHUFFLE_SEATS && strategies.length === playerCount) {
    currentSeatPerm = shuffleArray(playerCount)
  } else {
    currentSeatPerm = Array.from({ length: playerCount }, (_, i) => i)
  }
  const seatPerm = currentSeatPerm

  // Build per-seat arrays: seatStrategies[seat] and seatDifficulties[seat]
  const seatStrategies: (Strategy | null)[] = seatPerm.map(i => strategies[i] ?? null)
  const seatDifficulties: number[] = seatPerm.map(i => difficulties[i] ?? 0)

  // Verify: no duplicate strategy indices
  if (new Set(seatPerm).size !== playerCount) {
    throw new Error(`seatPerm has duplicates: ${seatPerm}`)
  }

  let state = createGame({ playerCount, endRound, startDealer })
  resetRoundFlags()
  for (const b of mortalBridges) b.reset()

  // One MJAI emitter per hanchan — carries kyoku-transition state.
  // Mortal bridges receive events through it via feedEvents().
  const mjaiEmitter = new MjaiEmitter()

  for (let safety = 0; safety < SAFETY_LIMIT; safety++) {
    if (state.phase === 'game_over') break

    const actions = getValidActions(state)
    if (actions.length === 0) {
      process.stderr.write(
        `WARNING [worker=${workerIndex} hanchan=${g}]: getValidActions returned empty` +
        ` phase=${state.phase} player=${state.currentPlayer}` +
        ` round=${state.roundNumber} honba=${state.honba}` +
        ` turnCount=${state.turnCount}\n`,
      )
      break
    }

    if (safety === SAFETY_LIMIT - 1) {
      process.stderr.write(
        `WARNING [worker=${workerIndex} hanchan=${g}]: safety limit (${SAFETY_LIMIT}) hit` +
        ` phase=${state.phase} player=${state.currentPlayer}\n`,
      )
    }

    const acting = state.currentPlayer
    // Per-responder polling for monotonic difficulty in phases where the
    // actor isn't the same as the player whose turn it is. Strategies (if
    // provided) override the difficulty-based default on a per-seat basis.
    const action = state.phase === 'respond'
      ? chooseRespondAction(state, seatDifficulties, seatStrategies)
      : state.phase === 'kita_declare'
      ? chooseKitaDeclareAction(state, seatDifficulties, seatStrategies)
      : chooseAction(state, actions, seatDifficulties[acting], undefined, seatStrategies[acting] ?? null)

    if (action.kind === ActionKind.Riichi) {
      stats.perPlayer[seatPerm[acting]!].riichi++
      // Any riichi declaration is a threat against every other seat for the
      // remainder of this round.
      threatPresentThisRound = true
    }

    const stateBefore = state
    const stepResult = applyActionWithEvents(state, action, mjaiEmitter)
    state = stepResult.state
    for (const b of mortalBridges) b.feedEvents(stepResult.events)

    // Track kita declarations: kitaCount increments inside resolveKita when
    // an opponent passes on chankita.
    if (stateBefore.phase === 'kita_declare') {
      const declarer = stateBefore.currentPlayer
      const before = stateBefore.players[declarer].kitaCount
      const after = state.players[declarer]?.kitaCount ?? before
      if (after > before) stats.perPlayer[seatPerm[declarer]!].kita += after - before
    }

    if (stateBefore.phase === 'respond') {
      switch (action.kind) {
        case ActionKind.Pon:
        case ActionKind.Chi:
        case ActionKind.Daiminkan:
          stats.perPlayer[seatPerm[state.currentPlayer]!].fuuro++
          didFuuroThisRound[state.currentPlayer] = true
          break
      }
    }

    if (state.phase === 'tsumo_win') {
      stats.perPlayer[seatPerm[state.currentPlayer]!].wins++
      stats.perPlayer[seatPerm[state.currentPlayer]!].tsumo++
      stats.totalRounds++
      attributeWinOutcome(state.currentPlayer)
      state = nextRound(state)
      resetRoundFlags()
    } else if (state.phase === 'ron_win') {
      stats.perPlayer[seatPerm[state.currentPlayer]!].wins++
      stats.perPlayer[seatPerm[state.currentPlayer]!].ron++
      const discarder = stateBefore.lastDiscardPlayer
      if (discarder != null) stats.perPlayer[seatPerm[discarder]!].dealIns++
      stats.totalRounds++
      attributeWinOutcome(state.currentPlayer)
      state = nextRound(state)
      resetRoundFlags()
    } else if (state.phase === 'ryukyoku') {
      stats.ryukyoku++
      stats.totalRounds++
      attributeRyukyoku(state)
      state = nextRound(state)
      resetRoundFlags()
    }
  }

  // Hanchan ended: accumulate rank/score, mapping engine seat → original strategy
  const ranking = finalRanking(state)
  for (const { player, score, rank } of ranking) {
    const origIdx = seatPerm[player]!
    stats.perPlayer[origIdx].rankSum += rank
    stats.perPlayer[origIdx].scoreSum += score
    stats.perPlayer[origIdx].rankDist[rank - 1]++
    if (score < 0) stats.perPlayer[origIdx].bankrupt++
  }
  stats.hanchansCompleted++

  // Emit per-hanchan raw result for the main thread to collect.
  parentPort?.postMessage({
    type: 'hanchan_result',
    workerIndex,
    hanchan: g,
    seatPerm,
    results: ranking.map(({ player, score, rank }) => ({
      strategy: seatPerm[player]!,
      seat: player,
      score,
      rank,
    })),
  })

  parentPort?.postMessage({ type: 'progress', workerIndex, done: g + 1 })
}

for (const b of mortalBridges) b.printTimingSummary('final')

parentPort?.postMessage({ type: 'done', workerIndex, stats })
