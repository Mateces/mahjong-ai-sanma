import { describe, it, expect } from 'vitest'
import { applyTsumo, applyAction, getValidActions, nextRound, checkTobi, finalRanking, createGame } from '../engine'
import { ActionKind } from '../types'
import type { GameState, PlayerState, TileType, Player, Wind } from '../types'
import { chooseAction, chooseRespondAction, chooseKitaDeclareAction } from '../../ai/ai-controller'

function makePlayer(overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    hand: [],
    melds: [],
    discards: [],
    riichi: false,
    riichiTurn: 0,
    score: 25000,
    isMenzen: true,
    kitaCount: 0,
    ...overrides,
  }
}

function makeState(overrides: Partial<GameState> = {}): GameState {
  const playerCount = (overrides.playerCount ?? 4) as 3 | 4
  const startingScore = playerCount === 3 ? 35000 : 25000
  const defaultPlayers = Array.from({ length: playerCount }, () =>
    makePlayer({ score: startingScore })
  ) as GameState['players']

  return {
    playerCount,
    endRound: 8,
    wall: [],
    wallIndex: 0,
    rinshanIndex: 0,
    doraMarkers: [31], // haku → hatsu, doesn't appear in test hands by default
    players: defaultPlayers,
    currentPlayer: 0 as Player,
    dealer: 0 as Player,
    roundWind: 0 as Wind,
    roundNumber: 1,
    honba: 0,
    kyotaku: 0,
    phase: 'discard',
    turnCount: 5,
    lastDiscard: null,
    lastDiscardPlayer: null,
    lastDrawnTile: null,
    ippatsu: false,
    ...overrides,
  }
}

function totalOnTable(state: GameState): number {
  const playerSum = state.players.reduce((s, p) => s + p.score, 0)
  return playerSum + state.kyotaku * 1000
}

describe('applyTsumo — yonma child tsumo', () => {
  // Hand: 1m2m3m 7m8m9m 2p3p4p 6p7p8p 6s6s — pinhu + menzen tsumo only.
  // 1han30fu pinhu+tsumo: pinhu tsumo is 20 fu though, so basic =
  // 20 * 2^(2+2) = 320. Actually the test uses tsumoChild from
  // calculatePoints. Let's use a hand that gives a clean score.
  //
  // For a 1han 30fu tsumo (e.g. yakuhai-only? Need yakuhai tsumo with
  // no other yaku). Hand: 1m1m 2p3p4p 6p7p8p 5s6s7s 31 31 31, win 1m
  // (tanki). Yaku: yakuhai (haku, 1 han). Tsumo: menzen tsumo (1 han).
  // Wait that's 2 han.
  //
  // Easier: use the plan's exact target. "子家 1 番 30 符四麻自摸:庄付
  // 500, 2 子各付 300". 1han30fu basic = 240. Each child pays 300,
  // dealer pays 500. Total winner gets = 1100 (no honba/kyotaku).
  //
  // Construct an open hand with just yakuhai-haku for 1 han (no menzen
  // tsumo since open). Then fu = 30-ish. Open haku triplet pon in
  // melds, plus other simples in hand.
  //
  // Use: melds = [pon haku 31], hand = 4m5m6m 7m8m9m 2p3p4p 5s5s — that's
  // 11 + 3 = 14 with winning. Hand 13 = 4m5m6m 7m8m9m 2p3p4p 5s. Win 5s
  // (tanki 5s). Open. Yaku: yakuhai haku (1 han). Fu calculation:
  //   base 20 + 2 (tsumo) + 2 (tanki) + 4 (open haku pon: minkou
  //   terminal/honor 2*2 = 4) = 28 → ceil 30. Basic = 30 * 2^(2+1) = 240.
  //   Each child pays 300, dealer pays 500.

  it('1han30fu child tsumo: dealer pays 500, each other child pays 300, no honba/kyotaku', () => {
    const handTiles: TileType[] = [3, 4, 5, 6, 7, 8, 10, 11, 12, 22, 22] // 4m5m6m 7m8m9m 2p3p4p 5s5s — 11 tiles
    // Wait: that's only 11. Need 14 - meld(3) = 11. With tsumo, hand = 12
    // including draw. Hmm. For tsumo: hand = 14 - meldTiles. With one pon
    // (3 tiles), hand = 11. Plus winning tile (already in hand for tsumo) =
    // 11 wait that means hand has 11 tiles.
    // Actually: total 14 tiles = handConcealed + meldsTiles + winning.
    // For one pon (3 tiles) and tsumo (winning in hand): handConcealed = 11.
    // Let me recount: 4m5m6m(3) + 7m8m9m(3) + 2p3p4p(3) + 5s5s(2) = 11. ✓
    // Tsumo wins on 5s tanki — but then hand has 5s already (only 2). Need
    // 5s to be the just-drawn tile. So 2x 5s including drawn. ✓ winning=22.
    const meld = { type: 'pon' as const, tiles: [31, 31, 31] as TileType[], calledFrom: 1 as Player }
    const winnerHand: TileType[] = handTiles
    const winner = 1 as Player // P1 = child (dealer is P0)

    const players = [
      makePlayer({ score: 25000 }), // P0 dealer
      makePlayer({ hand: winnerHand, melds: [meld], isMenzen: false, score: 25000 }), // P1 winner
      makePlayer({ score: 25000 }),
      makePlayer({ score: 25000 }),
    ] as GameState['players']

    const state = makeState({
      players,
      currentPlayer: winner,
      dealer: 0 as Player,
      lastDrawnTile: 22 as TileType,
      phase: 'discard',
    })

    const before = totalOnTable(state)
    const after = applyTsumo(state)
    expect(after.phase).toBe('tsumo_win')
    // Dealer (P0) pays 500, P2 + P3 each pay 300. Winner (P1) gets 500+300+300=1100.
    expect(after.players[0].score).toBe(25000 - 500)
    expect(after.players[1].score).toBe(25000 + 1100)
    expect(after.players[2].score).toBe(25000 - 300)
    expect(after.players[3].score).toBe(25000 - 300)
    // Conservation: total points unchanged.
    expect(totalOnTable(after)).toBe(before)
  })

  it('dealer mangan tsumo yonma: each non-dealer pays 4000', () => {
    // Construct dealer (P0) tsumo winning a clear mangan. Use 5han hand:
    // riichi + tanyao + pinhu + ippatsu + menzen tsumo = 5 han easily, but
    // those need menzen. Easier: use a dora-heavy hand that totals 5 han.
    //
    // Actually, for testing settlement payments, we just need a winning
    // hand with the right han count. Let's pick: dealer in seat E at round
    // E. Hand: pinhu (1) + menzen tsumo (1) + riichi (1) + ippatsu (1) +
    // tanyao (1) = 5 han.
    // Tiles: 2m3m4m 5m6m7m 2p3p4p 5p6p 4s4s, draw 7p (ryanmen high of 5p6p).
    // 14 tiles. Tanyao? 2-7m, 2-4p, 5p6p, 4s. All simples. ✓.
    // Pinhu: all sequences, simple pair, ryanmen wait. ✓.
    // Tsumo: yes. Riichi: yes. Ippatsu: yes.
    const hand: TileType[] = [1, 2, 3, 4, 5, 6, 10, 11, 12, 13, 14, 15, 21, 21]
    const players = [
      makePlayer({ hand, riichi: true, score: 25000 }),
      makePlayer({ score: 25000 }),
      makePlayer({ score: 25000 }),
      makePlayer({ score: 25000 }),
    ] as GameState['players']

    const state = makeState({
      players,
      currentPlayer: 0 as Player,
      dealer: 0 as Player,
      lastDrawnTile: 15 as TileType,
      ippatsu: true,
      phase: 'discard',
    })

    const before = totalOnTable(state)
    const after = applyTsumo(state)
    expect(after.phase).toBe('tsumo_win')
    // Mangan dealer tsumo: each non-dealer pays 4000.
    expect(after.players[0].score).toBe(25000 + 12000)
    expect(after.players[1].score).toBe(25000 - 4000)
    expect(after.players[2].score).toBe(25000 - 4000)
    expect(after.players[3].score).toBe(25000 - 4000)
    expect(totalOnTable(after)).toBe(before)
  })

  it('honba=2 tsumo: each non-winner pays an extra 200 (HONBA_TSUMO * 2)', () => {
    // Same setup as 1han30fu but with honba=2.
    const handTiles: TileType[] = [3, 4, 5, 6, 7, 8, 10, 11, 12, 22, 22]
    const meld = { type: 'pon' as const, tiles: [31, 31, 31] as TileType[], calledFrom: 1 as Player }
    const players = [
      makePlayer({ score: 25000 }),
      makePlayer({ hand: handTiles, melds: [meld], isMenzen: false, score: 25000 }),
      makePlayer({ score: 25000 }),
      makePlayer({ score: 25000 }),
    ] as GameState['players']
    const state = makeState({
      players,
      currentPlayer: 1 as Player,
      dealer: 0 as Player,
      lastDrawnTile: 22 as TileType,
      honba: 2,
    })

    const before = totalOnTable(state)
    const after = applyTsumo(state)
    // Honba: 100 * 2 = 200 per non-winner. Dealer pays 500+200=700, each
    // child pays 300+200=500. Winner gets 700+500+500=1700.
    expect(after.players[0].score).toBe(25000 - 700)
    expect(after.players[1].score).toBe(25000 + 1700)
    expect(after.players[2].score).toBe(25000 - 500)
    expect(after.players[3].score).toBe(25000 - 500)
    expect(totalOnTable(after)).toBe(before)
  })

  it('kyotaku=3 tsumo: winner collects 3000 extra, kyotaku resets to 0', () => {
    const handTiles: TileType[] = [3, 4, 5, 6, 7, 8, 10, 11, 12, 22, 22]
    const meld = { type: 'pon' as const, tiles: [31, 31, 31] as TileType[], calledFrom: 1 as Player }
    const players = [
      makePlayer({ score: 25000 }),
      makePlayer({ hand: handTiles, melds: [meld], isMenzen: false, score: 25000 }),
      makePlayer({ score: 25000 }),
      makePlayer({ score: 25000 }),
    ] as GameState['players']
    const state = makeState({
      players,
      currentPlayer: 1 as Player,
      dealer: 0 as Player,
      lastDrawnTile: 22 as TileType,
      kyotaku: 3, // 3 sticks on table, 3000 to winner
    })

    const before = totalOnTable(state)
    const after = applyTsumo(state)
    expect(after.kyotaku).toBe(0)
    // 1han30fu: 1100 + 3000 kyotaku = 4100 collected.
    expect(after.players[1].score).toBe(25000 + 1100 + 3000)
    expect(after.players[0].score).toBe(25000 - 500)
    expect(after.players[2].score).toBe(25000 - 300)
    expect(after.players[3].score).toBe(25000 - 300)
    // Conservation: prior kyotaku-on-table folded into winner. Total
    // (player_sum + kyotaku*1000) unchanged.
    expect(totalOnTable(after)).toBe(before)
  })
})

