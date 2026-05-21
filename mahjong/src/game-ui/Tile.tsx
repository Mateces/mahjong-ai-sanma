import type { Pai } from './types'

export type Rotation = 0 | 90 | 180 | 270

interface Props {
  pai: Pai
  size?: 'hand' | 'opponent' | 'river' | 'meld'
  rotation?: Rotation
  dimmed?: boolean
  onClick?: () => void
}

function isAka(pai: Pai): boolean {
  return pai === '5mr' || pai === '5pr' || pai === '5sr'
}

function tileUrl(pai: Pai): string {
  const name = pai === '?' ? 'back' : pai
  return `/tiles/${name}.png`
}

const SWAPPED: Set<Rotation> = new Set([90, 270])

export default function Tile({ pai, size = 'hand', rotation = 0, dimmed = false, onClick }: Props) {
  const aka = isAka(pai)
  const swapped = SWAPPED.has(rotation)
  const className = [
    'tile',
    `tile-${size}`,
    aka && 'tile-aka',
    dimmed && 'tile-dimmed',
    onClick && 'tile-clickable',
  ].filter(Boolean).join(' ')

  return (
    <div className={className} style={swapped ? { width: 'var(--tile-h)', height: 'var(--tile-w)' } : undefined}>
      <div
        className={`tile-face tile-rot${rotation}`}
        onClick={onClick}
        role={onClick ? 'button' : undefined}
        aria-label={pai}
        style={{ backgroundImage: `url(${tileUrl(pai)})` }}
      />
    </div>
  )
}
