import { ActionKind } from '../../game/types'
import type { Action, GameState, Player, PlayerState, TileType } from '../../game/types'
import { calculateShanten } from '../../game/shanten'
import { doraFromIndicator } from '../../game/tile-utils'
import { defaultDecide } from '../default-decide'
import { assessDanger } from '../danger-eval'
import { getVisibleTiles, calculateUkeire } from '../tile-analysis'
import { estimatePoints } from '../evaluate-discard'
import type { Strategy } from '../strategy'

// --- Tunable thresholds (subject to verify-time calibration) ---
const UKEIRE_GOOD_TENPAI = 5         // 聴牌 良形 lower bound
const UKEIRE_GOOD_1SHANTEN = 8       // 一向聴 良形 lower bound
const VALUE_PUSH_1SHANTEN = 5200     // 5200 点 minimum to push 1-shanten
const VALUE_MID = 2600               // 中等手 floor for 回し
const VALUE_MANGAN = 8000            // mangan threshold for mustPush
const DANGER_MAWASHI_MAX = 0.4       // tiles above this danger filtered out in 回し
const SHANTEN_REGRESS_MAX = 1        // max shanten regression allowed in 回し
const VISIBLE_FAN_THREAT = 4         // 副露 4+ visible han triggers threat

interface Threat {
  player: Player
  isRiichi: boolean
}

/**
 * Count visible (公開された) han contributed by a player's melds:
 *  - Dora tiles in any meld
 *  - Yakuhai (dragon / round wind / seat wind) triplets
 * This is a lower bound on the actual hand value; we use it only as a
 * trigger for "is this fuuro player dangerous enough to defend against".
 */
function visibleFan(player: PlayerState, state: GameState, p: Player): number {
  let han = 0
  const isSanma = state.playerCount === 3
  const doraTiles = state.doraMarkers.map(d => doraFromIndicator(d, isSanma))
  for (const meld of player.melds) {
    for (const t of meld.tiles) {
      for (const dora of doraTiles) {
        if (t === dora) han++
      }
    }
    if (meld.type === 'pon' || meld.type === 'daiminkan' || meld.type === 'kakan') {
      const t = meld.tiles[0]
      if (t >= 31 && t <= 33) han++ // 三元
      if (t === 27 + state.roundWind) han++ // 場風
      const seatWindTile = 27 + ((p - state.dealer + state.playerCount) % state.playerCount)
      if (t === seatWindTile && t !== 27 + state.roundWind) han++ // 自風 (avoid double-count when round = seat)
    }
  }
  return han
}

function identifyThreats(state: GameState, asPlayer: Player): Threat[] {
  const threats: Threat[] = []
  for (let p = 0; p < state.playerCount; p++) {
    if (p === asPlayer) continue
    const player = state.players[p]
    if (player.riichi) {
      threats.push({ player: p as Player, isRiichi: true })
    } else if (visibleFan(player, state, p as Player) >= VISIBLE_FAN_THREAT) {
      threats.push({ player: p as Player, isRiichi: false })
    }
  }
  return threats
}

function isLastPlace(state: GameState, asPlayer: Player): boolean {
  const myScore = state.players[asPlayer].score
  return state.players.every((p, i) => i === asPlayer || p.score >= myScore)
}

function isFinalRound(state: GameState): boolean {
  return state.roundNumber >= state.endRound
}

function mustPush(
  state: GameState,
  asPlayer: Player,
  selfShanten: number,
  selfValue: number,
): boolean {
  // 最終局 + 垫底 — can't afford to fold, must scramble for points.
  if (isFinalRound(state) && isLastPlace(state, asPlayer)) return true

  // ≤ 1-shanten + mangan+ value — high-value chase exception.
  // Dealer threshold should arguably be lower (跳満) but for the MVP we
  // use the same mangan threshold for both.
  if (selfShanten <= 1 && selfValue >= VALUE_MANGAN) return true

  return false
}

type DefenseLevel = 'push' | 'mawashi' | 'betaori'

function classifyDefenseLevel(
  selfShanten: number,
  selfUkeire: number,
  selfValue: number,
): DefenseLevel {
  // Tenpai with very weak waits — fold even at tenpai.
  if (selfShanten === 0 && selfUkeire <= 2) return 'betaori'

  // 2-shanten or worse with any threat — fold.
  if (selfShanten >= 2) return 'betaori'

  // Tenpai with good waits — push.
  if (selfShanten === 0 && selfUkeire >= UKEIRE_GOOD_TENPAI) return 'push'

  // 1-shanten 良形 + 良打点 — push.
  if (selfShanten === 1 && selfUkeire >= UKEIRE_GOOD_1SHANTEN && selfValue >= VALUE_PUSH_1SHANTEN) {
    return 'push'
  }

  // 1-shanten 愚形 OR 低打点 — fold.
  if (selfShanten === 1 && (selfUkeire <= 4 || selfValue < VALUE_MID)) return 'betaori'

  // Everything else — 回し (mid-tier defense).
  return 'mawashi'
}