describe('applyTsumo — sanma', () => {
  it('sanma child tsumo: dealer pays double, single other child pays basic', () => {
    // Sanma: dealer P0, winner P1 (child), payer P2 (child).
    // Construct same 1han30fu open haku hand. In sanma there are only
    // 2 non-winners; dealer pays 500, the other child pays 300.
    const meld = { type: 'pon' as const, tiles: [31, 31, 31] as TileType[], calledFrom: 0 as Player }
    // Sanma hand: avoid 2m-8m. Use pin/sou/honors only.
    // 2p3p4p 6p7p8p 5s6s7s 9p9p — that's 11 tiles, plus pon haku = 14.
    // Tsumo on 9p (tanki). 1 han haku. Fu: 20 + 2(tsumo) + 2(tanki) +
    // 4(open haku pon term/honor) = 28 → 30. basic = 240.
    const handTiles: TileType[] = [10, 11, 12, 14, 15, 16, 22, 23, 24, 17, 17]
    const players = [
      makePlayer({ score: 35000 }),
      makePlayer({ hand: handTiles, melds: [meld], isMenzen: false, score: 35000 }),
      makePlayer({ score: 35000 }),
    ] as GameState['players']
    const state = makeState({
      playerCount: 3,
      players,
      currentPlayer: 1 as Player,
      dealer: 0 as Player,
      lastDrawnTile: 17 as TileType,
    })

    const before = totalOnTable(state)
    const after = applyTsumo(state)
    expect(after.phase).toBe('tsumo_win')
    // P0 (dealer) pays 500; P2 (child) pays 300. P1 collects 800.
    expect(after.players[0].score).toBe(35000 - 500)
    expect(after.players[1].score).toBe(35000 + 800)
    expect(after.players[2].score).toBe(35000 - 300)
    expect(totalOnTable(after)).toBe(before)
  })
})

