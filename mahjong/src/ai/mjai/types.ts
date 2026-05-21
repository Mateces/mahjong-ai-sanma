/**
 * MJAI protocol event types as emitted/consumed by libriichi.mjai.Bot.
 *
 * Reference: https://gimite.net/pukiwiki/index.php?Mjai%20%E9%BA%BB%E9%9B%80AI%E5%AF%BE%E6%88%A6%E3%82%B5%E3%83%BC%E3%83%90
 * and Mortal's libriichi/src/mjai/event.rs.
 *
 * Canonical MJAI is yonma-only. We extend with `kita` and `nukidora` for
 * sanma compatibility (compatible with kiraliu7/MortalSanma's libriichi3p
 * dialect — when we later target it, no protocol change is needed here).
 */

/** Tile in MJAI string form: "1m".."9m", "1p".."9p", "1s".."9s", "E", "S",
 *  "W", "N", "P" (haku), "F" (hatsu), "C" (chun). Red 5s suffix "r":
 *  "5mr"/"5pr"/"5sr". */
export type MjaiTile = string

export type MjaiEvent =
  | { type: 'start_game'; names: string[]; kyoku_first?: number; aka_flag?: boolean }
  | {
      type: 'start_kyoku'
      bakaze: 'E' | 'S' | 'W' | 'N'
      dora_marker: MjaiTile
      kyoku: number    // 1..4
      honba: number
      kyotaku: number
      oya: number      // 0..3
      scores: number[]
      tehais: MjaiTile[][]   // (4, 13) — only own seat's is real; others are '?'
    }
  | { type: 'tsumo'; actor: number; pai: MjaiTile }
  | { type: 'dahai'; actor: number; pai: MjaiTile; tsumogiri: boolean }
  | {
      type: 'chi'
      actor: number
      target: number
      pai: MjaiTile           // called tile
      consumed: MjaiTile[]    // length 2
    }
  | {
      type: 'pon'
      actor: number
      target: number
      pai: MjaiTile
      consumed: MjaiTile[]    // length 2
    }
  | {
      type: 'daiminkan'
      actor: number
      target: number
      pai: MjaiTile
      consumed: MjaiTile[]    // length 3
    }
  | { type: 'ankan'; actor: number; consumed: MjaiTile[] /* length 4 */ }
  | { type: 'kakan'; actor: number; pai: MjaiTile; consumed: MjaiTile[] /* length 3 */ }
  | { type: 'reach'; actor: number }
  | { type: 'reach_accepted'; actor: number; deltas: number[]; scores: number[] }
  | { type: 'dora'; dora_marker: MjaiTile }
  | {
      type: 'hora'
      actor: number
      target: number          // for tsumo, target == actor
      deltas: number[]
      ura_markers?: MjaiTile[]
    }
  | { type: 'ryukyoku'; deltas: number[] }
  | { type: 'end_kyoku' }
  | { type: 'end_game'; scores: number[] }
  | { type: 'none' }           // Bot's null response
  // ---- sanma extensions (libriichi3p / MortalSanma compatible) ----
  /** 抜き北: in 3p, declarer sets aside a North tile from hand as a free dora.
   *  Emitted when the engine resolves a kita declaration. */
  | { type: 'nukidora'; actor: number; pai: MjaiTile }
