import type { Action, GameState, Player, TileType } from '../../game/types'
import { ActionKind } from '../../game/types'
import { tileToMjai } from './tile'
import type { MjaiEvent, MjaiTile } from './types'

/**
 * Stateful translator from TS engine state transitions to a stream of MJAI
 * events that libriichi.mjai.Bot can consume.
 *
 * Engine model (verify-worker loop):
 *   1. New round: `newRound()` returns state with phase='draw', hand=13 each,
 *      lastDrawnTile=null. We emit start_kyoku from this state.
 *   2. Pass in 'draw' phase → `advanceToDraw(dealer)` → phase='discard',
 *      dealer hand=14, lastDrawnTile=new tile. We emit tsumo.
 *   3. Discard / Riichi in 'discard' phase → phase='respond'. We emit dahai.
 *   4. Pass in 'respond' phase (no one called) → advanceToDraw(next) →
 *      phase='discard', next.hand=14, lastDrawnTile=new tile. tsumo.
 *   5. Pon/Chi in 'respond' → phase='discard', currentPlayer=caller,
 *      lastDrawnTile=null. We emit chi/pon; NO tsumo.
 *   6. Daiminkan in 'respond' → phase='discard', currentPlayer=caller,
 *      lastDrawnTile=rinshan. We emit daiminkan + dora (if revealed) + tsumo.
 *   7. Ankan/Kakan in 'discard' → phase='discard'/'respond', lastDrawnTile=rinshan
 *      (rinshan tsumo). We emit ankan/kakan + dora (if revealed) + tsumo.
 *   8. Tsumo/Ron in 'discard'/'respond' → phase='tsumo_win'/'ron_win'.
 *      We emit hora + end_kyoku.
 *   9. Wall exhaustion via advanceToDraw → phase='ryukyoku'. We emit
 *      ryukyoku + end_kyoku.
 *
 * The cleanest tsumo signal is wall-index change combined with
 * after.phase='discard'. That covers cases 2, 4. Cases 6/7 use
 * isKanRinshan to defer the tsumo after the kan + dora events.
 *
 * Limitations:
 *   - No `reach_accepted` (Bot tolerates absence).
 *   - Sanma (kita, no chi) intentionally rejected.
 *   - `ura_markers` omitted from hora.
 */
export class MjaiEmitter {
  private startedGame = false
  private kyokuKey = ''
  private lastDoraCount = 0
  private tsumoCount = 0
  private playerNames: string[]

  constructor(playerNames?: string[]) {
    this.playerNames = playerNames ?? ['p0', 'p1', 'p2', 'p3']
  }

  observeAction(before: GameState, action: Action, after: GameState): MjaiEvent[] {
    const events: MjaiEvent[] = []

    // 1) New game / new kyoku detection
    if (!this.startedGame) {
      events.push({
        type: 'start_game',
        names: this.playerNames.slice(0, before.playerCount),
        kyoku_first: 0,
        aka_flag: true,
      })
      this.startedGame = true
    }
    // kyotaku changes WITHIN a kyoku (every riichi declaration), so it can't
    // be part of the boundary key. roundNumber + honba is the kyoku identity.
    const key = `${before.roundNumber}-${before.honba}`
    if (key !== this.kyokuKey) {
      this.kyokuKey = key
      events.push(this.buildStartKyoku(before))
      this.lastDoraCount = before.doraMarkers.length
    }

    // 2) Pre/post-action tsumo. A tile was drawn from the wall iff either
    //    the live-wall index or the rinshan (dead-wall) index advanced.
    //    Using indices instead of "lastDrawnTile changed" avoids the silent
    //    miss when consecutive players coincidentally draw the same tile
    //    ID — `before.lastDrawnTile === after.lastDrawnTile` for two
    //    distinct draws is rare per turn but compounds across a hanchan.
    //
    //    PLACEMENT of the tsumo event depends on the action:
    //      - Pass in draw/respond → the tsumo IS the transition; emit BEFORE
    //        the (no-op) action.
    //      - Ankan/Kakan → emit AFTER ankan + dora, since the rinshan draw
    //        is a side effect of the kan action.
    const liveDraw = after.wallIndex !== before.wallIndex
    const rinshanDraw = after.rinshanIndex !== before.rinshanIndex
    const isKanRinshan =
      action.kind === ActionKind.Ankan || action.kind === ActionKind.Kakan || action.kind === ActionKind.Daiminkan
    // Normal tsumos require after.phase === 'discard' so we don't fire on
    // unrelated wall-index changes (e.g. ryukyoku). Kan-rinshan tsumos
    // however happen even when the engine immediately enters the chankan
    // respond phase after applyKakan — the rinshan draw is real and the
    // bot needs the tsumo event to track its hand. So allow phase === 'respond'
    // for kan-rinshan specifically.
    const drewNewTile =
      (liveDraw || rinshanDraw) &&
      after.lastDrawnTile !== null &&
      (after.phase === 'discard' || (isKanRinshan && after.phase === 'respond'))
    const tsumoEvent: MjaiEvent | null = drewNewTile
      ? { type: 'tsumo', actor: after.currentPlayer, pai: tileToMjai(after.lastDrawnTile!) }
      : null

    if (tsumoEvent) {
      this.tsumoCount++
      if (!isKanRinshan) events.push(tsumoEvent)
    }

    // 3) Action-specific event
    events.push(...this.translateAction(before, action, after))

    // 4) New dora indicator (after a kan reveals it)
    if (after.doraMarkers.length > this.lastDoraCount) {
      for (let i = this.lastDoraCount; i < after.doraMarkers.length; i++) {
        events.push({ type: 'dora', dora_marker: tileToMjai(after.doraMarkers[i]!) })
      }
      this.lastDoraCount = after.doraMarkers.length
    }

    // 4b) Rinshan tsumo comes after the kan + dora reveal.
    if (tsumoEvent && isKanRinshan) events.push(tsumoEvent)

    // 5) Kyoku end: detect win / ryukyoku transitions, emit end_kyoku.
    //    Game-over is handled separately by the caller via emitEndGame().
    if (
      after.phase === 'tsumo_win' ||
      after.phase === 'ron_win' ||
      after.phase === 'ryukyoku'
    ) {
      if (this.tsumoCount > 70) {
        process.stderr.write(
          `MjaiEmitter WARNING: tsumo_count=${this.tsumoCount} > 70 at end_kyoku ` +
          `(round=${before.roundNumber} honba=${before.honba})\n`,
        )
      }
      events.push({ type: 'end_kyoku' })
      // Force next observeAction to re-emit start_kyoku
      this.kyokuKey = ''
      this.lastDoraCount = 0
      this.tsumoCount = 0
    } else if (after.phase === 'game_over') {
      events.push({ type: 'end_kyoku' })
      events.push({ type: 'end_game', scores: after.players.map(p => p.score) })
    }

    return events
  }

