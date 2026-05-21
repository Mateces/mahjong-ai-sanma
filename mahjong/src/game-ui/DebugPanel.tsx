import { useCallback, useRef, useState } from 'react'

const MAX_ENTRIES = 200

let logEntries: string[] = []
let listener: (() => void) | null = null

/** Append a debug log entry. Call from anywhere. */
export function debugLog(msg: string) {
  const ts = new Date().toLocaleTimeString('en-GB', { hour12: false, fractionalSecondDigits: 2 })
  logEntries.push(`[${ts}] ${msg}`)
  if (logEntries.length > MAX_ENTRIES) logEntries.shift()
  listener?.()
}

export default function DebugPanel() {
  const [open, setOpen] = useState(false)
  const [, forceUpdate] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)

  listener = () => { forceUpdate(n => n + 1) }

  const copy = useCallback(() => {
    navigator.clipboard.writeText(logEntries.join('\n'))
  }, [])

  const clear = useCallback(() => {
    logEntries = []
    forceUpdate(n => n + 1)
  }, [])

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{
          position: 'fixed', bottom: 8, right: 8, zIndex: 9999,
          padding: '4px 8px', fontSize: 11, opacity: 0.7,
        }}
      >
        🐛 Log
      </button>
    )
  }

  return (
    <div style={{
      position: 'fixed', bottom: 0, right: 0, width: 400, height: 300,
      background: '#111', color: '#0f0', fontSize: 11, fontFamily: 'monospace',
      zIndex: 9999, display: 'flex', flexDirection: 'column',
    }}>
      <div style={{ display: 'flex', gap: 4, padding: 4 }}>
        <button onClick={copy} style={{ fontSize: 11 }}>📋 Copy</button>
        <button onClick={clear} style={{ fontSize: 11 }}>🗑 Clear</button>
        <button onClick={() => setOpen(false)} style={{ fontSize: 11, marginLeft: 'auto' }}>✕</button>
      </div>
      <div ref={scrollRef} style={{ flex: 1, overflow: 'auto', padding: '0 4px' }}>
        {logEntries.map((line, i) => <div key={i}>{line}</div>)}
      </div>
    </div>
  )
}
