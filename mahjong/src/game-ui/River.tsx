import Tile from './Tile'
import type { DiscardEntry } from './types'

interface Props {
  entries: DiscardEntry[]
}

/**
 * One player's discard pile. Always renders as horizontal rows of 6,
 * left→right, wrapping downward (bottom perspective). Riichi tile is
 * rotated +90° relative to the player's POV.
 */
export default function River({ entries }: Props) {
  return (
    <div className="river">
      {entries.map((e, i) => (
        <Tile
          key={i}
          pai={e.pai}
          size="river"
          rotation={e.riichi ? 90 : 0}
          dimmed={e.called}
        />
      ))}
    </div>
  )
}