  private buildStartKyoku(state: GameState): MjaiEvent {
    // newRound's state: phase='draw', hand=13 each, lastDrawnTile=null.
    // If we somehow get called with a partially-played state, fall back
    // gracefully (skip the dealer subtraction).
    const tehais: MjaiTile[][] = state.players.map((p, idx) => {
      const hand = [...p.hand]
      if (
        idx === state.dealer &&
        state.lastDrawnTile !== null &&
        hand.length === 14
      ) {
        const i = hand.indexOf(state.lastDrawnTile)
        if (i >= 0) hand.splice(i, 1)
      }
      return hand.map(tileToMjai)
    })
    const bakaze = state.roundNumber <= 4 ? 'E' : 'S'
    const kyoku = ((state.roundNumber - 1) % 4) + 1
    return {
      type: 'start_kyoku',
      bakaze,
      dora_marker: tileToMjai(state.doraMarkers[0]!),
      kyoku,
      honba: state.honba,
      kyotaku: state.kyotaku,
      oya: state.dealer,
      scores: state.players.map(p => p.score),
      tehais,
    }
  }

  private translateAction(
    before: GameState,
    action: Action,
    after: GameState,
  ): MjaiEvent[] {
    const discardActor = before.currentPlayer
    const callTarget = before.lastDiscardPlayer ?? discardActor
    // For respond-phase calls (pon/chi/daiminkan/ron), the actor is the
    // RESPONDER, not the discarder. After applyAction, after.currentPlayer
    // is the caller (for non-ron) or the winner (for ron).
    const callActor = after.currentPlayer
    switch (action.kind) {
      case ActionKind.Discard: {
        const tsumogiri = before.lastDrawnTile === action.tile
        return [{ type: 'dahai', actor: discardActor, pai: tileToMjai(action.tile), tsumogiri }]
      }
      case ActionKind.Riichi: {
        const tsumogiri = before.lastDrawnTile === action.tile
        // TS engine commits the riichi immediately on applyRiichi (kyotaku
        // +=1, score -=1000), so the MJAI reach_accepted event reflects
        // the state that's already in `after`. If a subsequent ron occurs
        // in respond phase, the hora event will move kyotaku back to the
        // winner — bot will reconcile via the deltas there.
        const deltas = after.players.map(
          (p, i) => p.score - before.players[i]!.score,
        )
        const scores = after.players.map(p => p.score)
        return [
          { type: 'reach', actor: discardActor },
          { type: 'dahai', actor: discardActor, pai: tileToMjai(action.tile), tsumogiri },
          { type: 'reach_accepted', actor: discardActor, deltas, scores },
        ]
      }
      case ActionKind.Chi: {
        return [
          {
            type: 'chi',
            actor: callActor,
            target: callTarget,
            pai: tileToMjai(action.called),
            consumed: action.tiles.map(tileToMjai),
          },
        ]
      }
      case ActionKind.Pon: {
        return [
          {
            type: 'pon',
            actor: callActor,
            target: callTarget,
            pai: tileToMjai(action.called),
            consumed: [tileToMjai(action.called), tileToMjai(action.called)],
          },
        ]
      }
      case ActionKind.Daiminkan: {
        return [
          {
            type: 'daiminkan',
            actor: callActor,
            target: callTarget,
            pai: tileToMjai(action.called),
            consumed: [
              tileToMjai(action.called),
              tileToMjai(action.called),
              tileToMjai(action.called),
            ],
          },
        ]
      }
      case ActionKind.Ankan: {
        const t = tileToMjai(action.tile)
        return [{ type: 'ankan', actor: discardActor, consumed: [t, t, t, t] }]
      }
      case ActionKind.Kakan: {
        const t = tileToMjai(action.tile)
        return [{ type: 'kakan', actor: discardActor, pai: t, consumed: [t, t, t] }]
      }
      case ActionKind.Tsumo: {
        const deltas = after.players.map((p, i) => p.score - before.players[i]!.score)
        return [{ type: 'hora', actor: discardActor, target: discardActor, deltas }]
      }
      case ActionKind.Ron: {
        const deltas = after.players.map((p, i) => p.score - before.players[i]!.score)
        return [
          {
            type: 'hora',
            actor: callActor,
            target: before.lastDiscardPlayer ?? discardActor,
            deltas,
          },
        ]
      }
      case ActionKind.Kyushukyuhai: {
        const deltas = after.players.map((p, i) => p.score - before.players[i]!.score)
        return [{ type: 'ryukyoku', deltas }]
      }
      case ActionKind.Pass: {
        // Pass that triggers wall-out ryukyoku: detect via after.phase
        if (after.phase === 'ryukyoku') {
          const deltas = after.players.map((p, i) => p.score - before.players[i]!.score)
          return [{ type: 'ryukyoku', deltas }]
        }
        return []
      }
      case ActionKind.Kita:
        return []
    }
  }
}

