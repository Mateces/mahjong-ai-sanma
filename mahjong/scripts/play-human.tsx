import React, { useEffect, useState } from 'react'
import { render, Box, Text, useApp, useInput } from 'ink'
import { createGame, getValidActions, applyAction, nextRound, finalRanking } from '../src/game/engine'
import { evaluateWin, type WinEvaluation } from '../src/game/win-evaluation'
import { chooseAction, chooseRespondAction, chooseKitaDeclareAction } from '../src/ai/ai-controller'
import { ActionKind } from '../src/game/types'
import type { Action, GameState, Meld, Player, TileType } from '../src/game/types'
import { isWinningHand } from '../src/game/hand-analysis'

// Usage:
//   npm run play:human                          # yonma vs default difficulties
//   npm run play:human -- 3                     # sanma
//   npm run play:human -- 4 0,0.3,0.6,1.0       # yonma w/ custom difficulties
const PLAYER_COUNT = (parseInt(process.argv[2] ?? '4', 10) as 3 | 4)
const DEFAULT_DIFF = PLAYER_COUNT === 3 ? '0,0.3,0.6' : '0,0.3,0.6,1.0'
const DIFFICULTIES = (process.argv[3] ?? DEFAULT_DIFF).split(',').map(Number)
const END_ROUND = parseInt(process.argv[4] ?? '8', 10)
if (DIFFICULTIES.length !== PLAYER_COUNT) {
  console.error(`Bad difficulties: expected ${PLAYER_COUNT} values, got ${DIFFICULTIES.length}`)
  process.exit(1)
}

const HUMAN: Player = 0

const TILE_EMOJI = [
  '🀇','🀈','🀉','🀊','🀋','🀌','🀍','🀎','🀏',
  '🀙','🀚','🀛','🀜','🀝','🀞','🀟','🀠','🀡',
  '🀐','🀑','🀒','🀓','🀔','🀕','🀖','🀗','🀘',
  '🀀','🀁','🀂','🀃',
  '🀆','🀅','🀄',
]
const tile = (t: TileType) => TILE_EMOJI[t]
const tilesStr = (ts: TileType[]) => ts.map(tile).join(' ')
const meldStr = (m: Meld) => '[' + m.tiles.map(tile).join('') + ']'
const meldsStr = (melds: Meld[]) => melds.map(meldStr).join(' ')

const WIND = ['東', '南', '西', '北']
const SEAT_NAME = (p: Player, dealer: Player, n: 3 | 4) => WIND[((p - dealer) + n) % n]

const ROUND_LABEL = (state: GameState) => {
  const wind = WIND[state.roundWind]
  return `${wind}${state.roundNumber}局 ${state.honba}本場`
}

function actionLabel(action: Action): string {
  switch (action.kind) {
    case ActionKind.Discard:      return `打${tile(action.tile)}`
    case ActionKind.Chi:          return `吃${tile(action.called)}`
    case ActionKind.Pon:          return `碰${tile(action.called)}`
    case ActionKind.Ankan:        return `暗杠${tile(action.tile)}`
    case ActionKind.Kakan:        return `加杠${tile(action.tile)}`
    case ActionKind.Daiminkan:    return `大明杠${tile(action.called)}`
    case ActionKind.Riichi:       return `立直打${tile(action.tile)}`
    case ActionKind.Tsumo:        return '自摸'
    case ActionKind.Ron:          return `荣和${tile(action.called)}`
    case ActionKind.Kyushukyuhai: return '九种九牌'
    case ActionKind.Kita:         return '拔北'
    case ActionKind.Pass:         return '过'
  }
}

// Compute the respond actions a specific player can take. Mirrors the
// validRespondActionsForPlayer in ai-controller.ts so we can ask the human
// the same way we'd ask the AI.
function humanRespondActions(state: GameState, responder: Player): Action[] {
  const acts: Action[] = [{ kind: ActionKind.Pass }]
  if (state.phase !== 'respond') return acts
  if (state.lastDiscard == null || state.lastDiscardPlayer == null) return acts
  if (responder === state.lastDiscardPlayer) return acts
  const player = state.players[responder]
  const discarded = state.lastDiscard

  if (isWinningHand([...player.hand, discarded])) {
    acts.push({ kind: ActionKind.Ron, called: discarded })
  }

  // Riichi locks the hand — no Pon/Chi/Daiminkan after riichi.
  if (player.riichi) return acts

  const copies = player.hand.filter(t => t === discarded).length
  if (copies === 3) acts.push({ kind: ActionKind.Daiminkan, called: discarded })
  if (copies >= 2) acts.push({ kind: ActionKind.Pon, called: discarded })

  if (state.playerCount === 4 && responder === ((state.lastDiscardPlayer + 1) % state.playerCount)) {
    const t = discarded
    const suit = t < 27 ? Math.floor(t / 9) : -1
    if (suit >= 0) {
      const rank = t % 9
      const tryChi = (a: number, b: number) => {
        if (player.hand.includes(a) && player.hand.includes(b)) {
          acts.push({ kind: ActionKind.Chi, tiles: [a, b] as [TileType, TileType], called: t })
        }
      }
      if (rank >= 2) tryChi(t - 2, t - 1)
      if (rank >= 1 && rank <= 7) tryChi(t - 1, t + 1)
      if (rank <= 6) tryChi(t + 1, t + 2)
    }
  }
  return acts
}

