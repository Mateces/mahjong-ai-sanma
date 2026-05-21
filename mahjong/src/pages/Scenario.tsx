import '../game-ui/game-ui.css'
import { useState } from 'react'
import type { TileType } from '../game/types'
import { ActionKind } from '../game/types'
import type { Action } from '../game/types'
import { mjaiToTile } from '../ai/mjai/tile'
import Tile from '../game-ui/Tile'
import type { Pai } from '../game-ui/types'

/**
 * Scenario builder: scripted test scenarios.
 * AI players follow a script (predefined discards), player tests specific interactions.
 */

const AKA_TILES = new Set(['5mr', '5pr', '5sr'])
const AKA_MAP: Record<string, TileType> = { '5mr': 4, '5pr': 13, '5sr': 22 }

function parsePai(pai: Pai): { tile: TileType; isAka: boolean } {
  const isAka = AKA_TILES.has(pai)
  return { tile: mjaiToTile(pai as never), isAka }
}

function parseHand(pais: Pai[]): { tiles: TileType[]; aka: TileType[] } {
  const tiles: TileType[] = []
  const aka: TileType[] = []
  for (const p of pais) {
    const { tile, isAka } = parsePai(p)
    tiles.push(tile)
    if (isAka) aka.push(tile)
  }
  return { tiles, aka }
}

export interface ScenarioConfig {
  name: string
  description: string
  /** P0 (player) hand */
  myHand: Pai[]
  /** P1-P3 hands */
  aiHands: [Pai[], Pai[], Pai[]]
  /** Script: sequence of discards by AI players before player acts.
   *  Format: [player, tile] pairs executed in order. */
  script: { player: 1 | 2 | 3; discard: Pai }[]
  /** Remaining wall tiles (what gets drawn after script plays out) */
  wall: Pai[]
  /** Who is dealer (0-3). Set to 3 to let P3 go first so P0 can respond. */
  startDealer?: 0 | 1 | 2 | 3
}

const PRESETS: ScenarioConfig[] = [
  {
    name: '吃选择（红五/黑五）',
    description: 'P3（上家）打出 3s，你手里有 4s+5s 和 4s+5sr，测试吃的选择',
    myHand: ['4s', '5s', '5sr', '6s', '7s', '1m', '3m', '5m', '7p', '8p', '9p', 'E', 'N'],
    aiHands: [
      ['1s', '2s', '3s', '4p', '5p', '6p', '7m', '8m', '9m', 'N', 'N', 'W', 'W'],
      ['1p', '2p', '3p', '4m', '6m', '8m', '1s', '9s', '9s', 'P', 'P', 'F', 'F'],
      ['C', 'C', 'C', 'S', 'S', '3s', '2s', '8s', '9s', '4m', '7m', '8m', '9m'],
    ],
    script: [
      { player: 3, discard: '3s' },
    ],
    wall: ['3s', 'E', 'W', 'F', '9m', '1p', '2p', '3p', '4p', '5p', '6p', '7p', '8p', '9p', '1m', '2m'],
    startDealer: 3,
  },
  {
    name: '食替テスト',
    description: 'P3（上家）打出 5m，你手里有 5m×2，碰后不能打 5m',
    myHand: ['5m', '5m', '1p', '2p', '3p', '7s', '8s', '9s', 'E', 'E', 'S', 'S', 'N'],
    aiHands: [
      ['1m', '2m', '3m', '4p', '5p', '6p', '7p', '8p', '9p', 'W', 'W', 'N', 'N'],
      ['1s', '2s', '3s', '4s', '5s', '6s', '7m', '8m', '9m', 'P', 'P', 'F', 'F'],
      ['C', 'C', 'C', '5m', '4m', '6m', '8m', '9m', '1p', '2p', '3p', '4p', '5p'],
    ],
    script: [
      { player: 3, discard: '5m' },
    ],
    wall: ['5m', 'N', 'W', 'F', 'C', '1m', '2m', '3m', '4m', '6m', '7m', '8m', '9m', '1s', '2s', '3s'],
    startDealer: 3,
  },
]

interface Props {
  onPlay: (config: {
    hands: TileType[][]
    aka: TileType[][]
    wall: TileType[]
    script: Action[][]  // per-player script
    startDealer?: 0 | 1 | 2 | 3
  }) => void
  onExit: () => void
}

export default function Scenario({ onPlay, onExit }: Props) {
  const [selected, setSelected] = useState(0)
  const preset = PRESETS[selected]!

  const handleStart = () => {
    const myParsed = parseHand(preset.myHand)
    const aiParsed = preset.aiHands.map(parseHand)

    const hands = [myParsed.tiles, ...aiParsed.map(a => a.tiles)]
    const aka = [myParsed.aka, ...aiParsed.map(a => a.aka)]
    const wall = preset.wall.map(p => parsePai(p).tile)

    // Build per-player scripts (array of discard actions)
    const scripts: Action[][] = [[], [], [], []]
    for (const step of preset.script) {
      const { tile } = parsePai(step.discard)
      scripts[step.player].push({ kind: ActionKind.Discard, tile })
    }

    onPlay({ hands, aka, wall, script: scripts, startDealer: preset.startDealer })
  }

  return (
    <div style={{ padding: 24, maxWidth: 900, margin: '0 auto', color: '#fff' }}>
      <button onClick={onExit} style={{ marginBottom: 16 }}>← Back</button>
      <h1>场景测试</h1>

      <div style={{ marginBottom: 16, display: 'flex', gap: 8 }}>
        {PRESETS.map((p, i) => (
          <button key={i} onClick={() => setSelected(i)}
            style={{ padding: '6px 12px', background: i === selected ? '#4a9' : '#333', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
            {p.name}
          </button>
        ))}
      </div>

      <p style={{ color: '#aaa' }}>{preset.description}</p>

      <div style={{ marginBottom: 12 }}>
        <strong>你的手牌：</strong>
        <div style={{ display: 'flex', gap: 2, marginTop: 4 }}>
          {preset.myHand.map((pai, i) => <Tile key={i} pai={pai} size="hand" />)}
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <strong>剧本：</strong>
        <ol style={{ color: '#ccc', margin: '4px 0' }}>
          {preset.script.map((s, i) => (
            <li key={i}>P{s.player} 打出 <Tile pai={s.discard} size="hand" /></li>
          ))}
          <li>→ 轮到你操作</li>
        </ol>
      </div>

      <button onClick={handleStart} style={{ marginTop: 16, padding: '10px 28px', fontSize: 16, background: '#4a9', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}>
        开始测试
      </button>
    </div>
  )
}