describe('applyRon — yonma child ron', () => {
  // Loser P0 (dealer), winner P1 (child). Use a clean mangan ron to keep
  // numbers easy: child mangan ron = 8000.
  // Hand for winner: pinhu + tanyao + riichi + ippatsu + (one dora?) — let's
  // pick a 5-han hand that's clearly valid. Reuse the dealer-mangan-tsumo
  // setup, but as a ron from dealer to child.
  it('child mangan ron: loser pays 8000, winner collects 8000', () => {
    // Hand: 2m3m4m 5m6m7m 2p3p4p 5p6p 4s4s — 13 tiles (ron-shape).
    // Win on 7p (called from dealer's discard). Yaku: pinhu + tanyao +
    // riichi + ippatsu = 4 han. Add daburii? No, just need ≥5 for mangan.
    // Add dora: indicator = 4m → dora = 5m, hand has 5m so +1 dora. With
    // 4 yaku + 1 dora = 5 han = mangan.
    const hand: TileType[] = [1, 2, 3, 4, 5, 6, 10, 11, 12, 13, 14, 21, 21]
    const players = [
      makePlayer({ score: 25000 }), // P0 dealer (loser)
      makePlayer({ hand, riichi: true, score: 25000 }), // P1 winner
      makePlayer({ score: 25000 }),
      makePlayer({ score: 25000 }),
    ] as GameState['players']
    const state = makeState({
      players,
      doraMarkers: [3], // 4m → 5m dora; hand has 1x 5m
      lastDiscard: 15 as TileType, // 7p — completes 5p6p ryanmen
      lastDiscardPlayer: 0 as Player,
      currentPlayer: 0 as Player,
      dealer: 0 as Player,
      ippatsu: true,
      phase: 'respond',
    })

    const before = totalOnTable(state)
    const after = applyAction(state, { kind: ActionKind.Ron, called: 15 as TileType })
    expect(after.phase).toBe('ron_win')
    expect(after.currentPlayer).toBe(1)
    expect(after.players[0].score).toBe(25000 - 8000)
    expect(after.players[1].score).toBe(25000 + 8000)
    expect(after.players[2].score).toBe(25000)
    expect(after.players[3].score).toBe(25000)
    expect(totalOnTable(after)).toBe(before)
  })

  it('dealer mangan ron: loser pays 12000', () => {
    // Dealer (P0) wins by ron from P1's discard. Same hand structure.
    const hand: TileType[] = [1, 2, 3, 4, 5, 6, 10, 11, 12, 13, 14, 21, 21]
    const players = [
      makePlayer({ hand, riichi: true, score: 25000 }), // P0 dealer winner
      makePlayer({ score: 25000 }), // P1 loser
      makePlayer({ score: 25000 }),
      makePlayer({ score: 25000 }),
    ] as GameState['players']
    const state = makeState({
      players,
      doraMarkers: [3],
      lastDiscard: 15 as TileType,
      lastDiscardPlayer: 1 as Player,
      currentPlayer: 1 as Player,
      dealer: 0 as Player,
      ippatsu: true,
      phase: 'respond',
    })
    const before = totalOnTable(state)
    const after = applyAction(state, { kind: ActionKind.Ron, called: 15 as TileType })
    expect(after.phase).toBe('ron_win')
    expect(after.currentPlayer).toBe(0)
    // Dealer mangan = 12000.
    expect(after.players[0].score).toBe(25000 + 12000)
    expect(after.players[1].score).toBe(25000 - 12000)
    expect(totalOnTable(after)).toBe(before)
  })

  it('honba=2 ron: loser pays an extra 600 (HONBA_RON * 2)', () => {
    const hand: TileType[] = [1, 2, 3, 4, 5, 6, 10, 11, 12, 13, 14, 21, 21]
    const players = [
      makePlayer({ score: 25000 }),
      makePlayer({ hand, riichi: true, score: 25000 }),
      makePlayer({ score: 25000 }),
      makePlayer({ score: 25000 }),
    ] as GameState['players']
    const state = makeState({
      players,
      doraMarkers: [3],
      lastDiscard: 15 as TileType,
      lastDiscardPlayer: 0 as Player,
      currentPlayer: 0 as Player,
      dealer: 0 as Player,
      ippatsu: true,
      honba: 2,
      phase: 'respond',
    })
    const before = totalOnTable(state)
    const after = applyAction(state, { kind: ActionKind.Ron, called: 15 as TileType })
    // 8000 (mangan) + 600 honba = 8600.
    expect(after.players[0].score).toBe(25000 - 8600)
    expect(after.players[1].score).toBe(25000 + 8600)
    expect(totalOnTable(after)).toBe(before)
  })

  it('kyotaku=2 ron: winner collects 2000 extra, kyotaku resets to 0', () => {
    const hand: TileType[] = [1, 2, 3, 4, 5, 6, 10, 11, 12, 13, 14, 21, 21]
    const players = [
      makePlayer({ score: 25000 }),
      makePlayer({ hand, riichi: true, score: 25000 }),
      makePlayer({ score: 25000 }),
      makePlayer({ score: 25000 }),
    ] as GameState['players']
    const state = makeState({
      players,
      doraMarkers: [3],
      lastDiscard: 15 as TileType,
      lastDiscardPlayer: 0 as Player,
      currentPlayer: 0 as Player,
      dealer: 0 as Player,
      ippatsu: true,
      kyotaku: 2,
      phase: 'respond',
    })
    const before = totalOnTable(state)
    const after = applyAction(state, { kind: ActionKind.Ron, called: 15 as TileType })
    expect(after.kyotaku).toBe(0)
    // Winner gets 8000 + 2000 kyotaku = 10000.
    expect(after.players[1].score).toBe(25000 + 10000)
    expect(after.players[0].score).toBe(25000 - 8000)
    expect(totalOnTable(after)).toBe(before)
  })
})

describe('applyRon — chankita (sanma)', () => {
  it('chankita ron: kita declarer pays, winner collects', () => {
    // P0 (dealer) declares kita. P1 ron on the North.
    // P1 hand needs to be a winning hand on North (30) with at least one
    // yaku. Construct: hand 1m1m 2p3p4p 6p7p8p 5s6s7s 30 30 — winning 30
    // (tanki on West? no, 30 is North). 13 tiles. Need yaku — chankan?
    // Actually chankita is a special form of chankan? In MJSoul rules
    // chankita usually requires the winning tile to be exactly 30 with a
    // pair already (i.e. shabo or tanki). Let's use riichi + tanki on N.
    // For yaku to fire, we need riichi or some hand-based yaku. Easiest:
    // riichi.
    const hand: TileType[] = [0, 0, 10, 11, 12, 14, 15, 16, 22, 23, 24, 30, 30]
    const players = [
      makePlayer({ hand: [30], score: 35000 }), // P0 declarer (dummy hand)
      makePlayer({ hand, riichi: true, score: 35000 }), // P1 ron-er
      makePlayer({ score: 35000 }),
    ] as GameState['players']
    const state = makeState({
      playerCount: 3,
      players,
      currentPlayer: 0 as Player,
      dealer: 0 as Player,
      phase: 'kita_declare',
    })
    const before = totalOnTable(state)
    const after = applyAction(state, { kind: ActionKind.Ron, called: 30 as TileType })
    expect(after.phase).toBe('ron_win')
    expect(after.currentPlayer).toBe(1)
    // Winner is a child; loser (declarer) is the dealer; child ron = 8000-ish
    // depending on han/fu. We just verify conservation and that the loser
    // is P0 (the kita declarer).
    expect(after.players[0].score).toBeLessThan(35000)
    expect(after.players[1].score).toBeGreaterThan(35000)
    expect(totalOnTable(after)).toBe(before)
  })
})

