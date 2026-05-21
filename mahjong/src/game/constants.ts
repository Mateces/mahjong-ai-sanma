export const MAN_START = 0
export const MAN_END = 8
export const PIN_START = 9
export const PIN_END = 17
export const SOU_START = 18
export const SOU_END = 26
export const HONOR_START = 27
export const HONOR_END = 33

export const WIND_START = 27
export const WIND_END = 30
export const DRAGON_START = 31
export const DRAGON_END = 33

export const ALL_TILES: number[] = []
for (let i = 0; i < 34; i++) ALL_TILES.push(i)

export const TERMINALS = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33]

export const TILE_COUNT_PER_TYPE = 4
export const TOTAL_TILES = 136
export const HAND_SIZE = 13
export const WINNING_HAND_SIZE = 14

export const STARTING_SCORE_YONMA = 25000
export const STARTING_SCORE_SANMA = 35000

/** Honba payment per honba per loser in a ron settlement. */
export const HONBA_RON = 300
/** Honba payment per honba per non-winner in a tsumo settlement. */
export const HONBA_TSUMO = 100
/** Value of one riichi stick on the table. */
export const KYOTAKU_VALUE = 1000
/** Total points moved between tenpai and noten players in ryukyoku settlement. */
export const RYUKYOKU_TENPAI_TOTAL = 3000

export const MANGAN_BASIC = 8000
export const HANEMAN_BASIC = 12000
export const BAIMAN_BASIC = 16000
export const SANBAIMAN_BASIC = 24000
export const YAKUMAN_BASIC = 32000
