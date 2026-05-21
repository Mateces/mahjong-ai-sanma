import type { DiscardEntry, Meld, GameState, MeldType, TileType } from '../game/types'
import type { GameView, MeldView, Pai, SeatView } from './types'
import { tileToMjai } from '../ai/mjai/tile'

export function gameStateToView(state: GameState, me: 0 | 1 | 2 | 3 = 0): GameView {
  const seats: SeatView[] = state.players.map((p, i) => {
    const isMe = i === me

    // Build a counter of aka tiles in hand so each aka is only marked once
    const akaRemaining = new Map<TileType, number>()
    for (const t of p.akaInHand ?? []) {
      akaRemaining.set(t, (akaRemaining.get(t) ?? 0) + 1)
    }

    const handToPai = (t: TileType): Pai => {
      if (akaRemaining.has(t)) {
        const count = akaRemaining.get(t)!
        if (count > 0) {
          akaRemaining.set(t, count - 1)
          return tileToMjai(t, true)
        }
      }
      return tileToMjai(t)
    }

    const hasTsumo = state.phase === 'discard' && state.currentPlayer === i && state.lastDrawnTile != null
    const isAka = state.lastDrawnTile != null && (p.akaInHand ?? []).includes(state.lastDrawnTile)
    const tsumo: Pai | null = hasTsumo
      ? (isMe ? tileToMjai(state.lastDrawnTile!, isAka) : '?')
      : null

    // Build display hand. The engine hand is sorted and includes the tsumo tile.
    // We need to remove exactly one copy of the tsumo tile for display.
    let displayHand: Pai[]
    if (hasTsumo && isMe) {
      const tsumoPai = tileToMjai(state.lastDrawnTile!, isAka)
      const arr = p.hand.map(handToPai)
      const idx = arr.indexOf(tsumoPai)
      if (idx >= 0) arr.splice(idx, 1)
      displayHand = arr
    } else if (hasTsumo && !isMe) {
      displayHand = Array<Pai>(p.hand.length - 1).fill('?')
    } else {
      displayHand = isMe ? p.hand.map(handToPai) : Array<Pai>(p.hand.length).fill('?')
    }

    return {
      seatId: i as 0 | 1 | 2 | 3,
      hand: displayHand,
      tsumo,
      river: p.discards.map(discardToView),
      melds: p.melds.map(m => meldToView(m, p.akaInMelds)),
      score: p.score,
      seatWind: ((i - state.dealer + state.playerCount) % state.playerCount) as 0 | 1 | 2 | 3,
      riichi: p.riichi,
      mood: 'idle',
    }
  })

  const deadWall = state.wall.length - state.rinshanIndex
  const wallRemaining = state.wall.length - state.wallIndex - deadWall

  return {
    me,
    seats: seats as [SeatView, SeatView, SeatView, SeatView],
    bakaze: state.roundWind as 0 | 1 | 2 | 3,
    kyoku: ((state.roundNumber - 1) % state.playerCount) + 1,
    honba: state.honba,
    kyotaku: state.kyotaku,
    wallRemaining,
    doraIndicators: state.doraMarkers.map(t => tileToMjai(t)),
    activeSeat: state.currentPlayer,
  }
}

function discardToView(d: DiscardEntry): import('./types').DiscardEntry {
  return {
    pai: tileToMjai(d.tile),
    tsumogiri: d.tsumogiri,
    riichi: false,
    called: false,
  }
}

function meldToView(m: Meld, akaInMelds?: TileType[]): MeldView {
  const akaSet = new Set(akaInMelds ?? [])
  const usedAka = new Set<TileType>()
  const tiles: Pai[] = m.tiles.map(t => {
    if (akaSet.has(t) && !usedAka.has(t)) {
      usedAka.add(t)
      return tileToMjai(t, true)
    }
    return tileToMjai(t)
  })
  const kind = meldKind(m.type)
  const calledIndex = m.type === 'ankan' ? -1 : 0
  return { kind, tiles, calledIndex }
}

function meldKind(t: MeldType): MeldView['kind'] {
  switch (t) {
    case 'chi': return 'chi'
    case 'pon': return 'pon'
    case 'daiminkan': return 'minkan'
    case 'ankan': return 'ankan'
    case 'kakan': return 'kakan'
  }
}
