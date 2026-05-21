/**
 * View-model types the UI components consume. Decoupled from libriichi's wire
 * representation so we can render hardcoded demo states before the engine is
 * wired in. The orchestrator (later) maps from libriichi PlayerState to these.
 */

// MJAI-style tile string. Numbered suits: "1m".."9m", "1p".."9p", "1s".."9s".
// Aka 5: "0m" / "0p" / "0s". Honors: "E" "S" "W" "N" "P" (haku/white) "F"
// (hatsu/green) "C" (chun/red). Tile back / hidden: "?"
export type Pai = string

export interface MeldView {
  /** Kind of meld. */
  kind: 'chi' | 'pon' | 'minkan' | 'ankan' | 'kakan'
  /** Tiles in display order, left to right as they appear in the meld slot. */
  tiles: Pai[]
  /** Index into `tiles` of the called tile (the one taken from another seat).
   * Used to render the rotated/highlighted called tile. -1 for ankan. */
  calledIndex: number
}

export interface DiscardEntry {
  pai: Pai
  /** True when the tile was a direct tsumogiri (drew, immediately discarded). */
  tsumogiri: boolean
  /** True when the discard was the riichi-declaring tile (rendered rotated). */
  riichi: boolean
  /** True when the tile was later called by another seat (visually faded). */
  called: boolean
}

export interface SeatView {
  /** Absolute seat id 0..3 (libriichi order). */
  seatId: 0 | 1 | 2 | 3
  /** Visible hand. For seats other than `me`, pass an array of "?" of the
   * right length so opponents render as tile backs. */
  hand: Pai[]
  /** Last drawn tile, rendered slightly separated from the rest of the hand. */
  tsumo: Pai | null
  /** Discard pile in chronological order. */
  river: DiscardEntry[]
  /** Called sets, displayed to the side. */
  melds: MeldView[]
  /** Current points (e.g., 25000). */
  score: number
  /** Seat wind: 0=E,1=S,2=W,3=N. */
  seatWind: 0 | 1 | 2 | 3
  /** True when seat has declared riichi. */
  riichi: boolean
  /** Character-portrait state for the placeholder slot. */
  mood: 'idle' | 'tense' | 'happy' | 'shocked'
}

export interface GameView {
  /** The seat the local player is occupying. UI rotates so this seat is at
   * the bottom of the screen. */
  me: 0 | 1 | 2 | 3
  /** Per-seat state, indexed by absolute seat id. */
  seats: [SeatView, SeatView, SeatView, SeatView]
  /** Round wind: 0=E, 1=S, etc. Combined with `kyoku` for display: E1, E2, ... */
  bakaze: 0 | 1 | 2 | 3
  /** Kyoku number 1..4 (or 1..4 per round in tonpuusen). */
  kyoku: number
  /** Honba (extension counter), shown next to kyoku. */
  honba: number
  /** Kyotaku (riichi sticks deposited from previous draws). */
  kyotaku: number
  /** Wall tiles remaining (decremented each tsumo). 0..70 typically. */
  wallRemaining: number
  /** Visible dora indicators. */
  doraIndicators: Pai[]
  /** When set, indicates whose turn it is (for visual emphasis). */
  activeSeat: 0 | 1 | 2 | 3 | null
}

/** Convert an absolute seat id to its layout slot relative to `me`.
 *  Counterclockwise: 下家(diff=1)=right, 对家(diff=2)=top, 上家(diff=3)=left. */
export function relativeSlot(me: 0 | 1 | 2 | 3, seat: 0 | 1 | 2 | 3): 'bottom' | 'left' | 'top' | 'right' {
  const diff = (seat - me + 4) % 4
  return (['bottom', 'right', 'top', 'left'] as const)[diff]
}

/** CSS rotation for a slot. Everything renders as "bottom" then rotates. */
export function slotAngle(slot: 'bottom' | 'left' | 'top' | 'right'): number {
  return ({ bottom: 0, left: 90, top: 180, right: -90 })[slot]
}