// Variant of chooseRespondAction that uses a pre-decided action for a human
// seat instead of polling its AI difficulty. Mirrors the original priority
// order: Ron > Pon/Daiminkan > Chi.
function chooseRespondActionWithHuman(
  state: GameState,
  difficulties: readonly number[],
  humanPlayer: Player,
  humanAction: Action,
): Action {
  const discardedBy = state.lastDiscardPlayer
  if (discardedBy == null) return { kind: ActionKind.Pass }

  const responders: Player[] = []
  for (let off = 1; off < state.playerCount; off++) {
    responders.push(((discardedBy + off) % state.playerCount) as Player)
  }

  const decideFor = (r: Player, choices: Action[]): Action =>
    r === humanPlayer
      ? humanAction
      : chooseAction(state, choices, difficulties[r], r)

  for (const r of responders) {
    const myActs = humanRespondActions(state, r)
    const ronOpt = myActs.find(a => a.kind === ActionKind.Ron)
    if (!ronOpt) continue
    const decision = decideFor(r, [ronOpt, { kind: ActionKind.Pass }])
    if (decision.kind === ActionKind.Ron) return ronOpt
  }

  for (const r of responders) {
    const myActs = humanRespondActions(state, r)
    const calls = myActs.filter(
      a => a.kind === ActionKind.Pon || a.kind === ActionKind.Daiminkan,
    )
    if (calls.length === 0) continue
    const decision = decideFor(r, [...calls, { kind: ActionKind.Pass }])
    if (decision.kind !== ActionKind.Pass) return decision
  }

  if (state.playerCount === 4) {
    const next = ((discardedBy + 1) % state.playerCount) as Player
    const myActs = humanRespondActions(state, next)
    const chis = myActs.filter(a => a.kind === ActionKind.Chi)
    if (chis.length > 0) {
      const decision = decideFor(next, [...chis, { kind: ActionKind.Pass }])
      if (decision.kind === ActionKind.Chi) return decision
    }
  }

  return { kind: ActionKind.Pass }
}

// Variant of chooseKitaDeclareAction that uses a human decision for HUMAN seat.
function chooseKitaDeclareActionWithHuman(
  state: GameState,
  difficulties: readonly number[],
  humanPlayer: Player,
  humanAction: Action,
): Action {
  const declarer = state.currentPlayer
  for (let off = 1; off < state.playerCount; off++) {
    const r = ((declarer + off) % state.playerCount) as Player
    if (!isWinningHand([...state.players[r].hand, 30])) continue
    const choices: Action[] = [{ kind: ActionKind.Ron, called: 30 }, { kind: ActionKind.Pass }]
    const decision = r === humanPlayer
      ? humanAction
      : chooseAction(state, choices, difficulties[r], r)
    if (decision.kind === ActionKind.Ron) return { kind: ActionKind.Ron, called: 30 }
  }
  return { kind: ActionKind.Pass }
}

// Whether HUMAN has any non-trivial choice in the current state.
function humanNeedsInput(state: GameState): boolean {
  if (state.phase === 'discard' && state.currentPlayer === HUMAN) return true
  if (state.phase === 'respond') {
    const acts = humanRespondActions(state, HUMAN)
    return acts.length > 1 // Pass + at least one other
  }
  if (state.phase === 'kita_declare') {
    // Declarer auto-resolves silently (chankita poll → resolveKita). Manual
    // kita is now picked in the discard phase instead. Only chankita
    // responders need input here.
    const declarer = state.currentPlayer
    if (declarer === HUMAN) return false
    return isWinningHand([...state.players[HUMAN].hand, 30])
  }
  return false
}

