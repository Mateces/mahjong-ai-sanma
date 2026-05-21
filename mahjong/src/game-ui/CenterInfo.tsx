import Tile from './Tile'
import type { GameView } from './types'

interface Props {
  game: GameView
}

const ROUND_KANJI = ['東', '南', '西', '北'] as const

/**
 * Centerpiece: round (bakaze + kyoku), honba, kyotaku, wall remaining, and
 * the dora indicators.
 */
export default function CenterInfo({ game }: Props) {
  return (
    <div className="center-info">
      <div className="round-line">
        <span className="round-name">{ROUND_KANJI[game.bakaze]}{game.kyoku}局</span>
        {game.honba > 0 && <span className="round-honba">{game.honba}本場</span>}
        {game.kyotaku > 0 && <span className="round-kyotaku">供託 {game.kyotaku}</span>}
      </div>
      <div className="wall-line">
        <span className="wall-count">残 {game.wallRemaining}</span>
      </div>
      <div className="dora-row">
        {game.doraIndicators.map((d, i) => (
          <Tile key={i} pai={d} size="meld" />
        ))}
        {/* Reveal future dora indicators as backs */}
        {Array.from({ length: 5 - game.doraIndicators.length }, (_, i) => (
          <Tile key={`back-${i}`} pai="?" size="meld" />
        ))}
      </div>
    </div>
  )
}
