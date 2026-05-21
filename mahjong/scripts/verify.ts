import { Worker } from 'node:worker_threads'
import { cpus } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFileSync } from 'node:fs'

// Multi-hanchan self-play that distributes work across CPU cores via
// worker_threads. Aggregates per-player stats and prints rank/score metrics.
//
// Usage:
//   npx tsx scripts/verify.ts [hanchans=200] [diffs] [endRound=8]
//   npx tsx scripts/verify.ts 500 0,0.3,0.6,1.0      # yonma, default rounds
//   npx tsx scripts/verify.ts 500 0,0.3,1.0          # sanma (3 difficulties)
//   npx tsx scripts/verify.ts 500 0,0.3,1.0 4        # sanma east-only
//   WORKERS=4 npx tsx scripts/verify.ts 1000         # override worker count
//
// Per-seat strategy override (optional):
//   npx tsx scripts/verify.ts 500 0,0.3,0.6,1.0 8 --strategies=defense-first,,,
//   ^ P0 uses 'defense-first', P1-P3 use default difficulty-based AI.
//   Empty entries = no strategy (default AI). Strategies must be registered
//   in src/ai/strategies/registry.ts ahead of time.
//
// playerCount is inferred from the difficulty count (3 → sanma, 4 → yonma).
//
// Reports avgRank, avgScore (relative to starting), rank distribution,
// win/deal-in/riichi/fuuro rates, and a regression check (P0 vs P1 avgRank).

const __dirname = dirname(fileURLToPath(import.meta.url))

// Positional args; --flags are pulled out separately.
const positional = process.argv.slice(2).filter(a => !a.startsWith('--'))
const HANCHANS = parseInt(positional[0] ?? '200', 10)
const DIFFICULTIES = (positional[1] ?? '0,0.3,0.6,1.0').split(',').map(Number)
const END_ROUND = parseInt(positional[2] ?? '8', 10)

const strategiesFlag = process.argv.find(a => a.startsWith('--strategies='))
const STRATEGY_NAMES: (string | null)[] = strategiesFlag
  ? strategiesFlag.slice('--strategies='.length).split(',').map(s => {
      const trimmed = s.trim()
      return trimmed === '' ? null : trimmed
    })
  : []

if (DIFFICULTIES.length !== 3 && DIFFICULTIES.length !== 4) {
  console.error(`Bad difficulties: expected 3 (sanma) or 4 (yonma) numbers, got ${DIFFICULTIES.length}`)
  process.exit(1)
}
if (DIFFICULTIES.some(d => !Number.isFinite(d))) {
  console.error('Bad difficulties: all values must be finite numbers')
  process.exit(1)
}
if (END_ROUND !== 4 && END_ROUND !== 8) {
  console.error(`Bad endRound: expected 4 (east-only) or 8 (east+south), got ${END_ROUND}`)
  process.exit(1)
}
if (STRATEGY_NAMES.length > 0 && STRATEGY_NAMES.length !== DIFFICULTIES.length) {
  console.error(
    `Bad --strategies: expected ${DIFFICULTIES.length} entries (use empty entries for default AI), got ${STRATEGY_NAMES.length}`,
  )
  process.exit(1)
}

const PLAYER_COUNT = DIFFICULTIES.length as 3 | 4
const MODE_LABEL = PLAYER_COUNT === 3 ? 'sanma' : 'yonma'
const ROUND_LABEL = END_ROUND === 4 ? 'east-only' : 'east+south'

const CORES = cpus().length
const WORKERS = Math.max(
  1,
  Math.min(HANCHANS, parseInt(process.env.WORKERS ?? String(Math.max(1, CORES - 2)), 10)),
)

interface PlayerStats {
  wins: number
  tsumo: number
  ron: number
  dealIns: number
  riichi: number
  fuuro: number
  kita: number
  rankSum: number
  scoreSum: number
  rankDist: number[]
  fuuroRounds: number
  fuuroRyukyoku: number
  tenpaiRyukyoku: number
  defendedLikely: number
  bankrupt: number
}

interface WorkerOutput {
  perPlayer: PlayerStats[]
  ryukyoku: number
  totalRounds: number
  hanchansCompleted: number
}

// Distribute hanchans as evenly as possible
const counts: number[] = []
const base = Math.floor(HANCHANS / WORKERS)
const extra = HANCHANS % WORKERS
for (let w = 0; w < WORKERS; w++) counts.push(base + (w < extra ? 1 : 0))

