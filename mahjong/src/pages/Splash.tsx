import { useEffect, useState } from 'react'

import {
  fetchManifest,
  isManifestCached,
  type VersionManifest,
} from '../ml/model-cache'
import { loadModel } from '../ml/model-runtime'

interface Props {
  modelBaseUrl: string
  onCached: (m: VersionManifest) => void
  onNeedsDownload: (m: VersionManifest) => void
}

type State =
  | { kind: 'checking' }
  | { kind: 'initializing' }
  | { kind: 'error', message: string }

export default function Splash({ modelBaseUrl, onCached, onNeedsDownload }: Props) {
  const [state, setState] = useState<State>({ kind: 'checking' })

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const manifest = await fetchManifest(`${modelBaseUrl}/version.json`)
        if (cancelled) return

        const cached = await isManifestCached(manifest)
        if (cancelled) return

        if (!cached) {
          onNeedsDownload(manifest)
          return
        }

        // Cached path: model bytes are already in IndexedDB. Hand them to
        // onnxruntime-web so the Game screen has a ready session. Network is
        // skipped — only ORT compilation happens here.
        setState({ kind: 'initializing' })
        await loadModel(modelBaseUrl, manifest, () => {})
        if (cancelled) return
        onCached(manifest)
      } catch (err) {
        if (cancelled) return
        setState({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    })()
    return () => { cancelled = true }
  }, [modelBaseUrl, onCached, onNeedsDownload])

  return (
    <main className="screen splash">
      <h1>Mortal Mahjong</h1>
      {state.kind === 'checking' && <p className="subtitle">Checking model…</p>}
      {state.kind === 'initializing' && <p className="subtitle">Initializing AI…</p>}
      {state.kind === 'error' && (
        <>
          <p className="subtitle error">Could not reach model server.</p>
          <p className="detail">{state.message}</p>
        </>
      )}
    </main>
  )
}
