/** Tile type index: 0-8 man, 9-17 pin, 18-26 sou, 27-33 honors */
export type TileType = number

/** Wind: 0=East, 1=South, 2=West, 3=North */
export type Wind = 0 | 1 | 2 | 3

/** Player index: 0-3 */
export type Player = 0 | 1 | 2 | 3

export const Suit = {
  Man: 0,
  Pin: 1,
  Sou: 2,
  Honor: 3,
} as const
export type Suit = typeof Suit[keyof typeof Suit]

export const ActionKind = {
  Discard: 'discard',
  Chi: 'chi',
  Pon: 'pon',
  Ankan: 'ankan',
  Kakan: 'kakan',
  Daiminkan: 'daiminkan',
  Riichi: 'riichi',
  Tsumo: 'tsumo',
  Ron: 'ron',
  Pass: 'pass',
  Kyushukyuhai: 'kyushukyuhai',
  /** 3-player only: declare 抜き北 (kita). The drawn North tile is set
   *  aside, +1 han at win, and the player draws a replacement from the
   *  dead wall. */
  Kita: 'kita',
} as const
export type ActionKind = typeof ActionKind[keyof typeof ActionKind]

export type Action =
  | { kind: ActionKind.Discard; tile: TileType }
  | { kind: ActionKind.Chi; tiles: [TileType, TileType]; called: TileType; useAka?: boolean }
  | { kind: ActionKind.Pon; called: TileType }
  | { kind: ActionKind.Ankan; tile: TileType }
  | { kind: ActionKind.Kakan; tile: TileType }
  | { kind: ActionKind.Daiminkan; called: TileType }
  | { kind: ActionKind.Riichi; tile: TileType }
  | { kind: ActionKind.Tsumo }
  | { kind: ActionKind.Ron; called: TileType }
  | { kind: ActionKind.Pass }
  | { kind: ActionKind.Kyushukyuhai }
  | { kind: ActionKind.Kita }

export type MeldType = 'chi' | 'pon' | 'ankan' | 'kakan' | 'daiminkan'

export interface Meld {
  type: MeldType
  tiles: TileType[]
  calledFrom: Player
}

export interface DiscardEntry {
  tile: TileType
  tsumogiri: boolean
}

export interface PlayerState {
  hand: TileType[]
  melds: Meld[]
  discards: DiscardEntry[]
  riichi: boolean
  riichiTurn: number
  score: number
  isMenzen: boolean
  /**
   * Number of north tiles this player has set aside via 抜き北.
   * Always 0 in 4-player mode. In 3-player (sanma), each kita counts as +1
   * han at win time and 4 kita is yakuman (四北).
   */
  kitaCount: number
  /**
   * Number of aka-dora (赤ドラ / red 5) tiles currently owned in hand + melds.
   * Each aka counts as +1 han at win time. Maintained by the engine on
   * draws/discards/calls so countDora can read it directly. External
   * replays (replay-mjai) also write this field from mjai's `5mr`/`5pr`/
   * `5sr` notation.
   */
  akaCount?: number
  /**
   * Which aka tile kinds (4=5m, 13=5p, 22=5s) are currently in the
   * CONCEALED hand. Disjoint from akaInMelds. Used by the discard
   * heuristic (prefer regular over aka when both copies exist) and by
   * meld-transition logic (chi/pon/kan move aka into akaInMelds when
   * the consumed slot is forced to be the aka copy).
   */
  akaInHand?: TileType[]
  /**
   * Which aka tile kinds are locked into open melds (or ankan). Once
   * here, they stay through to scoring.
   */
  akaInMelds?: TileType[]
  /**
   * Double-riichi (W立直 / daburii) flag. Set true when this player declared
   * riichi on their FIRST own discard with no chi/pon/kan calls having
   * happened anywhere in the kyoku. Daburii is worth 2 han and replaces
   * the regular `riichi` yaku (it does not stack on top of it). Locked at
   * riichi-declaration time and persists through scoring even if calls
   * happen later in the hand. Default false; legacy callers may omit.
   */
  daburii?: boolean
}

