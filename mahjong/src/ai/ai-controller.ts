import { ActionKind } from '../game/types'
import type { Action, GameState, Player, PlayerState } from '../game/types'
import { isWinningHand } from '../game/hand-analysis'
import { previewWin } from '../game/win-evaluation'
import { isPermanentFuriten } from '../game/engine'
import { defaultDecide } from './default-decide'
import type { Strategy } from './strategy'

/**
 * Choose the best action for the current actor.
 *
 * Behavior:
 *   - When `strategy` is provided, the decision is delegated entirely to
 *     `strategy.decide(state, actions, asPlayer)`. The strategy is
 *     responsible for choosing one of the supplied actions; it can call
 *     `defaultDecide` to fall back on the default scoring logic.
 *   - When `strategy` is omitted, the default difficulty-based scoring is
 *     used (see `defaultDecide`).
 *
 * `asPlayer` overrides which seat the AI is acting as. Defaults to
 * state.currentPlayer (correct for discard phase, but the respond and
 * kita_declare orchestrators below pass the specific responder).
 */
export function chooseAction(
  state: GameState,
  actions: Action[],
  difficulty: number = 0,
  asPlayer?: Player,
  strategy?: Strategy | null,
): Action {
  if (strategy) {
    return strategy.decide(state, actions, asPlayer ?? state.currentPlayer)
  }
  return defaultDecide(state, actions, difficulty, asPlayer)
}

/**
 * Resolve the respond-phase decision by polling each potential responder
 * with THEIR own difficulty / strategy, then applying mahjong's call
 * priority (ロン > ポン/大明槓 > チー). Each seat's `strategies[r]` (if
 * present) overrides the difficulty-based default for that seat only.
 */
export function chooseRespondAction(
  state: GameState,
  difficulties: readonly number[],
  strategies?: ReadonlyArray<Strategy | null>,
): Action {
  const strategyFor = (p: Player): Strategy | null =>
    strategies?.[p] ?? null

  // Chankan: only Ron on the kakan'd tile is legal. Responders are
  // everyone except the kaker. No pon/daiminkan/chi branch.
  if (state.chankan) {
    const kaker = state.chankan.kaker
    const tile = state.chankan.tile
    for (let off = 1; off < state.playerCount; off++) {
      const r = ((kaker as number + off) % state.playerCount) as Player
      if (!isWinningHand([...state.players[r].hand, tile])) continue
      const ronOpt: Action = { kind: ActionKind.Ron, called: tile }
      const decision = chooseAction(
        state,
        [ronOpt, { kind: ActionKind.Pass }],
        difficulties[r],
        r,
        strategyFor(r),
      )
      if (decision.kind === ActionKind.Ron) return ronOpt
    }
    return { kind: ActionKind.Pass }
  }

  const discardedBy = state.lastDiscardPlayer
  if (discardedBy == null) return { kind: ActionKind.Pass }

  const responders: Player[] = []
  for (let off = 1; off < state.playerCount; off++) {
    responders.push(((discardedBy as number + off) % state.playerCount) as Player)
  }

  // Phase 1: Ron — any responder
  for (const r of responders) {
    const myActs = validRespondActionsForPlayer(state, r)
    const ronOpt = myActs.find(a => a.kind === ActionKind.Ron)
    if (!ronOpt) continue
    const decision = chooseAction(
      state,
      [ronOpt, { kind: ActionKind.Pass }],
      difficulties[r],
      r,
      strategyFor(r),
    )
    if (decision.kind === ActionKind.Ron) return ronOpt
  }

  // Phase 2: Pon / Daiminkan — closest responder wins
  for (const r of responders) {
    const myActs = validRespondActionsForPlayer(state, r)
    const calls = myActs.filter(
      a => a.kind === ActionKind.Pon || a.kind === ActionKind.Daiminkan,
    )
    if (calls.length === 0) continue
    const decision = chooseAction(
      state,
      [...calls, { kind: ActionKind.Pass }],
      difficulties[r],
      r,
      strategyFor(r),
    )
    if (decision.kind !== ActionKind.Pass) return decision
  }

  // Phase 3: Chi — only the next player, only in 4-player mode (sanma has no chi)
  if (state.playerCount === 4) {
    const next = ((discardedBy as number + 1) % state.playerCount) as Player
    const myActs = validRespondActionsForPlayer(state, next)
    const chis = myActs.filter(a => a.kind === ActionKind.Chi)
    if (chis.length > 0) {
      const decision = chooseAction(
        state,
        [...chis, { kind: ActionKind.Pass }],
        difficulties[next],
        next,
        strategyFor(next),
      )
      if (decision.kind === ActionKind.Chi) return decision
    }
  }

  return { kind: ActionKind.Pass }
}

