import Tile from './Tile'
import type { MeldView } from './types'

interface Props {
  melds: MeldView[]
}

/**
 * Called sets, always rendered as horizontal groups (bottom perspective).
 * The called tile is rotated +90° in place ("lies sideways"). Ankan shows
 * middle two tiles face-up, outer two face-down.
 */
export default function Melds({ melds }: Props) {
  return (
    <div className="melds">
      {melds.map((m, mi) => (
        <div key={mi} className="meld">
          {m.tiles.map((t, ti) => (
            <Tile
              key={ti}
              pai={m.kind === 'ankan' && (ti === 0 || ti === 3) ? '?' : t}
              size="meld"
              rotation={ti === m.calledIndex ? 90 : 0}
            />
          ))}
        </div>
      ))}
    </div>
  )
}
