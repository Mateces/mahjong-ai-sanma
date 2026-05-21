import type { SeatView } from './types'

interface Props {
  seat: SeatView
}

const WIND_LABEL = ['東', '南', '西', '北'] as const

/**
 * Placeholder slot for the seat's character portrait + status. Phase A renders
 * a labeled colored block. The interface is stable: later we slot in a real
 * sprite, and `mood` drives frame selection / animation.
 */
export default function CharacterSlot({ seat }: Props) {
  return (
    <div className={`character-slot character-mood-${seat.mood}`}>
      <div className="character-portrait" aria-label={`P${seat.seatId} character`}>
        <span>P{seat.seatId}</span>
      </div>
      <div className="character-meta">
        <span className="character-wind">{WIND_LABEL[seat.seatWind]}</span>
        <span className="character-score">{seat.score.toLocaleString()}</span>
        {seat.riichi && <span className="character-riichi">立直</span>}
      </div>
    </div>
  )
}
