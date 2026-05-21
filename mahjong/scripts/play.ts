import { createGame, getValidActions, applyAction } from '../src/game/engine'
import { chooseAction, chooseRespondAction, chooseKitaDeclareAction } from '../src/ai/ai-controller'
import { ActionKind } from '../src/game/types'
import type { Action, GameState, Meld } from '../src/game/types'

// Usage:
//   npx tsx scripts/play.ts                     # yonma (default)
//   npx tsx scripts/play.ts 0,0.3,1.0           # sanma (3 difficulties)
//   npx tsx scripts/play.ts 0,0.3,0.6,1.0 4     # yonma east-only
const DIFFICULTIES = (process.argv[2] ?? '0,0.3,0.6,1.0').split(',').map(Number)
const END_ROUND = parseInt(process.argv[3] ?? '8', 10)
if (DIFFICULTIES.length !== 3 && DIFFICULTIES.length !== 4) {
  console.error(`Bad difficulties: expected 3 (sanma) or 4 (yonma), got ${DIFFICULTIES.length}`)
  process.exit(1)
}
const PLAYER_COUNT = DIFFICULTIES.length as 3 | 4
const P = PLAYER_COUNT === 3 ? ['P0', 'P1', 'P2'] : ['P0', 'P1', 'P2', 'P3']

// Unicode mahjong tile emoji
const EMOJI = [
  '🀇','🀈','🀉','🀊','🀋','🀌','🀍','🀎','🀏',  // 1-9 man
  '🀙','🀚','🀛','🀜','🀝','🀞','🀟','🀠','🀡',  // 1-9 pin
  '🀐','🀑','🀒','🀓','🀔','🀕','🀖','🀗','🀘',  // 1-9 sou
  '🀀','🀁','🀂','🀃',                            // 東南西北
  '🀆','🀅','🀄',                                  // 白發中
]

const te = (t: number) => EMOJI[t]
const handE = (hand: number[]) => hand.map(te).join(' ')
const meldE = (m: Meld) => '[' + m.tiles.map(te).join(' ') + ']'

function playerLine(state: GameState, p: number): string {
  const ps = state.players[p]
  const melds = ps.melds.map(meldE).join('')
  const riichi = ps.riichi ? '⚡' : ''
  return `${P[p]}:${handE(ps.hand)}${melds}${riichi}`
}

function boardLine(state: GameState): string {
  const indices = Array.from({ length: state.playerCount }, (_, i) => i)
  return indices.map(p => playerLine(state, p)).join('  ')
}

// state.turnCount is a draw counter — it increments per draw, not per 巡.
// One 巡 = playerCount draws (everyone moves once). Use ceil so the first
// draw of the round shows as 巡 1, not 巡 0.
function junOf(state: GameState): number {
  return Math.ceil(state.turnCount / state.playerCount)
}

function actionLabel(action: Action): string {
  switch (action.kind) {
    case ActionKind.Discard:      return `打${te(action.tile)}`
    case ActionKind.Chi:          return `吃${te(action.called)}`
    case ActionKind.Pon:          return `碰${te(action.called)}`
    case ActionKind.Ankan:        return `暗杠${te(action.tile)}`
    case ActionKind.Kakan:        return `加杠${te(action.tile)}`
    case ActionKind.Daiminkan:    return `大明杠${te(action.called)}`
    case ActionKind.Riichi:       return `⚡立直打${te(action.tile)}`
    case ActionKind.Tsumo:        return '自摸!'
    case ActionKind.Ron:          return `荣和${te(action.called)}!`
    case ActionKind.Kyushukyuhai: return '九种九牌'
    case ActionKind.Pass:         return ''
  }
}

function runGame() {
  let state = createGame({ playerCount: PLAYER_COUNT, endRound: END_ROUND })
  const windNames = ['東','南','西','北']
  const roundName = `${windNames[state.roundWind]}${state.roundNumber}局`

  console.log(`╔═══ ${roundName} ═══╗`)
  console.log(`親: P${state.dealer}  宝: ${te(state.doraMarkers[0])}  難度: ${DIFFICULTIES.map((d,i) => `P${i}=${d}`).join(' ')}`)
  console.log(`配牌  ${boardLine(state)}`)
  console.log('────────────────────────────────────────────────────────────────────────────')

  while (true) {
    const actions = getValidActions(state)
    if (actions.length === 0) break

    const difficulty = DIFFICULTIES[state.currentPlayer]
    const action = state.phase === 'respond'
      ? chooseRespondAction(state, DIFFICULTIES)
      : state.phase === 'kita_declare'
      ? chooseKitaDeclareAction(state, DIFFICULTIES)
      : chooseAction(state, actions, difficulty)
    const prevPhase = state.phase
    const prevPlayer = state.currentPlayer

    state = applyAction(state, action)

    // Skip auto-draw and respond-pass
    if (action.kind === ActionKind.Pass) continue

    // For respond-phase calls (Pon/Chi/Ron/Daiminkan) the actor is the
    // post-applyAction currentPlayer (the one who actually performed the call).
    // For all other actions it's the pre-applyAction currentPlayer.
    const actor = prevPhase === 'respond' ? state.currentPlayer : prevPlayer

    const label = `${P[actor]}${actionLabel(action)}`
    const tNum = String(junOf(state)).padStart(2, ' ')
    console.log(`${tNum}巡 ${label.padEnd(10)} ${boardLine(state)}`)

    if (state.phase === 'tsumo_win') {
      console.log(`\n🎉 ${P[state.currentPlayer]} 自摸和了!`)
      break
    }
    if (state.phase === 'ron_win') {
      console.log(`\n🎉 ${P[state.currentPlayer]} 荣和和了!`)
      break
    }
    if (state.phase === 'ryukyoku') {
      console.log('\n流局')
      break
    }
  }

  console.log('────────────────────────────────────────────────────────────────────────────')
  console.log(`最終  ${boardLine(state)}`)
  console.log(`巡数: ${junOf(state)}巡`)
}

runGame()
