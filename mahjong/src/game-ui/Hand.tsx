import Tile from './Tile'
import type { Pai } from './types'

export type DiscardSource = { type: 'hand', pai: Pai } | { type: 'tsumo' }

interface Props {
  tiles: Pai[]
  tsumo: Pai | null
  visible: boolean
  onDiscard?: (src: DiscardSource) => void
}

export default function Hand({ tiles, tsumo, visible, onDiscard }: Props) {
  const size = visible ? 'hand' : 'opponent'
  return (
    <div className="hand">
      <div className="hand-tiles">
        {tiles.map((t, i) => (
          <Tile
            key={i}
            pai={visible ? t : '?'}
            size={size}
            rotation={0}
            onClick={onDiscard && visible ? () => onDiscard({ type: 'hand', pai: t }) : undefined}
          />
        ))}
      </div>
      {tsumo !== null && (
        <div className="hand-tsumo">
          <Tile
            pai={visible ? tsumo : '?'}
            size={size}
            rotation={0}
            onClick={onDiscard && visible ? () => onDiscard({ type: 'tsumo' }) : undefined}
          />
        </div>
      )}
    </div>
  )
}