describe('getValidActions — no-yaku filter', () => {
  it('does not offer Tsumo for a no-yaku winning hand', () => {
    // Open hand with 4 chi melds + tanki on a simple — no yaku at all.
    const meld1 = { type: 'chi' as const, tiles: [0, 1, 2] as TileType[], calledFrom: 1 as Player }
    const meld2 = { type: 'chi' as const, tiles: [4, 5, 6] as TileType[], calledFrom: 1 as Player }
    const meld3 = { type: 'chi' as const, tiles: [10, 11, 12] as TileType[], calledFrom: 1 as Player }
    const meld4 = { type: 'chi' as const, tiles: [13, 14, 15] as TileType[], calledFrom: 1 as Player }
    const hand: TileType[] = [21, 21]
    const players = [
      makePlayer({ hand, melds: [meld1, meld2, meld3, meld4], isMenzen: false, score: 25000 }),
      makePlayer({ score: 25000 }),
      makePlayer({ score: 25000 }),
      makePlayer({ score: 25000 }),
    ] as GameState['players']
    const state = makeState({
      players,
      currentPlayer: 0 as Player,
      dealer: 0 as Player,
      lastDrawnTile: 21 as TileType,
      phase: 'discard',
    })
    const actions = getValidActions(state)
    // The hand IS winning (it decomposes), but has no yaku → Tsumo must
    // not appear.
    expect(actions.some(a => a.kind === ActionKind.Tsumo)).toBe(false)
  })

  it('does not offer Ron for a no-yaku discard win', () => {
    const meld1 = { type: 'chi' as const, tiles: [0, 1, 2] as TileType[], calledFrom: 1 as Player }
    const meld2 = { type: 'chi' as const, tiles: [4, 5, 6] as TileType[], calledFrom: 1 as Player }
    const meld3 = { type: 'chi' as const, tiles: [10, 11, 12] as TileType[], calledFrom: 1 as Player }
    const meld4 = { type: 'chi' as const, tiles: [13, 14, 15] as TileType[], calledFrom: 1 as Player }
    // P1 has open hand with 4 chi + 1 tile (4s) waiting on tanki for 4s.
    const responderHand: TileType[] = [21]
    const players = [
      makePlayer({ score: 25000 }), // P0 discarder
      makePlayer({ hand: responderHand, melds: [meld1, meld2, meld3, meld4], isMenzen: false, score: 25000 }), // P1
      makePlayer({ score: 25000 }),
      makePlayer({ score: 25000 }),
    ] as GameState['players']
    const state = makeState({
      players,
      currentPlayer: 0 as Player,
      dealer: 0 as Player,
      lastDiscard: 21 as TileType,
      lastDiscardPlayer: 0 as Player,
      phase: 'respond',
    })
    const actions = getValidActions(state)
    expect(actions.some(a => a.kind === ActionKind.Ron)).toBe(false)
  })

  it('offers Ron for a riichi hand on a discarded tile (riichi is a yaku)', () => {
    const hand: TileType[] = [1, 2, 3, 4, 5, 6, 10, 11, 12, 13, 14, 21, 21]
    const players = [
      makePlayer({ score: 25000 }),
      makePlayer({ hand, riichi: true, score: 25000 }),
      makePlayer({ score: 25000 }),
      makePlayer({ score: 25000 }),
    ] as GameState['players']
    const state = makeState({
      players,
      currentPlayer: 0 as Player,
      dealer: 0 as Player,
      lastDiscard: 15 as TileType,
      lastDiscardPlayer: 0 as Player,
      phase: 'respond',
    })
    const actions = getValidActions(state)
    expect(actions.some(a => a.kind === ActionKind.Ron && a.called === 15)).toBe(true)
  })
})

describe('applyTsumo — defensive checks', () => {
  it('rejects no-yaku tsumo (returns state unchanged)', () => {
    // Open 4-chi hand with no yaku — should NEVER be reachable in normal
    // play because getValidActions filters it. But applyTsumo is the
    // backstop.
    const meld1 = { type: 'chi' as const, tiles: [0, 1, 2] as TileType[], calledFrom: 1 as Player }
    const meld2 = { type: 'chi' as const, tiles: [4, 5, 6] as TileType[], calledFrom: 1 as Player }
    const meld3 = { type: 'chi' as const, tiles: [10, 11, 12] as TileType[], calledFrom: 1 as Player }
    const meld4 = { type: 'chi' as const, tiles: [13, 14, 15] as TileType[], calledFrom: 1 as Player }
    const hand: TileType[] = [21, 21] // 4s pair, drew 21 to win tanki
    const players = [
      makePlayer({ hand, melds: [meld1, meld2, meld3, meld4], isMenzen: false, score: 25000 }),
      makePlayer({ score: 25000 }),
      makePlayer({ score: 25000 }),
      makePlayer({ score: 25000 }),
    ] as GameState['players']
    const state = makeState({
      players,
      currentPlayer: 0 as Player,
      dealer: 0 as Player,
      lastDrawnTile: 21 as TileType,
    })

    const after = applyTsumo(state)
    // Phase unchanged (still discard), scores unchanged.
    expect(after.phase).toBe('discard')
    for (let i = 0; i < 4; i++) {
      expect(after.players[i].score).toBe(25000)
    }
  })
})