/**
 * Sanma chankita (槍北) resolution: poll each potential responder with
 * their own difficulty / strategy to see if they want to ron the declared
 * North tile.
 */
export function chooseKitaDeclareAction(
  state: GameState,
  difficulties: readonly number[],
  strategies?: ReadonlyArray<Strategy | null>,
): Action {
  const declarer = state.currentPlayer
  for (let off = 1; off < state.playerCount; off++) {
    const r = ((declarer as number + off) % state.playerCount) as Player
    if (!isWinningHand([...state.players[r].hand, 30])) continue
    const decision = chooseAction(
      state,
      [{ kind: ActionKind.Ron, called: 30 }, { kind: ActionKind.Pass }],
      difficulties[r],
      r,
      strategies?.[r] ?? null,
    )
    if (decision.kind === ActionKind.Ron) {
      return { kind: ActionKind.Ron, called: 30 }
    }
  }
  return { kind: ActionKind.Pass }
}

/**
 * Compute the respond actions valid for a specific player. This duplicates
 * a slice of getValidActions's logic per-player so the AI can ask each
 * responder independently. Always includes Pass.
 */
function validRespondActionsForPlayer(
  state: GameState,
  responder: Player,
): Action[] {
  const acts: Action[] = [{ kind: ActionKind.Pass }]
  if (state.phase !== 'respond') return acts
  if (state.lastDiscard == null || state.lastDiscardPlayer == null) return acts
  if (responder === state.lastDiscardPlayer) return acts // can't respond to own discard

  const discarded = state.lastDiscard
  const player = state.players[responder]

  // Ron is allowed even in riichi — but must have at least one yaku and
  // not be in permanent furiten (same checks as getValidActions).
  if (isWinningHand([...player.hand, discarded])
      && previewWin(state, responder, false, discarded)
      && !isPermanentFuriten(player)) {
    acts.push({ kind: ActionKind.Ron, called: discarded })
  }

  // Riichi locks the hand: no Pon/Chi/Daiminkan after riichi declaration.
  if (player.riichi) return acts

  const copies = player.hand.filter(t => t === discarded).length

  // Daiminkan
  if (copies === 3) {
    acts.push({ kind: ActionKind.Daiminkan, called: discarded })
  }

  // Pon
  if (copies >= 2) {
    acts.push({ kind: ActionKind.Pon, called: discarded })
  }

  // Chi (only next player, only in 4-player mode)
  if (state.playerCount === 4 && responder === ((state.lastDiscardPlayer as number + 1) % state.playerCount)) {
    const t = discarded
    const suit = t < 27 ? Math.floor(t / 9) : -1
    if (suit >= 0) {
      const rank = t % 9
      const tryChi = (a: number, b: number) => {
        if (player.hand.includes(a) && player.hand.includes(b)) {
          acts.push({ kind: ActionKind.Chi, tiles: [a, b] as [number, number], called: t })
        }
      }
      if (rank >= 2) tryChi(t - 2, t - 1)
      if (rank >= 1 && rank <= 7) tryChi(t - 1, t + 1)
      if (rank <= 6) tryChi(t + 1, t + 2)
    }
  }

  return acts
}