// Build the human's option list for the current state.
function humanOptions(state: GameState): Action[] {
  if (state.phase === 'discard' && state.currentPlayer === HUMAN) {
    return getValidActions(state)
  }
  if (state.phase === 'respond') {
    return humanRespondActions(state, HUMAN)
  }
  if (state.phase === 'kita_declare') {
    // Only chankita responders reach this branch (declarer handled silently).
    return [
      { kind: ActionKind.Pass },
      { kind: ActionKind.Ron, called: 30 },
    ]
  }
  return []
}

// ===== UI Components =====

function Header({ state }: { state: GameState }) {
  const dora = state.doraMarkers.map(tile).join(' ')
  const wallLeft = state.wall.length - state.wallIndex
  const scores = state.players.map((p, i) => `P${i}:${p.score}`).join(' ')
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        {ROUND_LABEL(state)} 立直棒{state.kyotaku / 1000}  Dora {dora}  壁{wallLeft}
      </Text>
      <Text dimColor>{scores}</Text>
    </Box>
  )
}

function OpponentSeat({ state, player }: { state: GameState; player: Player }) {
  const ps = state.players[player]
  const seat = SEAT_NAME(player, state.dealer, state.playerCount)
  const melds = meldsStr(ps.melds)
  const riichi = ps.riichi ? ' ⚡' : ''
  const isCurrent = state.currentPlayer === player
  const river = ps.discards.map(d => d.tsumogiri ? `(${tile(d.tile)})` : tile(d.tile)).join(' ')
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={isCurrent ? 'yellow' : undefined} bold={isCurrent}>
        P{player} ({seat}){riichi}  手牌:{ps.hand.length}  {melds}
      </Text>
      <Text dimColor>  河: {river || '—'}</Text>
    </Box>
  )
}

// Tiles in the hand that the currently selected action operates on, for
// highlight purposes. Discard/Riichi/Ankan/Kakan all reference a tile in the
// player's hand; the visual feedback shows which tile(s) the user is about
// to act on.
function selectedTileFromAction(a: Action | null): TileType | null {
  if (!a) return null
  switch (a.kind) {
    case ActionKind.Discard:
    case ActionKind.Riichi:
    case ActionKind.Ankan:
    case ActionKind.Kakan:
      return a.tile
    default:
      return null
  }
}

function selectedHighlightColor(a: Action | null): string | undefined {
  if (!a) return undefined
  switch (a.kind) {
    case ActionKind.Discard: return 'green'
    case ActionKind.Riichi:  return 'yellow'
    case ActionKind.Ankan:
    case ActionKind.Kakan:   return 'cyan'
    default: return undefined
  }
}

