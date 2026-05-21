import { useEffect, useState } from 'react'

import type { VersionManifest } from '../ml/model-cache'
import { loadModel, type LoadProgress } from '../ml/model-runtime'

interface Props {
  modelBaseUrl: string
  manifest: VersionManifest
  onReady: () => void
  onError: (msg: string) => void
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function stageLabel(stage: LoadProgress['stage']): string {
  switch (stage) {
    case 'graph': return 'Downloading graph'
    case 'data': return 'Downloading weights'
    case 'compile': return 'Initializing inference engine'
  }
}

export default function Download({ modelBaseUrl, manifest, onReady, onError }: Props) {
  const [started, setStarted] = useState(false)
  const [progress, setProgress] = useState<LoadProgress | null>(null)

  useEffect(() => {
    if (!started) return
    let cancelled = false
    loadModel(modelBaseUrl, manifest, (p) => {
      if (!cancelled) setProgress(p)
    }).then(() => {
      if (!cancelled) onReady()
    }).catch((err: unknown) => {
      if (!cancelled) onError(err instanceof Error ? err.message : String(err))
    })
    return () => { cancelled = true }
  }, [started, modelBaseUrl, manifest, onReady, onError])

  const pct = progress && progress.total > 0
    ? Math.min(100, (progress.loaded / progress.total) * 100)
    : 0

  return (
    <main className="screen download">
      <h2>Model download</h2>
      <p className="subtitle">{manifest.label}</p>

      {!started && (
        <>
          <p className="detail">
            First launch needs ~45 MB. After download the model lives in your browser
            and runs locally — no network needed for gameplay.
          </p>
          <button className="primary" onClick={() => setStarted(true)}>
            Download (~45 MB)
          </button>
        </>
      )}

      {started && (
        <>
          <p className="stage">{progress ? stageLabel(progress.stage) : 'Starting…'}</p>
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <p className="progress-text">
            {progress && progress.total > 0
              ? `${formatMb(progress.loaded)} / ${formatMb(progress.total)}`
              : progress
                ? `${formatMb(progress.loaded)}`
                : ''}
          </p>
        </>
      )}
    </main>
  )
}