export type GamePhase =
  | 'init'
  | 'draw'
  | 'discard'
  | 'respond'
  | 'riichi_declare'
  | 'ankan_draw'
  | 'kakan_draw'
  /** Sanma only: player drew North; opponents may chankita-ron, otherwise
   *  the engine declares kita and draws a replacement. */
  | 'kita_declare'
  | 'tsumo_win'
  | 'ron_win'
  | 'ryukyoku'
  | 'round_end'
  | 'game_over'

export interface GameState {
  /** 3 = sanma (no chi, no 2m-8m, kita declarations); 4 = standard yonma */
  playerCount: 3 | 4
  /**
   * Total rounds in this match. 4 = east-only (東風); 8 = east+south (半庄).
   * Both are valid for both yonma and sanma; default 8.
   */
  endRound: number
  wall: TileType[]
  wallIndex: number
  rinshanIndex: number
  /** Positions in `wall` that are aka-dora (one per 5m/5p/5s in yonma). */
  akaPositions?: Set<number>
  doraMarkers: TileType[]
  /** Length matches playerCount (3 or 4). */
  players: PlayerState[]
  currentPlayer: Player
  dealer: Player
  roundWind: Wind
  roundNumber: number
  honba: number
  kyotaku: number
  phase: GamePhase
  turnCount: number
  lastDiscard: TileType | null
  lastDiscardPlayer: Player | null
  lastDrawnTile: TileType | null
  ippatsu: boolean
  /**
   * True when the current actor's `lastDrawnTile` was drawn from the
   * dead-wall (rinshan) — i.e. the immediately preceding action was
   * ankan / kakan / daiminkan. A subsequent Tsumo win is then rinshan
   * kaihou (嶺上開花, 1 han). Cleared on the next discard.
   */
  atRinshan?: boolean
  /** Tiles forbidden to discard this turn due to kuikae (食替) rule.
   *  Set after chi/pon, cleared on next discard. */
  kuikae?: TileType[]
  /**
   * Non-null exactly while the engine is in the chankan (槍槓) respond
   * window opened by an applyKakan call. Opponents may declare Ron on
   * `tile`; after they all pass, the engine returns to discard phase with
   * `kaker` as currentPlayer (no extra wall draw, no chi/pon/daiminkan
   * options). Cleared when the respond window closes.
   */
  chankan?: { tile: TileType; kaker: Player } | null
  /**
   * 包牌 (pao / sekininbarai) target for the current hand.
   * Set when a pon/daiminkan call completes a deterministic yakuman condition:
   * - 大三元: player already has pon of 2 dragon types, and pons the 3rd →
   *   paoTarget = the player whose discard was taken for the 3rd pon.
   * - 大四喜: player already has pon of 3 wind types, and pons the 4th →
   *   paoTarget = the player whose discard was taken for the 4th pon.
   * If the yakuman winner wins by tsumo, paoTarget pays the full amount
   * (dealer pays for both themselves and the other children, or a single
   * child pays for everyone). Cleared at start of each new kyoku.
   * Null or undefined when no pao is active.
   */
  paoTarget?: Player | null
  /**
   * If true, classical yaku (古役) are enabled. Currently this only affects
   * 大七星 (字一色 + 七対 → W役満 instead of plain 字一色). Mahjong Soul's
   * default ruleset disables 古役 entirely. Note: 純正九蓮宝燈 is NOT a 古役
   * — it is detected unconditionally.
   */
  koyakuMode: boolean
  /**
   * If true, 三家和 (triple ron) is an abortive draw. When 3 players can all
   * declare ron on the same discard, the hand is voided instead. Off by
   * default — Mahjong Soul does not use this rule.
   */
  sanwahou: boolean
}
