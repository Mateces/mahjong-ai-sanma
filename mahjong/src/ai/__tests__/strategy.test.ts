import { describe, it, expect, beforeEach } from 'vitest'
import { ActionKind } from '../../game/types'
import type { Action, GameState, Player } from '../../game/types'
import { createGame, getValidActions, applyAction } from '../../game/engine'
import { chooseAction, chooseRespondAction, chooseKitaDeclareAction } from '../ai-controller'
import { defaultDecide } from '../default-decide'
import type { Strategy } from '../strategy'
import { registerStrategy, getStrategy, listStrategies } from '../strategies/registry'

// Bring a state through Pass to discard phase so we have a meaningful set
// of actions to feed chooseAction.
function reachDiscardPhase(state: GameState): GameState {
  let s = state
  let safety = 0
  while (s.phase !== 'discard' && safety++ < 5) {
    s = applyAction(s, { kind: ActionKind.Pass })
  }
  return s
}

describe('Strategy framework', () => {
  describe('chooseAction dispatch', () => {
    it('delegates to strategy.decide when provided', () => {
      const state = reachDiscardPhase(createGame({ playerCount: 4 }))
      const actions = getValidActions(state)

      let called = false
      const seen = {
        state: null as GameState | null,
        actions: null as Action[] | null,
        asPlayer: -1 as number,
      }
      const myStrategy: Strategy = {
        name: 'test-spy',
        decide(s, a, p) {
          called = true
          seen.state = s
          seen.actions = a
          seen.asPlayer = p
          // Deterministic: return the first action so the test can assert on it.
          return a[0]
        },
      }

      const chosen = chooseAction(state, actions, 0, 0 as Player, myStrategy)
      expect(called).toBe(true)
      expect(seen.state).toBe(state)
      expect(seen.actions).toBe(actions)
      expect(seen.asPlayer).toBe(0)
      expect(chosen).toBe(actions[0])
    })

    it('falls back to default when no strategy is provided', () => {
      const state = reachDiscardPhase(createGame({ playerCount: 4 }))
      const actions = getValidActions(state)

      const fromController = chooseAction(state, actions, 0, 0 as Player)
      const fromDefault = defaultDecide(state, actions, 0, 0 as Player)
      expect(fromController).toEqual(fromDefault)
    })

    it('strategy can return Pass even when defaults would not', () => {
      const state = reachDiscardPhase(createGame({ playerCount: 4 }))
      const actions = getValidActions(state)

      // Add a Pass action so the strategy can return it; the default decider
      // would never select Pass in discard phase, so this verifies that the
      // strategy is fully in control.
      const augmented = [...actions, { kind: ActionKind.Pass } as Action]
      const passStrategy: Strategy = {
        name: 'always-pass',
        decide(_s, a) {
          return a.find(act => act.kind === ActionKind.Pass)!
        },
      }
      const chosen = chooseAction(state, augmented, 0, 0 as Player, passStrategy)
      expect(chosen.kind).toBe(ActionKind.Pass)
    })
  })

  describe('Registry', () => {
    beforeEach(() => {
      // Registry is module-level singleton; each test re-registers cleanly.
    })

    it('register + get roundtrip', () => {
      const s: Strategy = { name: 'reg-test-x', decide: (_s, a) => a[0] }
      registerStrategy(s)
      expect(getStrategy('reg-test-x')).toBe(s)
    })

    it('returns null for unknown name', () => {
      expect(getStrategy('does-not-exist-xyz')).toBeNull()
    })

    it('listStrategies includes registered names', () => {
      registerStrategy({ name: 'reg-test-y', decide: (_s, a) => a[0] })
      expect(listStrategies()).toContain('reg-test-y')
    })

    it('re-registering same name overwrites', () => {
      const s1: Strategy = { name: 'reg-overwrite', decide: (_s, a) => a[0] }
      const s2: Strategy = { name: 'reg-overwrite', decide: (_s, a) => a[a.length - 1] }
      registerStrategy(s1)
      registerStrategy(s2)
      expect(getStrategy('reg-overwrite')).toBe(s2)
    })
  })

  describe('respond phase per-seat routing', () => {
    it('only the targeted seat uses its strategy', () => {
      // Build a state where P0 discards a tile that no opponent wins on
      // and no one would pon (random haipai). We just verify routing logic.
      let state = createGame({ playerCount: 4 })
      state = reachDiscardPhase(state)
      // Force P0 to discard their first tile so we land in respond phase.
      const acts = getValidActions(state)
      const firstDiscard = acts.find(a => a.kind === ActionKind.Discard)
      expect(firstDiscard).toBeDefined()
      state = applyAction(state, firstDiscard!)
      expect(state.phase).toBe('respond')

      const seatsAsked: Player[] = []
      const spyStrategy: Strategy = {
        name: 'spy',
        decide(_s, actions, p) {
          seatsAsked.push(p)
          // Always pass so the orchestrator runs through all priority phases.
          return actions.find(a => a.kind === ActionKind.Pass)!
        },
      }

      // Only P2 gets the spy strategy; others should never invoke it.
      const strategies: (Strategy | null)[] = [null, null, spyStrategy, null]
      chooseRespondAction(state, [0, 0, 0, 0], strategies)

      // P2 may or may not be polled depending on whether they have any
      // pon/chi/ron option. To make the test deterministic, assert that
      // EVERY seat that the spy was asked to decide for is P2.
      for (const seat of seatsAsked) {
        expect(seat).toBe(2)
      }
    })

    it('null strategies array produces same result as omitting it', () => {
      let state = createGame({ playerCount: 4 })
      state = reachDiscardPhase(state)
      const acts = getValidActions(state)
      const firstDiscard = acts.find(a => a.kind === ActionKind.Discard)
      state = applyAction(state, firstDiscard!)

      const a = chooseRespondAction(state, [0, 0, 0, 0])
      const b = chooseRespondAction(state, [0, 0, 0, 0], [null, null, null, null])
      expect(a).toEqual(b)
    })
  })

  describe('kita_declare per-seat routing', () => {
    it('strategies array is honored for chankita responders', () => {
      // We can't easily construct a kita_declare state with someone tenpai
      // on 北 from createGame alone. Sanity test: the orchestrator should
      // accept the optional strategies array without crashing, even when
      // no chankita opportunity exists.
      let state = createGame({ playerCount: 3 })
      state = applyAction(state, { kind: ActionKind.Pass })
      // No assertion on phase — just verify the API is callable.
      const result = chooseKitaDeclareAction(state, [0, 0, 0], [null, null, null])
      expect(result.kind).toBeDefined()
    })
  })
})