/**
 * ベタオリ: filter to Discard actions only, sort by danger ascending,
 * pick the safest. Non-discard actions (calls, riichi, kita) are dropped
 * — no offensive moves allowed.
 */
function betaoriDiscard(
  state: GameState,
  actions: Action[],
  asPlayer: Player,
): Action {
  const discards = actions.filter(a => a.kind === ActionKind.Discard) as Array<
    Extract<Action, { kind: 'discard' }>
  >
  if (discards.length === 0) return actions[0]

  const sorted = discards
    .map(a => ({ action: a, danger: assessDanger(state, asPlayer, a.tile) }))
    .sort((a, b) => a.danger - b.danger)
  return sorted[0].action
}

/**
 * 回し打ち: filter to "safe enough and not regressing too much" Discard
 * candidates, then delegate to the default scorer to pick the best
 * trade-off. If no candidate survives the filter, fall through to ベタオリ.
 */
function mawashiDiscard(
  state: GameState,
  actions: Action[],
  asPlayer: Player,
  selfShanten: number,
): Action {
  const hand = state.players[asPlayer].hand
  const candidates: Action[] = []

  for (const a of actions) {
    // Drop everything that isn't a Discard. Riichi/Kita are offensive moves
    // we don't want to make in defense mode; calls only happen in respond
    // phase (handled separately).
    if (a.kind !== ActionKind.Discard) continue

    const remaining = [...hand]
    const idx = remaining.indexOf(a.tile)
    if (idx === -1) continue
    remaining.splice(idx, 1)
    const postShanten = calculateShanten(remaining)
    if (postShanten - selfShanten > SHANTEN_REGRESS_MAX) continue

    const danger = assessDanger(state, asPlayer, a.tile)
    if (danger > DANGER_MAWASHI_MAX) continue

    candidates.push(a)
  }

  if (candidates.length === 0) {
    return betaoriDiscard(state, actions, asPlayer)
  }

  return defaultDecide(state, candidates, 0, asPlayer)
}

/**
 * Compute the player's best ukeire across discards that preserve their
 * current 14-tile shanten. This is the "good wait or not" gate the
 * defense level uses.
 */
function bestUkeireForCurrentShanten(
  state: GameState,
  asPlayer: Player,
  selfShanten: number,
  visible: number[],
): number {
  const hand = state.players[asPlayer].hand
  const uniqueTiles = [...new Set(hand)]
  let best = 0
  for (const t of uniqueTiles) {
    const remaining = [...hand]
    const idx = remaining.indexOf(t)
    remaining.splice(idx, 1)
    if (calculateShanten(remaining) !== selfShanten) continue
    const u = calculateUkeire(remaining, visible)
    if (u > best) best = u
  }
  return best
}

export const DefenseFirst: Strategy = {
  name: 'defense-first',
  decide(state, actions, asPlayer) {
    // 1. Always take winning actions — defense doesn't override a real win.
    const win = actions.find(
      a => a.kind === ActionKind.Tsumo || a.kind === ActionKind.Ron,
    )
    if (win) return win

    // 2. Self riichi: hand is locked, fall back to default AI.
    if (state.players[asPlayer].riichi) {
      return defaultDecide(state, actions, 0, asPlayer)
    }

    // 3. Respond phase: in defense mode, refuse all Pon/Chi/Daiminkan;
    //    no threats → default behavior.
    if (state.phase === 'respond') {
      const threats = identifyThreats(state, asPlayer)
      if (threats.length === 0) {
        return defaultDecide(state, actions, 0, asPlayer)
      }
      const pass = actions.find(a => a.kind === ActionKind.Pass)
      return pass ?? defaultDecide(state, actions, 0, asPlayer)
    }

    // 4. Sanma chankita responders end up here in kita_declare phase. Take
    //    Ron if available (already handled above), else Pass.
    if (state.phase === 'kita_declare') {
      const pass = actions.find(a => a.kind === ActionKind.Pass)
      return pass ?? actions[0]
    }

    // 5. Discard phase: the heart of the strategy.
    const threats = identifyThreats(state, asPlayer)
    if (threats.length === 0) {
      return defaultDecide(state, actions, 0, asPlayer)
    }

    const hand = state.players[asPlayer].hand
    const selfShanten = calculateShanten(hand)
    const selfValue = estimatePoints(hand, state, asPlayer, 0)

    if (mustPush(state, asPlayer, selfShanten, selfValue)) {
      return defaultDecide(state, actions, 0, asPlayer)
    }

    const visible = getVisibleTiles(state, asPlayer)
    const selfUkeire = bestUkeireForCurrentShanten(state, asPlayer, selfShanten, visible)
    const level = classifyDefenseLevel(selfShanten, selfUkeire, selfValue)

    switch (level) {
      case 'push':
        return defaultDecide(state, actions, 0, asPlayer)
      case 'mawashi':
        return mawashiDiscard(state, actions, asPlayer, selfShanten)
      case 'betaori':
        return betaoriDiscard(state, actions, asPlayer)
    }
  },
}
