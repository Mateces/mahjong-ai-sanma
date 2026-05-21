import CharacterSlot from './CharacterSlot'
import Hand from './Hand'
import type { DiscardSource } from './Hand'
import Melds from './Melds'
import River from './River'
import { slotAngle } from './types'
import type { SeatView } from './types'

interface Props {
  seat: SeatView
  slot: 'bottom' | 'left' | 'top' | 'right'
  isMe: boolean
  active: boolean
  onDiscard?: (src: DiscardSource) => void
}

export default function PlayerArea({ seat, slot, isMe, active, onDiscard }: Props) {
  const angle = slotAngle(slot)
  return (
    <div className={`player-area player-area-${slot} ${active ? 'player-area-active' : ''}`}>
      <div className="player-inner" style={{ transform: `rotate(${angle}deg)` }}>
        <div className="player-river-row">
          <River entries={seat.river} />
        </div>
        <div className="player-hand-row">
          <CharacterSlot seat={seat} />
          <Hand
            tiles={seat.hand}
            tsumo={seat.tsumo}
            visible={isMe}
            onDiscard={isMe ? onDiscard : undefined}
          />
          <Melds melds={seat.melds} />
        </div>
      </div>
    </div>
  )
}
