import './game.css'
import '../game-ui/game-ui.css'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ActionKind } from '../game/types'
import type { Action, GameState, Player, TileType } from '../game/types'
import { gameStateToView } from '../game-ui/engine-to-view'
import { GameLoop, AiAgent, HumanAgent, ScriptedAgent } from '../game-ui/game-loop'
import type { HumanPendingDecision } from '../game-ui/game-loop'
import type { DiscardSource } from '../game-ui/Hand'
import type { GameView } from '../game-ui/types'
import { mjaiToTile, tileToMjai } from '../ai/mjai/tile'
import Table from '../game-ui/Table'
import DebugPanel, { debugLog } from '../game-ui/DebugPanel'

interface Props {
  onExit: () => void
  fixedHands?: number[][]
  fixedAka?: number[][]
  fixedWall?: number[]
  scripts?: Action[][]
  startDealer?: 0 | 1 | 2 | 3
}

const ME: Player = 0 as Player

type ActionBarKind = 'chi' | 'pon' | 'kan' | 'riichi' | 'ron' | 'tsumo' | 'pass'

function formatChoice(a: Action): string {
  if (a.kind === ActionKind.Chi) {
    const chi = a as { tiles: [TileType, TileType]; called: TileType; useAka?: boolean }
    const t0 = tileToMjai(chi.tiles[0])
    const t1 = tileToMjai(chi.tiles[1])
    if (chi.useAka === true) {
      // Mark which tile is the aka version
      const akaIdx = [4, 13, 22].includes(chi.tiles[0]) ? 0 : 1
      const parts = [t0, t1]
      parts[akaIdx] = parts[akaIdx]!.replace(/5/, '5赤')
      return `${parts[0]} ${parts[1]} + ${tileToMjai(chi.called)}`
    }
    if (chi.useAka === false) {
      return `${t0} ${t1} + ${tileToMjai(chi.called)}`
    }
    return `${t0} ${t1} + ${tileToMjai(chi.called)}`
  }
  if (a.kind === ActionKind.Riichi) {
    return `切 ${tileToMjai((a as { tile: TileType }).tile)}`
  }
  if (a.kind === ActionKind.Ankan || a.kind === ActionKind.Kakan) {
    return `${tileToMjai((a as { tile: TileType }).tile)} カン`
  }
  return a.kind
}

function actionsToBarKinds(actions: Action[]): Set<ActionBarKind> {
  const kinds = new Set<ActionBarKind>()
  for (const a of actions) {
    switch (a.kind) {
      case ActionKind.Chi: kinds.add('chi'); break
      case ActionKind.Pon: kinds.add('pon'); break
      case ActionKind.Ankan: case ActionKind.Kakan: case ActionKind.Daiminkan:
        kinds.add('kan'); break
      case ActionKind.Riichi: kinds.add('riichi'); break
      case ActionKind.Ron: kinds.add('ron'); break
      case ActionKind.Tsumo: kinds.add('tsumo'); break
      case ActionKind.Pass: kinds.add('pass'); break
    }
  }
  return kinds
}

