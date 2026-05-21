import { useCallback, useState } from 'react'

import Splash from './pages/Splash'
import Download from './pages/Download'
import Menu from './pages/Menu'
import Game from './pages/Game'
import TileGallery from './pages/TileGallery'
import Scenario from './pages/Scenario'
import type { VersionManifest } from './ml/model-cache'
import './App.css'

// In dev, the .onnx and .onnx.data files live under public/model/.
// In prod, this can point to a CDN/B2 URL.
const MODEL_BASE_URL = '/model'

type Screen =
  | { kind: 'splash' }
  | { kind: 'download', manifest: VersionManifest }
  | { kind: 'menu', manifest: VersionManifest }
  | { kind: 'game', manifest: VersionManifest }
  | { kind: 'gallery' }
  | { kind: 'scenario' }
  | { kind: 'scenario_game', hands: number[][], aka: number[][], wall: number[], script: import('./game/types').Action[][], startDealer?: 0|1|2|3 }

export default function App() {
  const [screen, setScreen] = useState<Screen>(() => {
    const hash = window.location.hash
    if (hash === '#gallery') return { kind: 'gallery' }
    if (hash === '#scenario') return { kind: 'scenario' }
    return { kind: 'splash' }
  })
  const [error, setError] = useState<string | null>(null)

  const handleCached = useCallback((manifest: VersionManifest) => {
    setError(null)
    setScreen({ kind: 'menu', manifest })
  }, [])

  const handleNeedsDownload = useCallback((manifest: VersionManifest) => {
    setError(null)
    setScreen({ kind: 'download', manifest })
  }, [])

  const handleDownloadReady = useCallback(() => {
    setScreen((prev) => prev.kind === 'download' ? { kind: 'menu', manifest: prev.manifest } : prev)
  }, [])

  const handlePlay = useCallback(() => {
    setScreen((prev) => prev.kind === 'menu' ? { kind: 'game', manifest: prev.manifest } : prev)
  }, [])

  const handleGameExit = useCallback(() => {
    setScreen((prev) => prev.kind === 'game' ? { kind: 'menu', manifest: prev.manifest } : prev)
  }, [])

  const handleError = useCallback((msg: string) => {
    setError(msg)
    setScreen({ kind: 'splash' })
  }, [])

  return (
    <>
      {screen.kind === 'splash' && (
        <Splash
          modelBaseUrl={MODEL_BASE_URL}
          onCached={handleCached}
          onNeedsDownload={handleNeedsDownload}
        />
      )}
      {screen.kind === 'download' && (
        <Download
          modelBaseUrl={MODEL_BASE_URL}
          manifest={screen.manifest}
          onReady={handleDownloadReady}
          onError={handleError}
        />
      )}
      {screen.kind === 'menu' && (
        <Menu manifest={screen.manifest} onPlay={handlePlay} />
      )}
      {screen.kind === 'game' && (
        <Game onExit={handleGameExit} />
      )}
      {screen.kind === 'gallery' && (
        <TileGallery onExit={() => setScreen({ kind: 'splash' })} />
      )}
      {screen.kind === 'scenario' && (
        <Scenario
          onPlay={(cfg) => setScreen({ kind: 'scenario_game', ...cfg })}
          onExit={() => setScreen({ kind: 'splash' })}
        />
      )}
      {screen.kind === 'scenario_game' && (
        <Game onExit={() => setScreen({ kind: 'scenario' })} fixedHands={screen.hands} fixedAka={screen.aka} fixedWall={screen.wall} scripts={screen.script} startDealer={screen.startDealer} />
      )}
      {error && <div className="error-banner">⚠ {error}</div>}
    </>
  )
}