function SelfPanel({
  state,
  lastDrawn,
  pending,
  selected,
}: {
  state: GameState
  lastDrawn: TileType | null
  pending: Action[] | null
  selected: number
}) {
  const ps = state.players[HUMAN]
  const seat = SEAT_NAME(HUMAN, state.dealer, state.playerCount)
  const isHumanDiscarding =
    state.currentPlayer === HUMAN && state.phase === 'discard' && !!pending
  const river = ps.discards
    .map(d => (d.tsumogiri ? `(${tile(d.tile)})` : tile(d.tile)))
    .join(' ')

  const sortedHand = [...ps.hand].sort((a, b) => a - b)
  // Pull out the drawn tile so it can render to the right of the main 13.
  let drawnPos = -1
  if (isHumanDiscarding && lastDrawn != null) {
    drawnPos = sortedHand.lastIndexOf(lastDrawn)
  }

  const selectedAction = pending && pending[selected] ? pending[selected] : null
  const highlightTile = selectedTileFromAction(selectedAction)
  const highlightColor = selectedHighlightColor(selectedAction)

  // Specials = anything that isn't a Discard. They share the same selection
  // index space as discards but are rendered at the right of the hand.
  const specialIndices: number[] = []
  if (pending) {
    pending.forEach((a, i) => {
      if (a.kind !== ActionKind.Discard) specialIndices.push(i)
    })
  }

  // Set of tiles that have a Discard action (for dimming non-discardable
  // tiles when the player is locked into riichi or similar).
  const discardableTiles = new Set<TileType>()
  if (pending) {
    pending.forEach(a => {
      if (a.kind === ActionKind.Discard) discardableTiles.add(a.tile)
    })
  }

  const renderHandTile = (t: TileType, key: string, isDrawn: boolean) => {
    const isHighlighted = isHumanDiscarding && t === highlightTile
    const dimmed =
      isHumanDiscarding && discardableTiles.size > 0 && !discardableTiles.has(t)
    return (
      <Text
        key={key}
        backgroundColor={isHighlighted ? highlightColor : undefined}
        color={isHighlighted ? 'black' : dimmed ? 'gray' : undefined}
        bold={isDrawn || isHighlighted}
      >
        {tile(t)}{' '}
      </Text>
    )
  }

  const mainHand = drawnPos >= 0
    ? sortedHand.filter((_, i) => i !== drawnPos)
    : sortedHand

  return (
    <Box
      flexDirection="column"
      marginTop={1}
      borderStyle="single"
      borderColor={isHumanDiscarding ? 'green' : 'gray'}
      paddingX={1}
    >
      <Text color="green" bold>
        你 P{HUMAN} ({seat}) {ps.riichi ? '⚡' : ''}  {meldsStr(ps.melds)}
      </Text>
      <Text dimColor>河: {river || '—'}</Text>
      <Box flexWrap="wrap">
        {(() => {
          const items: React.ReactNode[] = []
          items.push(<Text key="prefix">手牌: </Text>)
          mainHand.forEach((t, i) => {
            items.push(renderHandTile(t, `m${i}`, false))
          })
          if (drawnPos >= 0) {
            items.push(<Text key="sep-drawn" dimColor>│ </Text>)
            items.push(renderHandTile(sortedHand[drawnPos], 'drawn', true))
          }
          if (specialIndices.length > 0) {
            items.push(<Text key="sep-spec" dimColor>   ┃   </Text>)
            for (const idx of specialIndices) {
              const a = pending![idx]
              const isSel = idx === selected
              items.push(
                <Box key={`spec-${idx}`} marginRight={1}>
                  <Text
                    backgroundColor={isSel ? (selectedHighlightColor(a) ?? 'magenta') : undefined}
                    color={isSel ? 'black' : 'cyan'}
                    bold={isSel}
                  >
                    {' '}{actionLabel(a)}{' '}
                  </Text>
                </Box>,
              )
            }
          }
          return items
        })()}
      </Box>
      {isHumanDiscarding && (
        <Text dimColor>(←/→ 切换, ↵ 确认)</Text>
      )}
    </Box>
  )
}

function RespondPrompt({
  state,
  pending,
  selected,
}: {
  state: GameState
  pending: Action[]
  selected: number
}) {
  let header: string
  if (state.phase === 'respond') {
    const discarder = state.lastDiscardPlayer
    const t = state.lastDiscard
    header = `P${discarder} 打 ${t != null ? tile(t) : '?'} → 回应:`
  } else if (state.phase === 'kita_declare') {
    header = `P${state.currentPlayer} 拔北 → 抢北?`
  } else {
    header = '回应:'
  }

  return (
    <Box
      marginTop={1}
      borderStyle="single"
      borderColor="magenta"
      paddingX={1}
      flexDirection="column"
    >
      <Text color="magenta" bold>{header}</Text>
      <Box flexWrap="wrap">
        {pending.map((a, i) => {
          const isSel = i === selected
          return (
            <Box key={i} marginRight={1}>
              <Text
                backgroundColor={isSel ? 'magenta' : undefined}
                color={isSel ? 'black' : a.kind === ActionKind.Pass ? 'gray' : 'white'}
                bold={isSel}
              >
                {' '}{actionLabel(a)}{' '}
              </Text>
            </Box>
          )
        })}
      </Box>
      <Text dimColor>(←/→ 切换, ↵ 确认)</Text>
    </Box>
  )
}

