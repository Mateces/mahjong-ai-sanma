/**
 * Bottom action bar — shown when it's the local player's turn. Phase A
 * renders placeholder buttons (all disabled) so the layout shows. The
 * orchestrator will later supply the live `available` set and click handlers.
 */

interface Action {
  kind: 'riichi' | 'tsumo' | 'ron' | 'chi' | 'pon' | 'kan' | 'pass'
  label: string
}

const ALL_ACTIONS: readonly Action[] = [
  { kind: 'chi',    label: 'チー' },
  { kind: 'pon',    label: 'ポン' },
  { kind: 'kan',    label: 'カン' },
  { kind: 'riichi', label: 'リーチ' },
  { kind: 'ron',    label: 'ロン' },
  { kind: 'tsumo',  label: 'ツモ' },
  { kind: 'pass',   label: 'パス' },
]

interface Props {
  /** Whose actions are legal right now. Phase A: empty. */
  available?: ReadonlySet<Action['kind']>
  onAction?: (k: Action['kind']) => void
}

export default function ActionBar({ available, onAction }: Props) {
  const visible = ALL_ACTIONS.filter(a => available?.has(a.kind))
  if (visible.length === 0) return null

  return (
    <div className="action-bar">
      {visible.map((a) => (
        <button
          key={a.kind}
          className={`action-btn action-${a.kind}`}
          onClick={() => onAction?.(a.kind)}
        >
          {a.label}
        </button>
      ))}
    </div>
  )
}
