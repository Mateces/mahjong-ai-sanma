/**
 * Run a single hanchan with 4 models for quick smoke testing.
 * Usage: MORTAL_PYTHON=... npx tsx scripts/test-one-hanchan.ts
 */

import { ActionKind } from '../src/game/types'
import type { Player } from '../src/game/types'
import { MortalBridge } from '../src/ai/strategies/mortal-bridge'
import { getStrategy } from '../src/ai/strategies/registry'
import '../src/ai/strategies'
import { runHanchan, type HanchanPlayerStats } from './run-hanchan'
import type { Strategy } from '../src/ai/strategy'

const MORTAL_PYTHON = process.env.MORTAL_PYTHON ?? 'python3'
const MORTAL_SERVER = process.env.MORTAL_SERVER ?? '/Users/cat/mahjong-trainer/scripts/mortal_bot_server.py'

// 4 models to test
const MODEL_CONFIGS = [
  {
    label: 'Run A (128ch×20b)',
    // strategy: null = use difficulty-based default AI
    makeStrategy: (seat: Player): Strategy | null =>
      new MortalBridge(seat, {
        checkpoint: '/Users/cat/mahjong-trainer/checkpoints/main-best.pth',
        pythonExe: MORTAL_PYTHON,
        serverScript: MORTAL_SERVER,
      }),
  },
  {
    label: 'Run B (192ch×40b)',
    makeStrategy: (seat: Player): Strategy | null =>
      new MortalBridge(seat, {
        checkpoint: '/Users/cat/mahjong-trainer/checkpoints-stallion/main-best.pth',
        pythonExe: MORTAL_PYTHON,
        serverScript: MORTAL_SERVER,
      }),
  },
  {
    label: 'Mortal v4',
    makeStrategy: (seat: Player): Strategy | null =>
      new MortalBridge(seat, {
        checkpoint: '/Users/cat/Desktop/model_v4_20240308_best_min.pth',
        pythonExe: MORTAL_PYTHON,
        serverScript: MORTAL_SERVER,
      }),
  },
  {
    label: 'Mainstream (rule)',
    makeStrategy: (_seat: Player): Strategy | null =>
      getStrategy('mainstream') ?? null,
  },
]

console.log('=== Single Hanchan Smoke Test ===')
console.log(`Models: ${MODEL_CONFIGS.map((m, i) => `P${i}=${m.label}`).join(', ')}`)
console.log(`Difficulty: 0 (no randomization)`)
console.log()

const seats = MODEL_CONFIGS.map((m, i) => ({
  difficulty: 0,
  strategy: m.makeStrategy(i as Player),
}))

const result = runHanchan(seats, 4, 8, 0 as Player)

console.log(`Rounds: ${result.rounds}, Ryukyoku: ${result.ryukyoku}`)
if (result.warnings.length > 0) {
  console.log(`Warnings:`)
  for (const w of result.warnings) console.log(`  ${w}`)
}
console.log()

// Print per-player stats
const pad = (s: string, n: number) => String(s).padStart(n)
const header =
  `${'Player'.padEnd(18)} ${'Rank'.padStart(4)} ${'Score'.padStart(7)} ` +
  `${'Wins'.padStart(4)} ${'Tsumo'.padStart(4)} ${'Ron'.padStart(4)} ` +
  `${'DealIn'.padStart(5)} ${'Riichi'.padStart(5)} ${'Fuuro'.padStart(5)}`
console.log(header)
console.log('─'.repeat(header.length))

for (let p = 0; p < 4; p++) {
  const s: HanchanPlayerStats = result.players[p]!
  const label = MODEL_CONFIGS[p]!.label
  const scoreStr = s.bankrupt ? `${s.score} (被飞)` : String(s.score)
  console.log(
    `${label.padEnd(18)} ${pad(String(s.rank), 4)} ${pad(scoreStr, 7)} ` +
    `${pad(String(s.wins), 4)} ${pad(String(s.tsumoWins), 4)} ${pad(String(s.ronWins), 4)} ` +
    `${pad(String(s.dealIns), 5)} ${pad(String(s.riichi), 5)} ${pad(String(s.fuuro), 5)}`,
  )
}

// Cleanup
for (const s of seats) {
  if (s.strategy && 'close' in s.strategy && typeof s.strategy.close === 'function') {
    s.strategy.close()
  }
}