export default function Game({ onExit, fixedHands, fixedAka, fixedWall, scripts, startDealer }: Props) {
  const [view, setView] = useState<GameView | null>(null)
  const [available, setAvailable] = useState<Set<ActionBarKind>>(new Set())
  const [phase, setPhase] = useState<string>('')
  const [choices, setChoices] = useState<Action[] | null>(null)
  const pendingRef = useRef<HumanPendingDecision | null>(null)
  const loopRef = useRef<GameLoop | null>(null)

  useEffect(() => {
    const human = new HumanAgent()
    human.onPending = (pending) => {
      pendingRef.current = pending
      if (pending) {
        // Show action buttons for respond phase
        if (pending.phase === 'respond') {
          setAvailable(actionsToBarKinds(pending.actions))
        } else {
          // Discard phase: show special actions (riichi/tsumo/kan) but player
          // can also just click a tile to discard
          const special = pending.actions.filter(a =>
            a.kind !== ActionKind.Discard && a.kind !== ActionKind.Pass)
          if (special.length > 0) {
            setAvailable(actionsToBarKinds(special))
          } else {
            setAvailable(new Set())
          }
        }
      } else {
        setAvailable(new Set())
      }
    }

    const loop = new GameLoop({
      playerCount: 4,
      endRound: 8,
      agents: [
        human,
        scripts?.[1]?.length ? new ScriptedAgent(scripts[1]) : new AiAgent(1 as Player, 0.3),
        scripts?.[2]?.length ? new ScriptedAgent(scripts[2]) : new AiAgent(2 as Player, 0.6),
        scripts?.[3]?.length ? new ScriptedAgent(scripts[3]) : new AiAgent(3 as Player, 1.0),
      ],
      onStateChange: (state: GameState) => {
        setView(gameStateToView(state, ME))
        setPhase(state.phase)
      },
      aiDelay: 300,
      fixedHands,
      fixedWall,
      fixedAka,
      startDealer,
    })

    loopRef.current = loop
    loop.start()

    return () => loop.stop()
  }, [])

  const handleDiscard = useCallback((src: DiscardSource) => {
    const pending = pendingRef.current
    debugLog(`handleDiscard: src=${JSON.stringify(src)} pending=${pending?.phase ?? 'null'}`)
    if (!pending || pending.phase !== 'discard') return

    let tile: TileType
    if (src.type === 'tsumo') {
      // Tsumo click = tsumogiri. Find the tsumo pai from the current view.
      const tsumoPai = view?.seats[ME]?.tsumo
      if (!tsumoPai || tsumoPai === '?') return
      tile = mjaiToTile(tsumoPai as never)
    } else {
      tile = mjaiToTile(src.pai as never)
    }

    const action = pending.actions.find(a =>
      a.kind === ActionKind.Discard && (a as { tile: TileType }).tile === tile)

    debugLog(`handleDiscard: tile=${tile} found=${!!action}`)
    if (action) {
      pendingRef.current = null
      setAvailable(new Set())
      pending.resolve(action)
    }
  }, [view])

  const handleAction = useCallback((kind: ActionBarKind) => {
    const pending = pendingRef.current
    debugLog(`handleAction: kind=${kind} pending=${pending?.phase ?? 'null'}`)
    if (!pending) return

    let action: Action | undefined
    switch (kind) {
      case 'ron':
        action = pending.actions.find(a => a.kind === ActionKind.Ron); break
      case 'tsumo':
        action = pending.actions.find(a => a.kind === ActionKind.Tsumo); break
      case 'pon':
        action = pending.actions.find(a => a.kind === ActionKind.Pon); break
      case 'chi': {
        const chiActions = pending.actions.filter(a => a.kind === ActionKind.Chi)
        if (chiActions.length > 1) { setChoices(chiActions); return }
        action = chiActions[0]
        break
      }
      case 'kan': {
        const kanActions = pending.actions.filter(a =>
          a.kind === ActionKind.Ankan || a.kind === ActionKind.Kakan || a.kind === ActionKind.Daiminkan)
        if (kanActions.length > 1) { setChoices(kanActions); return }
        action = kanActions[0]
        break
      }
      case 'riichi': {
        const riichiActions = pending.actions.filter(a => a.kind === ActionKind.Riichi)
        if (riichiActions.length > 1) { setChoices(riichiActions); return }
        action = riichiActions[0]
        break
      }
      case 'pass':
        action = { kind: ActionKind.Pass }; break
    }

    if (action) {
      pendingRef.current = null
      setAvailable(new Set())
      setChoices(null)
      pending.resolve(action)
    }
  }, [])

  const handleChoice = useCallback((action: Action) => {
    const pending = pendingRef.current
    if (!pending) return
    pendingRef.current = null
    setAvailable(new Set())
    setChoices(null)
    pending.resolve(action)
  }, [])

  if (!view) return null

  const isEnded = phase === 'ron_win' || phase === 'tsumo_win' || phase === 'ryukyoku' || phase === 'game_over'

  return (
    <div className="game-page">
      <button className="game-back" onClick={onExit}>← Menu</button>
      <Table game={view} onDiscard={isEnded ? undefined : handleDiscard} available={available} onAction={handleAction} />
      {choices && (
        <div className="game-result-overlay" onClick={() => setChoices(null)}>
          <div className="choice-panel" onClick={e => e.stopPropagation()}>
            {choices.map((a, i) => (
              <button key={i} className="choice-btn" onClick={() => handleChoice(a)}>
                {formatChoice(a)}
              </button>
            ))}
            <button className="choice-btn choice-cancel" onClick={() => setChoices(null)}>キャンセル</button>
          </div>
        </div>
      )}
      {isEnded && (
        <div className="game-result-overlay">
          <div className="game-result-box">
            <h2>{phase === 'ron_win' ? 'ロン！' : phase === 'tsumo_win' ? 'ツモ！' : phase === 'ryukyoku' ? '流局' : '終了'}</h2>
            <button onClick={onExit}>メニューに戻る</button>
          </div>
        </div>
      )}
      <DebugPanel />
    </div>
  )
}