// Order actions for human consumption so the ←/→ navigation moves the
// visible cursor sequentially through the hand. Tile-bearing actions
// (Discard/Riichi/Ankan/Kakan) are grouped by tile in sort order; this
// way the cursor never jumps from e.g. Discard 9m back to Riichi 5m when
// crossing a category boundary. Tile-less actions (Tsumo / Kita /
// Kyushukyuhai) are appended at the end.
function orderActionsForHuman(actions: Action[], state: GameState): Action[] {
  const phase = state.phase
  if (phase === 'discard') {
    type TileAct = Extract<Action, { tile: TileType }>
    // Within a tile group, order: Discard → Riichi → Ankan → Kakan.
    const kindOrder: Record<string, number> = {
      [ActionKind.Discard]: 0,
      [ActionKind.Riichi]: 1,
      [ActionKind.Ankan]: 2,
      [ActionKind.Kakan]: 3,
    }

    // Walk the player's hand in visual order — sorted main hand left-to-right,
    // with the freshly drawn tile placed last after the separator. The cursor
    // visits each unique tile exactly once in this visual order so left/right
    // arrows correspond to physical motion across the hand row.
    const ps = state.players[state.currentPlayer]
    const sortedHand = [...ps.hand].sort((a, b) => a - b)
    let drawnPos = -1
    if (state.lastDrawnTile != null) {
      drawnPos = sortedHand.lastIndexOf(state.lastDrawnTile)
    }
    const visualOrder: TileType[] = []
    for (let i = 0; i < sortedHand.length; i++) {
      if (i !== drawnPos) visualOrder.push(sortedHand[i])
    }
    if (drawnPos >= 0) visualOrder.push(sortedHand[drawnPos])

    const seen = new Set<TileType>()
    const tileSequence: TileType[] = []
    for (const t of visualOrder) {
      if (!seen.has(t)) {
        seen.add(t)
        tileSequence.push(t)
      }
    }

    const grouped: Action[] = []
    for (const t of tileSequence) {
      const here = actions.filter(
        (a): a is TileAct => 'tile' in a && a.tile === t,
      )
      here.sort((a, b) => (kindOrder[a.kind] ?? 99) - (kindOrder[b.kind] ?? 99))
      grouped.push(...here)
    }

    const tsumo = actions.filter(a => a.kind === ActionKind.Tsumo)
    const kita = actions.filter(a => a.kind === ActionKind.Kita)
    const kyu = actions.filter(a => a.kind === ActionKind.Kyushukyuhai)
    return [...grouped, ...tsumo, ...kita, ...kyu]
  }
  if (phase === 'respond') {
    // Pass first as the safe default.
    const pass = actions.filter(a => a.kind === ActionKind.Pass)
    const ron = actions.filter(a => a.kind === ActionKind.Ron)
    const pon = actions.filter(a => a.kind === ActionKind.Pon)
    const dmk = actions.filter(a => a.kind === ActionKind.Daiminkan)
    const chi = actions
      .filter((a): a is Extract<Action, { kind: 'chi' }> => a.kind === ActionKind.Chi)
      .sort((a, b) => a.tiles[0] - b.tiles[0])
    return [...pass, ...ron, ...pon, ...dmk, ...chi]
  }
  if (phase === 'kita_declare') {
    const pass = actions.filter(a => a.kind === ActionKind.Pass)
    const ron = actions.filter(a => a.kind === ActionKind.Ron)
    const kita = actions.filter(a => a.kind === ActionKind.Kita)
    return [...kita, ...pass, ...ron]
  }
  return actions
}

interface RoundResult {
  phase: 'tsumo_win' | 'ron_win' | 'ryukyoku' | 'game_over'
  winner?: Player
  loser?: Player
  isTsumo?: boolean
  evaluation?: WinEvaluation
  message: string
  scoreSnapshot: number[]
  ranking?: Array<{ player: Player; score: number; rank: number }>
}

function ResultPanel({ result }: { result: RoundResult }) {
  return (
    <Box flexDirection="column" borderStyle="double" borderColor="yellow" paddingX={1} marginY={1}>
      <Text bold color="yellow">{result.message}</Text>
      {result.evaluation && (
        <>
          <Text>
            役: {result.evaluation.yakuList.map(y => `${y.name}(${y.han})`).join(' ')}
          </Text>
          <Text>
            ドラ:{result.evaluation.doraCount}  fu:{result.evaluation.fu}  han:{result.evaluation.totalHan}
            {result.evaluation.isYakuman ? ' 役満!' : ''}
          </Text>
          <Text>得点: {result.evaluation.scoreResult.basicPoints} basic</Text>
        </>
      )}
      <Text dimColor>各家点数: {result.scoreSnapshot.map((s, i) => `P${i}:${s}`).join(' ')}</Text>
      {result.ranking && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="green">最終順位:</Text>
          {result.ranking.map(r => (
            <Text key={r.player}>
              {r.rank}位  P{r.player}  {r.score.toLocaleString()}点
            </Text>
          ))}
        </Box>
      )}
      <Text color="cyan" dimColor>
        {result.phase === 'game_over' ? '↵ 退出' : '↵ 下一局'}
      </Text>
    </Box>
  )
}

// ===== Main Game Component =====

