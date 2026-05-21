import { createGame, getValidActions, applyActionWithEvents, nextRound, finalRanking } from '../src/game/engine'
import { MjaiEmitter } from '../src/ai/mjai/emit'
import { chooseAction, chooseRespondAction, chooseKitaDeclareAction } from '../src/ai/ai-controller'
import { ActionKind } from '../src/game/types'
import type { Action, GameState, Player, Strategy } from '../src/game/types'
import { calculateShanten } from '../src/game/shanten'
import type { MortalBridge } from '../src/ai/strategies/mortal-bridge'

export interface HanchanPlayerStats {
  rank: number
  score: number
  bankrupt: boolean
  wins: number
  tsumoWins: number
  ronWins: number
  dealIns: number
  riichi: number
  fuuro: number
  kita: number
  fuuroRounds: number
  tenpaiRyukyoku: number
}

export interface HanchanResult {
  players: HanchanPlayerStats[]
  rounds: number
  ryukyoku: number
  warnings: string[]
}

export interface SeatConfig {
  difficulty: number
  strategy: Strategy | null
}

const SAFETY_LIMIT = 5000

function isTenpai(hand: readonly number[]): boolean {
  return calculateShanten([...hand]) <= 0
}

/**
 * Run a single hanchan (半荘) and return per-player statistics.
 *
 * @param seats Per-seat configuration (difficulty + strategy), indexed by engine seat 0..3.
 * @param playerCount 3 (sanma) or 4 (yonma).
 * @param endRound 4 (east-only) or 8 (east+south).
 * @param startDealer Which seat starts as dealer (起家).
 * @returns Per-player stats and summary data.
 */
export function runHanchan(
  seats: SeatConfig[],
  playerCount: 3 | 4,
  endRound: 4 | 8,
  startDealer: Player = 0 as Player,
): HanchanResult {
  const difficulties = seats.map(s => s.difficulty)
  const strategies = seats.map(s => s.strategy)
  const mortalBridges = strategies.filter(
    (s): s is MortalBridge => s !== null && typeof s === 'object' && 'printTimingSummary' in s,
  )

  // Per-player accumulators for this hanchan
  const fuuroCount = new Array(playerCount).fill(0)
  const riichiCount = new Array(playerCount).fill(0)
  const kitaCount = new Array(playerCount).fill(0)
  const winCount = new Array(playerCount).fill(0)
  const tsumoCount = new Array(playerCount).fill(0)
  const ronCount = new Array(playerCount).fill(0)
  const dealInCount = new Array(playerCount).fill(0)
  const fuuroRounds = new Array(playerCount).fill(0)
  const tenpaiRyukyoku = new Array(playerCount).fill(0)

  // Per-round tracking
  let didFuuroThisRound = new Array(playerCount).fill(false)
  let threatPresent = false
  let rounds = 0
  let ryukyoku = 0
  const warnings: string[] = []

  function resetRound() {
    didFuuroThisRound = new Array(playerCount).fill(false)
    threatPresent = false
  }

  let state: GameState = createGame({ playerCount, endRound, startDealer })
  for (const b of mortalBridges) b.reset()
  const mjaiEmitter = new MjaiEmitter()

  for (let safety = 0; safety < SAFETY_LIMIT; safety++) {
    if (state.phase === 'game_over') break

    const actions = getValidActions(state)
    if (actions.length === 0) {
      warnings.push(
        `getValidActions empty: phase=${state.phase} player=${state.currentPlayer}` +
        ` round=${state.roundNumber} honba=${state.honba}`,
      )
      break
    }

    if (safety === SAFETY_LIMIT - 1) {
      warnings.push(`safety limit hit: phase=${state.phase} player=${state.currentPlayer}`)
    }

    const acting = state.currentPlayer
    const action: Action = state.phase === 'respond'
      ? chooseRespondAction(state, difficulties, strategies)
      : state.phase === 'kita_declare'
      ? chooseKitaDeclareAction(state, difficulties, strategies)
      : chooseAction(state, actions, difficulties[acting], undefined, strategies[acting])

    if (action.kind === ActionKind.Riichi) {
      riichiCount[acting]++
      threatPresent = true
    }

    const stateBefore = state
    const stepResult = applyActionWithEvents(state, action, mjaiEmitter)
    state = stepResult.state
    for (const b of mortalBridges) b.feedEvents(stepResult.events)

    if (stateBefore.phase === 'kita_declare') {
      const declarer = stateBefore.currentPlayer
      const before = stateBefore.players[declarer].kitaCount
      const after = state.players[declarer]?.kitaCount ?? before
      if (after > before) kitaCount[declarer] += after - before
    }

    if (stateBefore.phase === 'respond') {
      switch (action.kind) {
        case ActionKind.Pon:
        case ActionKind.Chi:
        case ActionKind.Daiminkan:
          fuuroCount[state.currentPlayer]++
          didFuuroThisRound[state.currentPlayer] = true
          break
      }
    }

    if (state.phase === 'tsumo_win') {
      winCount[state.currentPlayer]++
      tsumoCount[state.currentPlayer]++
      rounds++
      for (let p = 0; p < playerCount; p++) {
        if (didFuuroThisRound[p]) fuuroRounds[p]++
      }
      state = nextRound(state)
      resetRound()
    } else if (state.phase === 'ron_win') {
      winCount[state.currentPlayer]++
      ronCount[state.currentPlayer]++
      const discarder = stateBefore.lastDiscardPlayer
      if (discarder != null) dealInCount[discarder]++
      rounds++
      for (let p = 0; p < playerCount; p++) {
        if (didFuuroThisRound[p]) fuuroRounds[p]++
      }
      state = nextRound(state)
      resetRound()
    } else if (state.phase === 'ryukyoku') {
      ryukyoku++
      rounds++
      for (let p = 0; p < playerCount; p++) {
        if (didFuuroThisRound[p]) fuuroRounds[p]++
        if (isTenpai(state.players[p].hand)) tenpaiRyukyoku[p]++
      }
      state = nextRound(state)
      resetRound()
    }
  }

  // Build final results from ranking
  const ranking = finalRanking(state)
  const rankMap = new Map<number, number>()
  const scoreMap = new Map<number, number>()
  for (const { player, score, rank } of ranking) {
    rankMap.set(player, rank)
    scoreMap.set(player, score)
  }

  const players: HanchanPlayerStats[] = []
  for (let p = 0; p < playerCount; p++) {
    players.push({
      rank: rankMap.get(p) ?? 0,
      score: scoreMap.get(p) ?? 0,
      bankrupt: (scoreMap.get(p) ?? 0) < 0,
      wins: winCount[p],
      tsumoWins: tsumoCount[p],
      ronWins: ronCount[p],
      dealIns: dealInCount[p],
      riichi: riichiCount[p],
      fuuro: fuuroCount[p],
      kita: kitaCount[p],
      fuuroRounds: fuuroRounds[p],
      tenpaiRyukyoku: tenpaiRyukyoku[p],
    })
  }

  for (const b of mortalBridges) b.printTimingSummary('hanchan-end')

  return { players, rounds, ryukyoku, warnings }
}
