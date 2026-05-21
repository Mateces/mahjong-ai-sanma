import CharacterSlot from './CharacterSlot'
import Hand from './Hand'
import Melds from './Melds'
import { slotAngle } from './types'
import type { SeatView } from './types'

interface Props {
  seat: SeatView
  /** Layout slot relative to local player. Drives rotation angle. */
  slot: 'bottom' | 'left' | 'top' | 'right'
  /** True for the local player's own seat (hand is face-up + clickable). */
  isMe: boolean
  /** Active turn highlight. */
  active: boolean
  onTileClick?: (i: number) => void
}

/**
 * One seat's outer strip — hand + melds + character slot. Content always
 * renders as bottom perspective; the seat-inner wrapper rotates via CSS
 * transform to position for the correct player.
 */
export default function Seat({ seat, slot, isMe, active, onTileClick }: Props) {
  return (
    <div className={`seat seat-${slot} ${active ? 'seat-active' : ''}`}>
      <div className="seat-inner" style={{ transform: `rotate(${slotAngle(slot)}deg)` }}>
        <CharacterSlot seat={seat} />
        <Hand
          tiles={seat.hand}
          tsumo={seat.tsumo}
          visible={isMe}
          onTileClick={isMe ? onTileClick : undefined}
        />
        <Melds melds={seat.melds} />
      </div>
    </div>
  )
}