/** Convert a model's MJAI reaction back into a TS Action. */
export function mjaiReactionToAction(
  reaction: { type: string; pai?: MjaiTile; consumed?: MjaiTile[]; actor?: number },
  legalActions: Action[],
): Action | null {
  const find = (kind: ActionKind, predicate: (a: Action) => boolean) =>
    legalActions.find(a => a.kind === kind && predicate(a)) ?? null
  // Strip aka 'r' suffix for matching — the engine's TileType is unaka'd,
  // so tileToMjai(tile) gives "5m" while the model may output "5mr".
  const stripR = (s?: string) => s?.endsWith('r') ? s.slice(0, -1) : s
  switch (reaction.type) {
    case 'dahai':
      return find(ActionKind.Discard, a => 'tile' in a && tileToMjai(a.tile as TileType) === stripR(reaction.pai))
    case 'reach':
      return legalActions.find(a => a.kind === ActionKind.Riichi) ?? null
    case 'chi': {
      const wantConsumed = (reaction.consumed ?? []).slice().sort().join(',')
      return (
        legalActions.find(a =>
          a.kind === ActionKind.Chi &&
          tileToMjai(a.called) === stripR(reaction.pai) &&
          a.tiles.map(tileToMjai).sort().join(',') === wantConsumed,
        ) ?? null
      )
    }
    case 'pon':
      return find(ActionKind.Pon, a =>
        a.kind === ActionKind.Pon && tileToMjai(a.called) === stripR(reaction.pai),
      )
    case 'daiminkan':
      return find(ActionKind.Daiminkan, a =>
        a.kind === ActionKind.Daiminkan && tileToMjai(a.called) === stripR(reaction.pai),
      )
    case 'ankan':
      return find(ActionKind.Ankan, a => a.kind === ActionKind.Ankan)
    case 'kakan':
      return find(ActionKind.Kakan, a =>
        a.kind === ActionKind.Kakan && tileToMjai(a.tile) === stripR(reaction.pai),
      )
    case 'hora':
      return (
        legalActions.find(a => a.kind === ActionKind.Tsumo) ??
        legalActions.find(a => a.kind === ActionKind.Ron) ??
        null
      )
    case 'ryukyoku':
      // MJAI uses `ryukyoku` for voluntary draw declarations. In our action
      // set the only voluntary draw is 九種九牌 (kyushukyuhai).
      return legalActions.find(a => a.kind === ActionKind.Kyushukyuhai) ?? null
    case 'none':
      return legalActions.find(a => a.kind === ActionKind.Pass) ?? null
    default:
      return null
  }
}
