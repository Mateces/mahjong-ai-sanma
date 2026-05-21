import type { Action, GameState, Player } from '../game/types'

/**
 * A pluggable per-seat decision policy. When provided to chooseAction,
 * the controller delegates the decision entirely to `decide` instead of
 * running the difficulty-based default scoring pipeline.
 *
 * Strategies receive the same arguments the default decider would and
 * must return one of the supplied actions. They can call
 * `defaultDecide(state, actions, difficulty, asPlayer)` to fall back to
 * the default logic for some or all of their input — e.g. a defensive
 * strategy that filters down to 安牌 candidates and then asks the default
 * decider to pick the best one among them.
 *
 * Strategies are seat-local: chooseRespondAction / chooseKitaDeclareAction
 * accept a strategies[] indexed by player so each seat can use a different
 * (or no) strategy in the same hanchan.
 */
export interface Strategy {
  /** Stable identifier used by the registry and verify CLI. */
  readonly name: string

  decide(state: GameState, actions: Action[], asPlayer: Player): Action
}