console.log(
  `Running ${HANCHANS} hanchans of ${MODE_LABEL} ${ROUND_LABEL} across ${WORKERS} workers (${CORES} cores)`,
)
console.log(`difficulties = [${DIFFICULTIES.join(', ')}]`)
if (STRATEGY_NAMES.length > 0) {
  console.log(`strategies   = [${STRATEGY_NAMES.map(n => n ?? '<default>').join(', ')}]`)
}
console.log()

const start = Date.now()
const progress = new Array(WORKERS).fill(0)
let lastReportedTotal = -1
const hanchanResults: unknown[] = []

const workerOutputs = await Promise.all(counts.map((count, w) => new Promise<WorkerOutput>((resolve, reject) => {
  const worker = new Worker(join(__dirname, 'verify-worker.ts'), {
    workerData: {
      hanchans: count,
      difficulties: DIFFICULTIES,
      playerCount: PLAYER_COUNT,
      endRound: END_ROUND,
      workerIndex: w,
      strategyNames: STRATEGY_NAMES,
    },
    // tsx's auto-register guards itself to the main thread, so a fresh
    // worker context won't load .ts files. tsx-register.mjs explicitly
    // calls register() to attach the loader before the worker starts.
    execArgv: [...process.execArgv, '--import', join(__dirname, 'tsx-register.mjs')],
  })

  worker.on('message', (msg: { type: string; workerIndex: number; done?: number; stats?: WorkerOutput }) => {
    if (msg.type === 'hanchan_result') {
      hanchanResults.push(msg)
    } else if (msg.type === 'progress' && typeof msg.done === 'number') {
      progress[msg.workerIndex] = msg.done
      const sum = progress.reduce((a, b) => a + b, 0)
      // Throttle stderr writes; 5-hanchan steps or final
      if (sum !== lastReportedTotal && (sum % 5 === 0 || sum === HANCHANS)) {
        const elapsed = (Date.now() - start) / 1000
        const eta = sum > 0 ? (elapsed / sum * (HANCHANS - sum)).toFixed(0) : '?'
        process.stderr.write(
          `\r${sum}/${HANCHANS} hanchans  ${elapsed.toFixed(1)}s elapsed  eta ${eta}s        `,
        )
        lastReportedTotal = sum
      }
    } else if (msg.type === 'done' && msg.stats) {
      resolve(msg.stats)
    }
  })

  worker.on('error', reject)
  worker.on('exit', code => {
    if (code !== 0) reject(new Error(`Worker ${w} exited with code ${code}`))
  })
})))

process.stderr.write('\n')

// Aggregate
const stats: PlayerStats[] = Array.from({ length: PLAYER_COUNT }, () => ({
  wins: 0, tsumo: 0, ron: 0, dealIns: 0, riichi: 0, fuuro: 0, kita: 0,
  rankSum: 0, scoreSum: 0, rankDist: new Array(PLAYER_COUNT).fill(0),
  fuuroRounds: 0, fuuroRyukyoku: 0, tenpaiRyukyoku: 0, defendedLikely: 0,
  bankrupt: 0,
}))
let ryukyoku = 0
let totalRounds = 0
let hanchansCompleted = 0
for (const out of workerOutputs) {
  for (let p = 0; p < PLAYER_COUNT; p++) {
    stats[p].wins += out.perPlayer[p].wins
    stats[p].tsumo += out.perPlayer[p].tsumo
    stats[p].ron += out.perPlayer[p].ron
    stats[p].dealIns += out.perPlayer[p].dealIns
    stats[p].riichi += out.perPlayer[p].riichi
    stats[p].fuuro += out.perPlayer[p].fuuro
    stats[p].kita += out.perPlayer[p].kita
    stats[p].rankSum += out.perPlayer[p].rankSum
    stats[p].scoreSum += out.perPlayer[p].scoreSum
    stats[p].fuuroRounds += out.perPlayer[p].fuuroRounds
    stats[p].fuuroRyukyoku += out.perPlayer[p].fuuroRyukyoku
    stats[p].tenpaiRyukyoku += out.perPlayer[p].tenpaiRyukyoku
    stats[p].defendedLikely += out.perPlayer[p].defendedLikely
    stats[p].bankrupt += out.perPlayer[p].bankrupt
    for (let r = 0; r < PLAYER_COUNT; r++) {
      stats[p].rankDist[r] += out.perPlayer[p].rankDist[r]
    }
  }
  ryukyoku += out.ryukyoku
  totalRounds += out.totalRounds
  hanchansCompleted += out.hanchansCompleted
}

const elapsedSec = ((Date.now() - start) / 1000).toFixed(1)

const startingScore = PLAYER_COUNT === 3 ? 35000 : 25000