function Game() {
  const [state, setState] = useState(() =>
    createGame({ playerCount: PLAYER_COUNT, endRound: END_ROUND }),
  )
  const [pending, setPending] = useState<Action[] | null>(null)
  const [selected, setSelected] = useState(0)
  const [result, setResult] = useState<RoundResult | null>(null)
  const [lastDrawn, setLastDrawn] = useState<TileType | null>(null)
  const { exit } = useApp()

  // Game loop: react to state changes.
  useEffect(() => {
    if (result) return // waiting for user to acknowledge round result

    const phase = state.phase

    // Hanchan ended.
    if (phase === 'game_over') {
      setResult({
        phase: 'game_over',
        message: '🏁 半庄終了',
        scoreSnapshot: state.players.map(p => p.score),
        ranking: finalRanking(state),
      })
      return
    }

    // Round ended — show win info.
    if (phase === 'tsumo_win' || phase === 'ron_win') {
      const winner = state.currentPlayer
      const isTsumo = phase === 'tsumo_win'
      const winningTile = isTsumo
        ? state.lastDrawnTile!
        : state.lastDiscard!
      const evaluation = evaluateWin(state, winner, isTsumo, winningTile)
      const winnerName = winner === HUMAN ? '你' : `P${winner}`
      const message = isTsumo
        ? `🎉 ${winnerName} 自摸!`
        : `🎉 ${winnerName} 荣和!`
      setResult({
        phase, winner, isTsumo, evaluation, message,
        scoreSnapshot: state.players.map(p => p.score),
        loser: state.lastDiscardPlayer ?? undefined,
      })
      return
    }
    if (phase === 'ryukyoku') {
      setResult({
        phase: 'ryukyoku',
        message: '🌊 流局',
        scoreSnapshot: state.players.map(p => p.score),
      })
      return
    }

    // Track last drawn tile for the human's next decision.
    if (state.lastDrawnTile != null && state.currentPlayer === HUMAN) {
      setLastDrawn(state.lastDrawnTile)
    } else {
      setLastDrawn(null)
    }

    // Human's turn?
    if (humanNeedsInput(state)) {
      const opts = orderActionsForHuman(humanOptions(state), state)
      setPending(opts)
      setSelected(0)
      return
    }

    // AI tick — schedule with small delay so the user can read the board.
    const t = setTimeout(() => {
      let action: Action
      if (state.phase === 'respond') {
        // Human can't act here, so use the original AI poll.
        action = chooseRespondAction(state, DIFFICULTIES)
      } else if (state.phase === 'kita_declare') {
        action = chooseKitaDeclareAction(state, DIFFICULTIES)
      } else {
        const acts = getValidActions(state)
        action = chooseAction(state, acts, DIFFICULTIES[state.currentPlayer])
      }
      setState(applyAction(state, action))
    }, 350)
    return () => clearTimeout(t)
  }, [state, result])

  useInput((_input, key) => {
    if (result) {
      if (key.return) {
        if (result.phase === 'game_over') {
          exit()
          return
        }
        // Advance to next round.
        const next = nextRound(state)
        setState(next)
        setResult(null)
      }
      return
    }
    if (!pending) return

    const len = pending.length
    if (key.leftArrow) setSelected(i => (i - 1 + len) % len)
    if (key.rightArrow) setSelected(i => (i + 1) % len)
    if (key.return) {
      const chosen = pending[selected]
      const phase = state.phase
      setPending(null)

      // Resolve the engine-level action depending on phase.
      let action: Action
      if (phase === 'respond') {
        action = chooseRespondActionWithHuman(state, DIFFICULTIES, HUMAN, chosen)
      } else if (phase === 'kita_declare') {
        // Only chankita responders reach the input handler in kita_declare.
        action = chooseKitaDeclareActionWithHuman(state, DIFFICULTIES, HUMAN, chosen)
      } else {
        action = chosen
      }
      setState(applyAction(state, action))
    }
  })

  // Render
  const opponents: Player[] = []
  for (let p = 1; p < state.playerCount; p++) opponents.push(p as Player)

  return (
    <Box flexDirection="column">
      <Header key="header" state={state} />
      {opponents.map(p => (
        <OpponentSeat key={`opp-${p}`} state={state} player={p} />
      ))}
      <SelfPanel
        key="self"
        state={state}
        lastDrawn={lastDrawn}
        pending={pending}
        selected={selected}
      />
      {pending && (state.phase === 'respond' || state.phase === 'kita_declare') ? (
        <RespondPrompt key="respond" state={state} pending={pending} selected={selected} />
      ) : null}
      {result ? <ResultPanel key="result" result={result} /> : null}
    </Box>
  )
}

render(<Game />)
