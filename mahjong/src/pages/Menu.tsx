import type { VersionManifest } from '../ml/model-cache'

interface Props {
  manifest: VersionManifest
  onPlay: () => void
}

export default function Menu({ manifest, onPlay }: Props) {
  return (
    <main className="screen menu">
      <h1>Mortal Mahjong</h1>
      <p className="subtitle">Model ready · runs locally</p>

      <button className="primary" onClick={onPlay}>Play vs AI</button>

      <p className="version">v{manifest.version}</p>
    </main>
  )
}
