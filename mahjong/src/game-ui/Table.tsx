import { useEffect } from 'react'

import ActionBar from './ActionBar'
import CenterInfo from './CenterInfo'
import PlayerArea from './PlayerArea'
import type { DiscardSource } from './Hand'
import type { GameView } from './types'
import { relativeSlot } from './types'

interface Props {
  game: GameView
  onDiscard?: (src: DiscardSource) => void
  available?: ReadonlySet<'chi' | 'pon' | 'kan' | 'riichi' | 'ron' | 'tsumo' | 'pass'>
  onAction?: (k: 'chi' | 'pon' | 'kan' | 'riichi' | 'ron' | 'tsumo' | 'pass') => void
}

export default function Table({ game, onDiscard, available, onAction }: Props) {
  useEffect(() => {
    const so = screen.orientation as ScreenOrientation & { lock?: (s: string) => Promise<void> }
    so?.lock?.('landscape').catch(() => { /* not supported in this browser */ })
  }, [])

  return (
    <div className="table-root">
      <div className="table-board">
        {game.seats.map((s) => (
          <PlayerArea
            key={s.seatId}
            seat={s}
            slot={relativeSlot(game.me, s.seatId)}
            isMe={s.seatId === game.me}
            active={game.activeSeat === s.seatId}
            onDiscard={s.seatId === game.me ? onDiscard : undefined}
          />
        ))}
        <div className="table-center">
          <CenterInfo game={game} />
        </div>
      </div>
      <ActionBar available={available} onAction={onAction} />
    </div>
  )
}
