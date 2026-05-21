import CenterInfo from './CenterInfo'
import River from './River'
import { relativeSlot, slotAngle } from './types'
import type { GameView } from './types'

interface Props {
  game: GameView
}

/**
 * The inner play area: 4 rivers radiating out from the center, plus the
 * round-info panel in the middle. Each river renders as bottom perspective
 * and is rotated via CSS transform.
 */
export default function PlayArea({ game }: Props) {
  const seatBySlot: Record<'bottom' | 'left' | 'top' | 'right', typeof game.seats[number] | null> = {
    bottom: null, left: null, top: null, right: null,
  }
  for (const s of game.seats) seatBySlot[relativeSlot(game.me, s.seatId)] = s

  return (
    <div className="play-area">
      {(['bottom', 'left', 'top', 'right'] as const).map((slot) => {
        const seat = seatBySlot[slot]
        if (!seat) return null
        return (
          <div key={slot} className={`river-slot river-slot-${slot}`}>
            <div className="river-wrap" style={{ transform: `rotate(${slotAngle(slot)}deg)` }}>
              <River entries={seat.river} />
            </div>
          </div>
        )
      })}
      <div className="play-center">
        <CenterInfo game={game} />
      </div>
    </div>
  )
}