describe('Phase D — riichi deduction + honba progression', () => {
  describe('D.1 riichi -1000', () => {
    it('riichi declaration: player.score decreases by 1000, kyotaku increments', () => {
      const hand: TileType[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14]
      const players = [
        makePlayer({ hand, isMenzen: true, score: 25000 }),
        makePlayer({ score: 25000 }),
        makePlayer({ score: 25000 }),
        makePlayer({ score: 25000 }),
      ] as GameState['players']
      const state = makeState({
        players,
        currentPlayer: 0 as Player,
        phase: 'discard',
      })

      const before = totalOnTable(state)
      const after = applyAction(state, { kind: ActionKind.Riichi, tile: 14 })
      expect(after.players[0].score).toBe(24000)
      expect(after.kyotaku).toBe(1)
      expect(after.players[0].riichi).toBe(true)
      // Conservation: the 1000 deducted from player is now in kyotaku
      expect(totalOnTable(after)).toBe(before)
    })

    it('riichi + immediate tsumo: kyotaku stick collected by winner', () => {
      // After riichi (kyotaku=1, score-1000), player wins by tsumo.
      // Winner should collect the kyotaku stick (via settlement).
      // Hand: 2m3m4m 5m6m7m 2p3p4p 5p6p7p + pair 9m9m = 14 tiles
      // Yaku: riichi + menzen tsumo + pinhu = 3 han
      const hand: TileType[] = [1, 2, 3, 4, 5, 6, 8, 8, 10, 11, 12, 13, 14, 15]
      const players = [
        makePlayer({ hand, riichi: true, isMenzen: true, score: 24000 }),
        makePlayer({ score: 25000 }),
        makePlayer({ score: 25000 }),
        makePlayer({ score: 25000 }),
      ] as GameState['players']
      const state = makeState({
        players,
        currentPlayer: 0 as Player,
        dealer: 0 as Player,
        lastDrawnTile: 15 as TileType,
        kyotaku: 1,
        phase: 'discard',
      })

      const before = totalOnTable(state)
      const after = applyTsumo(state)
      expect(after.phase).toBe('tsumo_win')
      expect(after.kyotaku).toBe(0) // collected by winner
      expect(after.players[0].score).toBeGreaterThan(24000)
      expect(totalOnTable(after)).toBe(before)
    })

    it('riichi + ryukyoku: kyotaku stays on table across rounds', () => {
      // Player declared riichi (kyotaku=1, riichi=true). Round ends in ryukyoku.
      // Dealer is riichi → tenpai → renchan. Kyotaku persists to next round.
      const hand: TileType[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13]
      const players = [
        makePlayer({ hand, riichi: true, score: 24000 }),
        makePlayer({ score: 25000 }),
        makePlayer({ score: 25000 }),
        makePlayer({ score: 25000 }),
      ] as GameState['players']
      const state = makeState({
        players,
        currentPlayer: 0 as Player,
        dealer: 0 as Player,
        kyotaku: 1,
        phase: 'ryukyoku',
      })

      const before = totalOnTable(state)
      const next = nextRound(state)
      expect(next.dealer).toBe(0) // renchan (riichi → tenpai)
      expect(next.roundNumber).toBe(1)
      expect(next.honba).toBe(1)
      expect(next.kyotaku).toBe(1) // persists
      expect(next.phase).toBe('draw')
      expect(totalOnTable(next)).toBe(before)
    })

    it('riichi action NOT offered when player.score < 1000', () => {
      // Mahjong Soul rule: riichi requires ≥1000 to put down the stick.
      // Hand: 1m..9m + 1p2p3p + 5p (tenpai for any pair)
      const hand: TileType[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13]
      // Need 14 tiles with one drawn for the discard phase
      const fullHand: TileType[] = [...hand, 14] as TileType[]
      const players = [
        makePlayer({ hand: fullHand, isMenzen: true, score: 500 }),
        makePlayer({ score: 25000 }),
        makePlayer({ score: 25000 }),
        makePlayer({ score: 25000 }),
      ] as GameState['players']
      const state = makeState({
        players,
        currentPlayer: 0 as Player,
        phase: 'discard',
        lastDrawnTile: 14 as TileType,
      })

      const actions = getValidActions(state)
      expect(actions.some(a => a.kind === ActionKind.Riichi)).toBe(false)
    })

    it('riichi action offered when player.score >= 1000', () => {
      // Same setup as above but with 1000 points exactly
      const hand: TileType[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13]
      const fullHand: TileType[] = [...hand, 14] as TileType[]
      const players = [
        makePlayer({ hand: fullHand, isMenzen: true, score: 1000 }),
        makePlayer({ score: 25000 }),
        makePlayer({ score: 25000 }),
        makePlayer({ score: 25000 }),
      ] as GameState['players']
      const state = makeState({
        players,
        currentPlayer: 0 as Player,
        phase: 'discard',
        lastDrawnTile: 14 as TileType,
      })

      const actions = getValidActions(state)
      expect(actions.some(a => a.kind === ActionKind.Riichi)).toBe(true)
    })

    it('riichi candidates include EVERY qualifying tile, not just the first', () => {
      // Hand: 4 different tiles, multiple of which yield shanten=0 after
      // discard. Construct a hand where discarding 9m OR 5p both keep tenpai.
      // 1m2m3m 4m5m6m 7m8m9m 1p2p3p 5p9m (14 tiles, drew 9m)
      // Discard 9m → 1m2m3m 4m5m6m 7m8m 1p2p3p 5p (13) → tenpai
      // Discard 5p → 1m2m3m 4m5m6m 7m8m9m9m 1p2p3p (13) → tenpai (9m pair)
      // Both Riichi:8 (9m) and Riichi:13 (5p) should appear.
      const hand: TileType[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 8, 9, 10, 11, 13] // 1m-9m + 9m + 1p2p3p + 5p
      const players = [
        makePlayer({ hand, isMenzen: true, score: 25000 }),
        makePlayer({ score: 25000 }),
        makePlayer({ score: 25000 }),
        makePlayer({ score: 25000 }),
      ] as GameState['players']
      const state = makeState({
        players,
        currentPlayer: 0 as Player,
        phase: 'discard',
        lastDrawnTile: 13 as TileType,
      })

      const actions = getValidActions(state)
      const riichiActions = actions.filter(a => a.kind === ActionKind.Riichi)
      // Multiple qualifying tiles → multiple riichi candidates
      expect(riichiActions.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe('D.2 nextRound honba / dealer rotation', () => {
    it('dealer tsumo → honba +1, dealer unchanged', () => {
      const state = makeState({
        dealer: 0 as Player,
        currentPlayer: 0 as Player,
        honba: 0,
        phase: 'tsumo_win',
      })
      const next = nextRound(state)
      expect(next.dealer).toBe(0)
      expect(next.currentPlayer).toBe(0)
      expect(next.roundNumber).toBe(1)
      expect(next.honba).toBe(1)
    })

    it('child tsumo → honba = 0, dealer rotates', () => {
      const state = makeState({
        dealer: 0 as Player,
        currentPlayer: 1 as Player,
        honba: 2,
        phase: 'tsumo_win',
      })
      const next = nextRound(state)
      expect(next.dealer).toBe(1)
      expect(next.currentPlayer).toBe(1)
      expect(next.roundNumber).toBe(2)
      expect(next.honba).toBe(0)
    })

    it('child ron → honba = 0, dealer rotates', () => {
      const state = makeState({
        dealer: 0 as Player,
        currentPlayer: 2 as Player,
        honba: 3,
        phase: 'ron_win',
      })
      const next = nextRound(state)
      expect(next.dealer).toBe(1)
      expect(next.roundNumber).toBe(2)
      expect(next.honba).toBe(0)
    })

    it('ryukyoku dealer tenpai (riichi) → honba +1, dealer unchanged', () => {
      const players = [
        makePlayer({ riichi: true, score: 24000 }),
        makePlayer({ score: 25000 }),
        makePlayer({ score: 25000 }),
        makePlayer({ score: 25000 }),
      ] as GameState['players']
      const state = makeState({
        players,
        dealer: 0 as Player,
        honba: 0,
        phase: 'ryukyoku',
      })
      const next = nextRound(state)
      expect(next.dealer).toBe(0)
      expect(next.roundNumber).toBe(1)
      expect(next.honba).toBe(1)
    })

    it('ryukyoku dealer tenpai (shanten=0) → honba +1, dealer unchanged', () => {
      // Tenpai hand: 1m2m3m 4m5m6m 7m8m9m 1p1p 2p3p — 13 tiles
      // = (0,1,2)(3,4,5)(6,7,8) + pair(9,9) + partial(10,11) → shanten=0
      const tenpaiHand: TileType[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 10, 11]
      const players = [
        makePlayer({ hand: tenpaiHand, score: 25000 }),
        makePlayer({ score: 25000 }),
        makePlayer({ score: 25000 }),
        makePlayer({ score: 25000 }),
      ] as GameState['players']
      const state = makeState({
        players,
        dealer: 0 as Player,
        honba: 2,
        phase: 'ryukyoku',
      })
      const next = nextRound(state)
      expect(next.dealer).toBe(0) // renchan
      expect(next.roundNumber).toBe(1)
      expect(next.honba).toBe(3)
    })

    it('ryukyoku dealer noten → honba +1, dealer rotates', () => {
      // Scattered hand with high shanten (definitely not tenpai)
      const notenHand: TileType[] = [0, 2, 5, 9, 12, 15, 18, 21, 24, 27, 28, 29, 30]
      const players = [
        makePlayer({ hand: notenHand, score: 25000 }),
        makePlayer({ score: 25000 }),
        makePlayer({ score: 25000 }),
        makePlayer({ score: 25000 }),
      ] as GameState['players']
      const state = makeState({
        players,
        dealer: 0 as Player,
        honba: 0,
        phase: 'ryukyoku',
      })
      const next = nextRound(state)
      expect(next.dealer).toBe(1) // rotated
      expect(next.roundNumber).toBe(2)
      expect(next.honba).toBe(1)
    })

    it('conservation: sum(scores) + kyotaku*1000 invariant across nextRound', () => {
      const players = [
        makePlayer({ score: 30000, riichi: true }),
        makePlayer({ score: 20000 }),
        makePlayer({ score: 25000 }),
        makePlayer({ score: 25000 }),
      ] as GameState['players']
      const state = makeState({
        players,
        dealer: 0 as Player,
        kyotaku: 2,
        honba: 1,
        phase: 'ryukyoku',
      })
      const before = totalOnTable(state)
      const next = nextRound(state)
      expect(totalOnTable(next)).toBe(before)
    })
  })
})

describe('Phase E — ryukyoku tenpai payments', () => {
  // Tenpai hand (shanten=0): 1m2m3m 4m5m6m 7m8m9m 1p1p 2p3p
  const tenpaiHand: TileType[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 10, 11]
  // Noten hand (high shanten): scattered tiles
  const notenHand: TileType[] = [0, 2, 5, 9, 12, 15, 18, 21, 24, 27, 28, 29, 30]
  // Kokushi tenpai (13 orphans): one of each terminal/honor — tenpai for any of 13 tiles
  const kokushiTenpai: TileType[] = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33]
  // Noten with 9+ terminal types: triple 1m, pairs of 9m/1p, isolated terminals.
  // Kokushi shanten = 13 - 9 - 1 = 3; regular shanten very high. NOT tenpai.
  const notenKyushuHand: TileType[] = [0, 0, 0, 8, 8, 9, 9, 17, 18, 26, 27, 28, 29]

  // All tests use the Kyushukyuhai action path to trigger
  // applyRyukyokuTenpaiPayments (it's an internal function).

  describe('yonma (4-player)', () => {
    const starting = 25000

    it('1/3 tenpai: tenpai player +3000, 3 noten each -1000', () => {
      const players = [
        makePlayer({ hand: notenKyushuHand, score: starting }),
        makePlayer({ hand: tenpaiHand, score: starting }),
        makePlayer({ hand: notenHand, score: starting }),
        makePlayer({ hand: notenHand, score: starting }),
      ] as GameState['players']
      const state = makeState({ players, phase: 'discard', turnCount: 1 })

      const before = totalOnTable(state)
      const after = applyAction(state, { kind: ActionKind.Kyushukyuhai })
      expect(after.phase).toBe('ryukyoku')
      expect(after.players[0].score).toBe(starting - 1000) // noten
      expect(after.players[1].score).toBe(starting + 3000) // tenpai
      expect(after.players[2].score).toBe(starting - 1000) // noten
      expect(after.players[3].score).toBe(starting - 1000) // noten
      expect(totalOnTable(after)).toBe(before)
    })

    it('2/2 tenpai: each tenpai +1500, each noten -1500', () => {
      const players = [
        makePlayer({ hand: notenKyushuHand, score: starting }),
        makePlayer({ hand: tenpaiHand, score: starting }),
        makePlayer({ hand: tenpaiHand, score: starting }),
        makePlayer({ hand: notenHand, score: starting }),
      ] as GameState['players']
      const state = makeState({ players, phase: 'discard', turnCount: 1 })

      const before = totalOnTable(state)
      const after = applyAction(state, { kind: ActionKind.Kyushukyuhai })
      expect(after.phase).toBe('ryukyoku')
      expect(after.players[0].score).toBe(starting - 1500) // noten
      expect(after.players[1].score).toBe(starting + 1500) // tenpai
      expect(after.players[2].score).toBe(starting + 1500) // tenpai
      expect(after.players[3].score).toBe(starting - 1500) // noten
      expect(totalOnTable(after)).toBe(before)
    })

    it('3/1: each tenpai +1000, 1 noten -3000', () => {
      const players = [
        makePlayer({ hand: notenKyushuHand, score: starting }),
        makePlayer({ hand: tenpaiHand, score: starting }),
        makePlayer({ hand: tenpaiHand, score: starting }),
        makePlayer({ hand: tenpaiHand, score: starting }),
      ] as GameState['players']
      const state = makeState({ players, phase: 'discard', turnCount: 1 })

      const before = totalOnTable(state)
      const after = applyAction(state, { kind: ActionKind.Kyushukyuhai })
      expect(after.phase).toBe('ryukyoku')
      expect(after.players[0].score).toBe(starting - 3000) // noten
      expect(after.players[1].score).toBe(starting + 1000) // tenpai
      expect(after.players[2].score).toBe(starting + 1000) // tenpai
      expect(after.players[3].score).toBe(starting + 1000) // tenpai
      expect(totalOnTable(after)).toBe(before)
    })

    it('0/4 all noten: no payment', () => {
      const players = [
        makePlayer({ hand: notenKyushuHand, score: starting }),
        makePlayer({ hand: notenHand, score: starting }),
        makePlayer({ hand: notenHand, score: starting }),
        makePlayer({ hand: notenHand, score: starting }),
      ] as GameState['players']
      const state = makeState({ players, phase: 'discard', turnCount: 1 })

      const after = applyAction(state, { kind: ActionKind.Kyushukyuhai })
      expect(after.phase).toBe('ryukyoku')
      for (let i = 0; i < 4; i++) {
        expect(after.players[i].score).toBe(starting)
      }
    })

    it('4/4 all tenpai: no payment', () => {
      // P0: kokushi tenpai (13 orphans). P1-P3: tenpai hand.
      const players = [
        makePlayer({ hand: kokushiTenpai, score: starting }),
        makePlayer({ hand: tenpaiHand, score: starting }),
        makePlayer({ hand: tenpaiHand, score: starting }),
        makePlayer({ hand: tenpaiHand, score: starting }),
      ] as GameState['players']
      const state = makeState({ players, phase: 'discard', turnCount: 1 })

      const before = totalOnTable(state)
      const after = applyAction(state, { kind: ActionKind.Kyushukyuhai })
      expect(after.phase).toBe('ryukyoku')
      // All 4 tenpai → no payment
      for (let i = 0; i < 4; i++) {
        expect(after.players[i].score).toBe(starting)
      }
      expect(totalOnTable(after)).toBe(before)
    })
  })

  describe('sanma (3-player)', () => {
    const starting = 35000

    it('1/2: tenpai player +3000, 2 noten each -1500', () => {
      const players = [
        makePlayer({ hand: notenKyushuHand, score: starting }),
        makePlayer({ hand: tenpaiHand, score: starting }),
        makePlayer({ hand: notenHand, score: starting }),
      ] as GameState['players']
      const state = makeState({ playerCount: 3, players, phase: 'discard', turnCount: 1 })

      const before = totalOnTable(state)
      const after = applyAction(state, { kind: ActionKind.Kyushukyuhai })
      expect(after.phase).toBe('ryukyoku')
      expect(after.players[0].score).toBe(starting - 1500) // noten
      expect(after.players[1].score).toBe(starting + 3000) // tenpai
      expect(after.players[2].score).toBe(starting - 1500) // noten
      expect(totalOnTable(after)).toBe(before)
    })

    it('2/1: each tenpai +1500, 1 noten -3000', () => {
      const players = [
        makePlayer({ hand: notenKyushuHand, score: starting }),
        makePlayer({ hand: tenpaiHand, score: starting }),
        makePlayer({ hand: tenpaiHand, score: starting }),
      ] as GameState['players']
      const state = makeState({ playerCount: 3, players, phase: 'discard', turnCount: 1 })

      const before = totalOnTable(state)
      const after = applyAction(state, { kind: ActionKind.Kyushukyuhai })
      expect(after.phase).toBe('ryukyoku')
      expect(after.players[0].score).toBe(starting - 3000) // noten
      expect(after.players[1].score).toBe(starting + 1500) // tenpai
      expect(after.players[2].score).toBe(starting + 1500) // tenpai
      expect(totalOnTable(after)).toBe(before)
    })

    it('0/3 all noten: no change', () => {
      const players = [
        makePlayer({ hand: notenKyushuHand, score: starting }),
        makePlayer({ hand: notenHand, score: starting }),
        makePlayer({ hand: notenHand, score: starting }),
      ] as GameState['players']
      const state = makeState({ playerCount: 3, players, phase: 'discard', turnCount: 1 })

      const after = applyAction(state, { kind: ActionKind.Kyushukyuhai })
      expect(after.phase).toBe('ryukyoku')
      for (let i = 0; i < 3; i++) {
        expect(after.players[i].score).toBe(starting)
      }
    })

    it('3/3 all tenpai: no change', () => {
      const players = [
        makePlayer({ hand: kokushiTenpai, score: starting }),
        makePlayer({ hand: tenpaiHand, score: starting }),
        makePlayer({ hand: tenpaiHand, score: starting }),
      ] as GameState['players']
      const state = makeState({ playerCount: 3, players, phase: 'discard', turnCount: 1 })

      const before = totalOnTable(state)
      const after = applyAction(state, { kind: ActionKind.Kyushukyuhai })
      expect(after.phase).toBe('ryukyoku')
      for (let i = 0; i < 3; i++) {
        expect(after.players[i].score).toBe(starting)
      }
      expect(totalOnTable(after)).toBe(before)
    })
  })

  describe('special cases', () => {
    it('riichi player is always tenpai even if shanten ≠ 0', () => {
      // P0 and P2 have notenKyushuHand (high shanten) but riichi=true → tenpai
      // P1 and P3 have notenHand (high shanten) and riichi=false → noten
      const starting = 25000
      const players = [
        makePlayer({ hand: notenKyushuHand, riichi: true, score: starting }),
        makePlayer({ hand: notenHand, score: starting }),
        makePlayer({ hand: notenKyushuHand, riichi: true, score: starting }),
        makePlayer({ hand: notenHand, score: starting }),
      ] as GameState['players']
      const state = makeState({ players, phase: 'discard', turnCount: 1 })

      const before = totalOnTable(state)
      const after = applyAction(state, { kind: ActionKind.Kyushukyuhai })
      expect(after.phase).toBe('ryukyoku')
      // 2/2: P0 tenpai (riichi), P1 noten, P2 tenpai (riichi), P3 noten
      expect(after.players[0].score).toBe(starting + 1500)
      expect(after.players[1].score).toBe(starting - 1500)
      expect(after.players[2].score).toBe(starting + 1500)
      expect(after.players[3].score).toBe(starting - 1500)
      expect(totalOnTable(after)).toBe(before)
    })

    it('conservation: sum(scores) + kyotaku × 1000 = N × startingScore', () => {
      const starting = 25000
      const players = [
        makePlayer({ hand: notenKyushuHand, score: starting }),
        makePlayer({ hand: tenpaiHand, score: starting }),
        makePlayer({ hand: notenHand, score: starting }),
        makePlayer({ hand: notenHand, score: starting }),
      ] as GameState['players']
      const state = makeState({
        players,
        phase: 'discard',
        turnCount: 1,
        kyotaku: 2,
      })

      const before = totalOnTable(state)
      const after = applyAction(state, { kind: ActionKind.Kyushukyuhai })
      expect(after.phase).toBe('ryukyoku')
      // 1/3 split. Payments are zero-sum; kyotaku unchanged.
      expect(after.kyotaku).toBe(2)
      expect(totalOnTable(after)).toBe(before)
    })
  })
})

describe('Phase F — tobi + game-over + finalRanking', () => {
  describe('checkTobi', () => {
    it('returns true when any player score < 0', () => {
      const players = [
        makePlayer({ score: 30000 }),
        makePlayer({ score: -500 }),
        makePlayer({ score: 25000 }),
        makePlayer({ score: 25000 }),
      ] as GameState['players']
      const state = makeState({ players })
      expect(checkTobi(state)).toBe(true)
    })

    it('returns false when all scores >= 0', () => {
      const players = [
        makePlayer({ score: 0 }),
        makePlayer({ score: 25000 }),
        makePlayer({ score: 25000 }),
        makePlayer({ score: 25000 }),
      ] as GameState['players']
      const state = makeState({ players })
      expect(checkTobi(state)).toBe(false)
    })
  })

  describe('tobi → game_over', () => {
    it('child ron tobi: nextRound produces game_over', () => {
      const players = [
        makePlayer({ score: -500 }), // busted
        makePlayer({ score: 50500 }),
        makePlayer({ score: 25000 }),
        makePlayer({ score: 25000 }),
      ] as GameState['players']
      const state = makeState({
        players,
        dealer: 0 as Player,
        currentPlayer: 1 as Player,
        phase: 'ron_win',
      })
      const before = totalOnTable(state)
      const next = nextRound(state)
      expect(next.phase).toBe('game_over')
      expect(totalOnTable(next)).toBe(before)
    })

    it('multiple players negative: still finalizes correctly', () => {
      const players = [
        makePlayer({ score: -2000 }),
        makePlayer({ score: -500 }),
        makePlayer({ score: 53000 }),
        makePlayer({ score: 25000 }),
      ] as GameState['players']
      const state = makeState({
        players,
        dealer: 0 as Player,
        currentPlayer: 2 as Player,
        phase: 'tsumo_win',
      })
      const before = totalOnTable(state)
      const next = nextRound(state)
      expect(next.phase).toBe('game_over')
      expect(totalOnTable(next)).toBe(before)
    })
  })

  describe('half-wall end (all rounds played)', () => {
    it('round 8 completed → game_over', () => {
      const state = makeState({
        dealer: 0 as Player,
        currentPlayer: 1 as Player,
        roundNumber: 8,
        endRound: 8,
        phase: 'ron_win',
      })
      const next = nextRound(state)
      expect(next.phase).toBe('game_over')
    })

    it('round 7 completed → round 8 starts (not game_over)', () => {
      const state = makeState({
        dealer: 0 as Player,
        currentPlayer: 1 as Player,
        roundNumber: 7,
        endRound: 8,
        phase: 'ron_win',
      })
      const next = nextRound(state)
      expect(next.phase).toBe('draw')
      expect(next.roundNumber).toBe(8)
    })
  })

  describe('final kyotaku distribution', () => {
    it('kyotaku=1: top player gets +1000, kyotaku resets to 0', () => {
      const players = [
        makePlayer({ score: 30000 }),
        makePlayer({ score: 20000 }),
        makePlayer({ score: 25000 }),
        makePlayer({ score: 25000 }),
      ] as GameState['players']
      const state = makeState({
        players,
        dealer: 0 as Player,
        currentPlayer: 1 as Player,
        roundNumber: 8,
        endRound: 8,
        kyotaku: 1,
        phase: 'ron_win',
      })
      const before = totalOnTable(state)
      const next = nextRound(state)
      expect(next.phase).toBe('game_over')
      expect(next.kyotaku).toBe(0)
      expect(next.players[0].score).toBe(31000) // top player gets +1000
      expect(totalOnTable(next)).toBe(before)
    })

    it('kyotaku=3: top player gets +3000', () => {
      const players = [
        makePlayer({ score: 30000 }),
        makePlayer({ score: 20000 }),
        makePlayer({ score: 25000 }),
        makePlayer({ score: 25000 }),
      ] as GameState['players']
      const state = makeState({
        players,
        dealer: 0 as Player,
        currentPlayer: 1 as Player,
        roundNumber: 8,
        endRound: 8,
        kyotaku: 3,
        phase: 'ron_win',
      })
      const before = totalOnTable(state)
      const next = nextRound(state)
      expect(next.phase).toBe('game_over')
      expect(next.kyotaku).toBe(0)
      expect(next.players[0].score).toBe(33000)
      expect(totalOnTable(next)).toBe(before)
    })

    it('kyotaku=0: no score adjustment needed', () => {
      const players = [
        makePlayer({ score: -500 }),
        makePlayer({ score: 50500 }),
        makePlayer({ score: 25000 }),
        makePlayer({ score: 25000 }),
      ] as GameState['players']
      const state = makeState({
        players,
        dealer: 0 as Player,
        currentPlayer: 1 as Player,
        kyotaku: 0,
        phase: 'ron_win',
      })
      const before = totalOnTable(state)
      const next = nextRound(state)
      expect(next.phase).toBe('game_over')
      expect(next.kyotaku).toBe(0)
      expect(next.players[0].score).toBe(-500)
      expect(totalOnTable(next)).toBe(before)
    })
  })

  describe('finalRanking', () => {
    it('sorts by score descending', () => {
      const players = [
        makePlayer({ score: 20000 }),
        makePlayer({ score: 40000 }),
        makePlayer({ score: 15000 }),
        makePlayer({ score: 25000 }),
      ] as GameState['players']
      const state = makeState({ players, dealer: 0 as Player })
      const ranking = finalRanking(state)
      expect(ranking[0]).toEqual({ player: 1, score: 40000, rank: 1 })
      expect(ranking[1]).toEqual({ player: 3, score: 25000, rank: 2 })
      expect(ranking[2]).toEqual({ player: 0, score: 20000, rank: 3 })
      expect(ranking[3]).toEqual({ player: 2, score: 15000, rank: 4 })
    })

    it('tied scores: dealer first, then lower player index', () => {
      const players = [
        makePlayer({ score: 25000 }),
        makePlayer({ score: 25000 }),
        makePlayer({ score: 25000 }),
        makePlayer({ score: 25000 }),
      ] as GameState['players']
      const state = makeState({ players, dealer: 2 as Player })
      const ranking = finalRanking(state)
      expect(ranking[0].player).toBe(2) // dealer first
      expect(ranking[1].player).toBe(0) // lower index
      expect(ranking[2].player).toBe(1)
      expect(ranking[3].player).toBe(3)
    })

    it('sanma: returns 3 entries', () => {
      const players = [
        makePlayer({ score: 35000 }),
        makePlayer({ score: 25000 }),
        makePlayer({ score: 45000 }),
      ] as GameState['players']
      const state = makeState({ playerCount: 3, players, dealer: 0 as Player })
      const ranking = finalRanking(state)
      expect(ranking).toHaveLength(3)
      expect(ranking[0]).toEqual({ player: 2, score: 45000, rank: 1 })
      expect(ranking[1]).toEqual({ player: 0, score: 35000, rank: 2 })
      expect(ranking[2]).toEqual({ player: 1, score: 25000, rank: 3 })
    })
  })

  describe('conservation through finalizeGame', () => {
    it('sum(scores) + kyotaku*1000 invariant holds', () => {
      const players = [
        makePlayer({ score: -500 }),
        makePlayer({ score: 30500 }),
        makePlayer({ score: 25000 }),
        makePlayer({ score: 25000 }),
      ] as GameState['players']
      const state = makeState({
        players,
        dealer: 0 as Player,
        currentPlayer: 1 as Player,
        kyotaku: 2,
        phase: 'ron_win',
      })
      const before = totalOnTable(state)
      const next = nextRound(state)
      expect(next.phase).toBe('game_over')
      expect(next.kyotaku).toBe(0)
      expect(totalOnTable(next)).toBe(before)
    })
  })
})

describe('Phase G — integration: full hanchan simulation', () => {
  const runHanchans = (count: number, playerCount: 3 | 4, endRound: number) => {
    const difficulties = Array(playerCount).fill(0)
    const startingScore = playerCount === 3 ? 35000 : 25000
    const totalStartScore = playerCount * startingScore
    const rankings: ReturnType<typeof finalRanking>[] = []

    for (let g = 0; g < count; g++) {
      let state = createGame({ playerCount, endRound })
      const SAFETY = 5000

      for (let safety = 0; safety < SAFETY; safety++) {
        if (state.phase === 'game_over') break
        const actions = getValidActions(state)
        if (actions.length === 0) break

        const acting = state.currentPlayer
        const action = state.phase === 'respond'
          ? chooseRespondAction(state, difficulties)
          : state.phase === 'kita_declare'
          ? chooseKitaDeclareAction(state, difficulties)
          : chooseAction(state, actions, difficulties[acting])

        state = applyAction(state, action)

        if (state.phase === 'tsumo_win' || state.phase === 'ron_win' || state.phase === 'ryukyoku') {
          state = nextRound(state)
        }
      }

      const ranking = finalRanking(state)
      rankings.push(ranking)

      // Conservation: sum(player.scores) + kyotaku*1000 = N * startingScore
      // After game_over, finalizeGame distributes kyotaku so sum(scores) = N*start.
      // If game didn't reach game_over (safety limit), kyotaku may still be on table.
      const totalScore = state.players.reduce((sum, p) => sum + p.score, 0)
      const onTable = totalScore + state.kyotaku * 1000
      expect(Math.abs(onTable - totalStartScore)).toBeLessThan(100)
    }

    return { rankings, playerCount, startingScore }
  }

  it('yonma: 2 hanchans — finalRanking length = playerCount, total score conserved, avgRank in bounds', { timeout: 360_000 }, () => {
    const { rankings, playerCount } = runHanchans(2, 4, 8)

    for (const ranking of rankings) {
      expect(ranking.length).toBe(playerCount)
      // All ranks should be 1..4
      const ranks = ranking.map(r => r.rank)
      expect(Math.min(...ranks)).toBeGreaterThanOrEqual(1)
      expect(Math.max(...ranks)).toBeLessThanOrEqual(playerCount)
      // Ranks should be a permutation of [1, 2, 3, 4]
      expect([...ranks].sort()).toEqual([1, 2, 3, 4])
    }
  })

  it('sanma: 2 hanchans — finalRanking length = 3, total score conserved, avgRank in bounds', { timeout: 360_000 }, () => {
    const { rankings, playerCount } = runHanchans(2, 3, 8)

    for (const ranking of rankings) {
      expect(ranking.length).toBe(playerCount)
      const ranks = ranking.map(r => r.rank)
      expect(Math.min(...ranks)).toBeGreaterThanOrEqual(1)
      expect(Math.max(...ranks)).toBeLessThanOrEqual(playerCount)
      expect([...ranks].sort()).toEqual([1, 2, 3])
    }
  })

  it('avgRank across hanchans is in [1, N]', { timeout: 240_000 }, () => {
    const { rankings, playerCount } = runHanchans(2, 4, 4)

    // Accumulate avg rank for each player
    const rankSums = new Array(playerCount).fill(0)
    for (const ranking of rankings) {
      for (const { player, rank } of ranking) {
        rankSums[player] += rank
      }
    }
    for (let p = 0; p < playerCount; p++) {
      const avgRank = rankSums[p] / rankings.length
      expect(avgRank).toBeGreaterThanOrEqual(1)
      expect(avgRank).toBeLessThanOrEqual(playerCount)
    }
  })
})
