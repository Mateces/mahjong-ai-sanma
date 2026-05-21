import '../game-ui/game-ui.css'
import Tile from '../game-ui/Tile'
import type { Pai } from '../game-ui/types'

const SUITS: { label: string; tiles: Pai[] }[] = [
  { label: '萬子', tiles: ['1m','2m','3m','4m','5m','5mr','6m','7m','8m','9m'] },
  { label: '筒子', tiles: ['1p','2p','3p','4p','5p','5pr','6p','7p','8p','9p'] },
  { label: '索子', tiles: ['1s','2s','3s','4s','5s','5sr','6s','7s','8s','9s'] },
  { label: '字牌', tiles: ['E','S','W','N','P','F','C'] },
  { label: '其他', tiles: ['back'] },
]

export default function TileGallery({ onExit }: { onExit: () => void }) {
  return (
    <div style={{ padding: 24, maxWidth: 800, margin: '0 auto' }}>
      <button onClick={onExit} style={{ marginBottom: 16 }}>← Back</button>
      <h1>牌面一览</h1>
      {SUITS.map(({ label, tiles }) => (
        <section key={label} style={{ marginBottom: 24 }}>
          <h2>{label}</h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {tiles.map(pai => (
              <div key={pai} style={{ textAlign: 'center' }}>
                <Tile pai={pai} size="hand" />
                <div style={{ fontSize: 11, marginTop: 2 }}>{pai}</div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
