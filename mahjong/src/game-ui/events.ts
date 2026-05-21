/**
 * Game animation event bus. Pure pub-sub with no built-in handlers — when we
 * later add a real animation layer (character sprite swaps, tile-flying
 * tweens, score tickers) it subscribes here. Phase A keeps this empty so the
 * call sites can be wired up early and the implementation slotted in later.
 */

import type { Pai } from './types'

export type GameEvent =
  | { type: 'discard',     actor: 0 | 1 | 2 | 3, pai: Pai, tsumogiri: boolean }
  | { type: 'tsumo',       actor: 0 | 1 | 2 | 3, pai: Pai }
  | { type: 'chi',         actor: 0 | 1 | 2 | 3, target: 0 | 1 | 2 | 3, pai: Pai }
  | { type: 'pon',         actor: 0 | 1 | 2 | 3, target: 0 | 1 | 2 | 3, pai: Pai }
  | { type: 'kan',         actor: 0 | 1 | 2 | 3, kind: 'minkan' | 'ankan' | 'kakan' }
  | { type: 'riichi',      actor: 0 | 1 | 2 | 3 }
  | { type: 'hora',        actor: 0 | 1 | 2 | 3, target: 0 | 1 | 2 | 3, points: number }
  | { type: 'ryukyoku' }
  | { type: 'kyoku-start', bakaze: 0 | 1 | 2 | 3, kyoku: number, honba: number }
  | { type: 'kyoku-end' }

type Listener = (e: GameEvent) => void

const listeners = new Set<Listener>()

export const gameEvents = {
  on(fn: Listener): () => void {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
  emit(e: GameEvent): void {
    for (const fn of listeners) {
      try { fn(e) } catch (err) { console.error('[gameEvents]', err) }
    }
  },
}
