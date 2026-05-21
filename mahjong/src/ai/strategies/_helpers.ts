import { ActionKind } from '../../game/types'
import type { Action, GameState, Player, TileType } from '../../game/types'
import { estimatePoints } from '../evaluate-discard'

/**
 * Check whether a 13-tile hand has an "obvious" yaku — one that doesn't
 * require riichi to be valid for winning. Approximation; misses some yaku
 * like pinhu (hard to detect cheaply), but catches the high-frequency cases:
 *   - Yakuhai triplets (dragons, round wind, seat wind)
 *   - Tanyao (all simples, no terminal/honor)
 *
 * Used by riichi-vs-damaten decisions: when a hand already has yaku via
 * one of these, riichi is not required to be able to win, so the player
 * can opt for ダマ to preserve menzen-surprise and skip the -1000 stick.
 */
export function hasObviousYaku(
  hand: TileType[],
  state: GameState,
  asPlayer: Player,
): boolean {
  const counts = new Array(34).fill(0)
  for (const t of hand) counts[t]++

  // 三元 (dragon) triplets
  for (let d = 31; d <= 33; d++) {
    if (counts[d] >= 3) return true
  }
  // 場風 / 自風 triplets
  const seatWindTile =
    27 + ((asPlayer - state.dealer + state.playerCount) % state.playerCount)
  const roundWindTile = 27 + state.roundWind
  if (counts[seatWindTile] >= 3) return true
  if (counts[roundWindTile] >= 3) return true

  // 断幺九 (tanyao) — all tiles are 2-8 of m/p/s
  const allSimples = hand.every(t => {
    if (t >= 27) return false
    const r = t % 9
    return r >= 1 && r <= 7
  })
  if (allSimples) return true

  return false
}

/**
 * Threshold below which we still riichi (need uradora upside or even just
 * the +1 han to make the hand mean anything). 5200 ≈ 3 han 40 fu child ron;
 * above this the hand is already "respectable" and ダマ trades a small EV
 * loss for not surrendering tempo / not exposing the wait.
 */
const RIICHI_SKIP_VALUE = 5200

/**
 * Drop Riichi:X actions from the candidate set when the 13-tile hand
 * (after hypothetically discarding X) already has a yaku AND its 仮ダマ
 * value is ≥ RIICHI_SKIP_VALUE. The corresponding Discard:X is left in
 * place, so the downstream decider can still discard the same tile —
 * just without declaring riichi.
 *
 * If both Riichi:X and Discard:X exist and Riichi:X is filtered out, the
 * decider will pick Discard:X (since defaultDecide's clamp that ensures
 * Riichi:X ≥ Discard:X is moot once Riichi:X is gone from the set).
 */
export function filterRiichiByValue(
  actions: Action[],
  state: GameState,
  asPlayer: Player,
): Action[] {
  const hand = state.players[asPlayer].hand
  return actions.filter(a => {
    if (a.kind !== ActionKind.Riichi) return true

    const remaining = [...hand]
    const idx = remaining.indexOf(a.tile)
    if (idx === -1) return true // shouldn't happen, but don't drop on edge
    remaining.splice(idx, 1)

    const hasYaku = hasObviousYaku(remaining, state, asPlayer)
    if (!hasYaku) return true // no yaku → must riichi for the hand to be valid

    const valueDama = estimatePoints(remaining, state, asPlayer, 0)
    if (valueDama < RIICHI_SKIP_VALUE) return true // not rich enough — riichi for the boost

    return false // skip this riichi action
  })
}
