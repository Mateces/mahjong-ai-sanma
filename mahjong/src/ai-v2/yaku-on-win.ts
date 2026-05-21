import type { GameState, Meld, Player, PlayerState, TileType } from '../game/types'
import { evaluateWin, type WinEvaluation } from '../game/win-evaluation'

/**
 * Compute the (yaku, han, fu, points) detail for a hypothetical winning
 * hand. Wraps v1's `evaluateWin` by synthesizing a state where `asPlayer`
 * just won with the given hand + meld + winningTile + tsumo/ron flag.
 *
 * Returns null when the hand has no yaku (無役: not a legal win).
 *
 * Used by Phase 2 path enumeration to compute precise EV per wait, instead
 * of the v1/Phase-1 mahjong-helper-style aggregate point estimate.
 */
export function evaluateWinForHand(
  hand13: TileType[],
  winTile: TileType,
  melds: Meld[],
  state: GameState,
  asPlayer: Player,
  isTsumo: boolean,
  assumeRiichi = false,
): WinEvaluation | null {
  // `evaluateWin` expects the winner's hand to be 14 tiles for tsumo and
  // 13 for ron (the engine convention). Build a synthetic state with the
  // hypothetical hand, melds, and last-discard/last-drawn fields set
  // consistent with the win type.
  const synthHand = isTsumo ? [...hand13, winTile] : [...hand13]
  const players = state.players.map((p, i): PlayerState => {
    if (i !== asPlayer) return p
    return {
      ...p,
      hand: synthHand,
      melds,
      // When `assumeRiichi` is true, set the player's riichi flag so the
      // yaku evaluator counts the riichi yaku (and unlocks ron paths that
      // would otherwise be 無役 for menzen hands). Used by the EV pipeline
      // to compute "Riichi:X" vs "Discard:X" candidate values separately.
      riichi: assumeRiichi || p.riichi,
      // Mark menzen consistent with melds.
      isMenzen: melds.length === 0
        || melds.every(m => m.type === 'ankan'),
    }
  }) as GameState['players']

  const synth: GameState = {
    ...state,
    players,
    currentPlayer: asPlayer,
    lastDiscard: isTsumo ? state.lastDiscard : winTile,
    lastDiscardPlayer: isTsumo ? state.lastDiscardPlayer : (((asPlayer + 1) % state.playerCount) as Player),
    lastDrawnTile: isTsumo ? winTile : state.lastDrawnTile,
    // Avoid spurious 天和/地和 yakuman: tenhou/chiihou fire when
    // turnCount ≤ playerCount and the round is still on its first 巡.
    // Path-enumerated wins occur multiple turns in the future, so bump the
    // hypothetical turn past the first 巡 to suppress these.
    turnCount: Math.max(state.turnCount, state.playerCount + 1),
  }

  const evalResult = evaluateWin(synth, asPlayer, isTsumo, winTile)
  if (!evalResult.hasYaku) return null
  return evalResult
}

/**
 * Convert a winner's `ScoreResult` into the total points they receive.
 * For ron, that's the ron payment (one payer). For tsumo, it's the sum
 * across all payers.
 */
export function totalWinPoints(
  evalResult: WinEvaluation,
  isDealer: boolean,
  playerCount: 3 | 4,
  isTsumo: boolean,
): number {
  const s = evalResult.scoreResult
  if (isTsumo) {
    if (isDealer) {
      return s.tsumoDealer * (playerCount - 1)
    }
    return s.tsumoChild * (playerCount - 2) + s.tsumoDealerPays
  }
  return s.ronPayment
}