console.log(`\n=== ${HANCHANS} hanchans (${MODE_LABEL} ${ROUND_LABEL}), ${totalRounds} rounds, ${elapsedSec}s ===`)
console.log()

const pad = (s: string | number, n: number) => String(s).padStart(n)
const pct = (n: number, d: number) => d === 0 ? '  -' : (n / d * 100).toFixed(1)
const rankPct = (n: number) => (n / hanchansCompleted * 100).toFixed(0)

const avgRanks = stats.map(s => s.rankSum / hanchansCompleted)
const avgScores = stats.map(s => (s.scoreSum / hanchansCompleted) - startingScore)

const rankHeaders = Array.from({ length: PLAYER_COUNT }, (_, i) => `${i + 1}位%`.padStart(5)).join('  ')
const header =
  `${'Player'.padEnd(7)} ${rankHeaders} ${'被飞%'.padStart(6)} ${'平均顺位'.padStart(8)} ` +
  `${'和了%'.padStart(6)} ${'放铳%'.padStart(6)} ${'副露%'.padStart(6)} ${'立直%'.padStart(6)} ${'自摸%'.padStart(6)} ${'流局%'.padStart(6)} ${'流听%'.padStart(6)}`
console.log(header)
console.log('─'.repeat(header.length))
for (let p = 0; p < PLAYER_COUNT; p++) {
  const s = stats[p]
  const rankDistStr = s.rankDist.map((c, _i) => pad(rankPct(c), 5)).join('  ')
  const line =
    `P${p}      ` +
    rankDistStr + ' ' +
    pad(pct(s.bankrupt, hanchansCompleted), 6) + ' ' +
    pad(avgRanks[p].toFixed(2), 8) + ' ' +
    pad(pct(s.wins, totalRounds), 6) + ' ' +
    pad(pct(s.dealIns, totalRounds), 6) + ' ' +
    pad(pct(s.fuuroRounds, totalRounds), 6) + ' ' +
    pad(pct(s.riichi, totalRounds), 6) + ' ' +
    pad(pct(s.tsumo, s.wins), 6) + ' ' +
    pad(pct(ryukyoku, totalRounds), 6) + ' ' +
    pad(pct(s.tenpaiRyukyoku, ryukyoku), 6)
  console.log(line)
}

// Sanity checks
const warnings: string[] = []
for (let p = 0; p < PLAYER_COUNT; p++) {
  const avgRank = avgRanks[p]
  if (avgRank < 1 || avgRank > PLAYER_COUNT) {
    warnings.push(`P${p} avgRank ${avgRank.toFixed(2)} outside [1, ${PLAYER_COUNT}]`)
  }
  const distSum = stats[p].rankDist.reduce((a, b) => a + b, 0)
  if (distSum !== hanchansCompleted) {
    warnings.push(`P${p} rankDist sum ${distSum} != hanchansCompleted ${hanchansCompleted}`)
  }
}
const totalAvgScore = avgScores.reduce((a, b) => a + b, 0)
if (Math.abs(totalAvgScore) > 100) {
  warnings.push(`AvgScore sum ${totalAvgScore.toFixed(0)} != 0 (zero-sum violated)`)
}
if (warnings.length > 0) {
  console.log('\nSanity warnings:')
  for (const w of warnings) console.log(`  ${w}`)
}

// Regression check
console.log()
if (DIFFICULTIES[0] < DIFFICULTIES[1]) {
  const p0Rank = avgRanks[0]
  const p1Rank = avgRanks[1]
  if (p0Rank < p1Rank) {
    console.log(`✅ Strongest P0: avgRank ${p0Rank.toFixed(2)} (vs P1 at ${p1Rank.toFixed(2)}), avgScore ${avgScores[0] >= 0 ? '+' : ''}${avgScores[0].toFixed(0)}`)
  } else {
    console.log(
      `⚠️  REGRESSION: P0 avgRank ${p0Rank.toFixed(2)} not better than P1 avgRank ${p1Rank.toFixed(2)}`,
    )
  }
}

const seWin = 0.43 / Math.sqrt(totalRounds)
console.log(`\n(±1 SE on win rate ≈ ${(seWin * 100).toFixed(2)}%; for tight verdicts run more hanchans.)`)

// Write per-hanchan raw results to a JSON file if RAW_OUTPUT is set.
const rawOutput = process.env.RAW_OUTPUT
if (rawOutput && hanchanResults.length > 0) {
  writeFileSync(rawOutput, JSON.stringify(hanchanResults, null, 2))
  console.log(`\nRaw results written to ${rawOutput} (${hanchanResults.length} hanchans)`)
}
