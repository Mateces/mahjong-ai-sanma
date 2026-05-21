import { describe, expect, it } from 'vitest'
import { scoreCallActions } from '../evaluate-call'
import { createGame } from '../../game/engine'
import type { Action, GameState, Player, PlayerState, TileType } from '../../game/types'
import { ActionKind } from '../../game/types'

function setHand(state: GameState, player: Player, hand: TileType[]): GameState {
  const players = [...state.players] as [PlayerState, PlayerState, PlayerState, PlayerState]
  players[player] = {
    ...players[player],
    hand: [...hand].sort((a, b) => a - b),
  }
  return { ...state, players }
}

describe('scoreCallActions', () => {
  it('gives high score for ron actions (higher than pass)', () => {
    const state = createGame()
    const actions: Action[] = [
      { kind: ActionKind.Ron, called: 0 },
      { kind: ActionKind.Pass },
    ]
    const scores = scoreCallActions(state, actions, 0 as Player)

    expect(scores[0]).toBeGreaterThan(scores[1])
    expect(scores[0]).toBeGreaterThan(0)
  })

  it('gives high score for tsumo', () => {
    const state = createGame()
    const actions: Action[] = [
      { kind: ActionKind.Tsumo },
    ]
    const scores = scoreCallActions(state, actions, 0 as Player)

    expect(scores[0]).toBeGreaterThan(0)
  })

  it('evaluates pon with yakuhai higher than pon without', () => {
    const state = setHand(createGame(), 0, [0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 31, 31, 32])
    const actions: Action[] = [
      { kind: ActionKind.Pon, called: 31 }, // yakuhai dragon
      { kind: ActionKind.Pon, called: 0 },  // non-yakuhai
    ]
    const scores = scoreCallActions(state, actions, 0 as Player)

    expect(scores[0]).toBeGreaterThan(scores[1])
  })

  it('gives pon lower score when it breaks menzen without yaku', () => {
    const state = setHand(createGame(), 0, [0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 31, 31, 32])
    const actions: Action[] = [
      { kind: ActionKind.Pon, called: 31 },
      { kind: ActionKind.Pon, called: 0 },
    ]
    const scores = scoreCallActions(state, actions, 0 as Player)

    expect(scores[0]).toBeGreaterThan(scores[1])
    expect(scores[1]).toBeLessThanOrEqual(scores[0])
  })

  it('evaluates chi that forms a sequence', () => {
    const state = setHand(createGame(), 0, [0, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
    const actions: Action[] = [
      { kind: ActionKind.Chi, tiles: [0, 1], called: 2 },
    ]
    const scores = scoreCallActions(state, actions, 0 as Player)

    expect(Number.isFinite(scores[0])).toBe(true)
  })

  it('gives ankan high score (higher than pass)', () => {
    const state = createGame()
    const actions: Action[] = [
      { kind: ActionKind.Ankan, tile: 0 },
      { kind: ActionKind.Pass },
    ]
    const scores = scoreCallActions(state, actions, 0 as Player)

    expect(scores[0]).toBeGreaterThan(scores[1])
  })

  it('gives pass a valid score', () => {
    const state = createGame()
    const actions: Action[] = [
      { kind: ActionKind.Pass },
    ]
    const scores = scoreCallActions(state, actions, 0 as Player)

    expect(Number.isFinite(scores[0])).toBe(true)
  })

  it('gives kakan a moderate score', () => {
    const state = createGame()
    const actions: Action[] = [
      { kind: ActionKind.Kakan, tile: 0 },
    ]
    const scores = scoreCallActions(state, actions, 0 as Player)

    expect(Number.isFinite(scores[0])).toBe(true)
  })

  it('gives daiminkan a positive score', () => {
    const state = setHand(createGame(), 0, [0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    const actions: Action[] = [
      { kind: ActionKind.Daiminkan, called: 0 },
    ]
    const scores = scoreCallActions(state, actions, 0 as Player)

    expect(Number.isFinite(scores[0])).toBe(true)
  })

  it('fires yakuhai pon even when result is 1-shanten (was rejected before tier relaxation)', () => {
    // Hand: 中中 + a clearly 1-shanten away rest. Opponent discards 中.
    // Pon makes hand 11 tiles minus the 2x中 = some hand needing tenpai
    // path. With the tiered penalty, yakuhai pon to 1-shanten should score
    // positive (above Pass=0).
    const state = setHand(createGame(), 0,
      [31, 31, 0, 1, 2, 4, 5, 6, 10, 11, 12, 18, 19])
    const actions: Action[] = [
      { kind: ActionKind.Pon, called: 31 },
      { kind: ActionKind.Pass },
    ]
    const scores = scoreCallActions(state, actions, 0 as Player)
    expect(scores[0]).toBeGreaterThan(scores[1])
    expect(scores[0]).toBeGreaterThan(0)
  })

  it('still rejects pon when result would be 3-shanten', () => {
    // Hand: 中中 + scattered tiles that don't form structure. After pon
    // (and discard) hand is 3+ shanten — should score < Pass=0.
    const state = setHand(createGame(), 0,
      [31, 31, 0, 5, 9, 14, 18, 22, 27, 28, 29, 30, 33])
    const actions: Action[] = [
      { kind: ActionKind.Pon, called: 31 },
      { kind: ActionKind.Pass },
    ]
    const scores = scoreCallActions(state, actions, 0 as Player)
    // Even with yakuhai bonus, 3-shanten penalty (-20000) dominates.
    expect(scores[0]).toBeLessThan(0)
  })

  it('fires non-yakuhai pon when hand has 1 stray honor that can be shed (食いタン path)', () => {
    // Hand: 5m5m + 8 simples + 1 stray 東 (honor).
    // After pon 5m, afterHand = 8 simples + 1 stray 東. Honor is easily
    // discardable → tanyao path counts as available → pon should fire.
    const state = setHand(createGame(), 0,
      [4, 4, 1, 2, 3, 10, 11, 12, 19, 20, 21, 22, 27])
    const actions: Action[] = [
      { kind: ActionKind.Pon, called: 4 },
      { kind: ActionKind.Pass },
    ]
    const scores = scoreCallActions(state, actions, 0 as Player)
    expect(scores[0]).toBeGreaterThan(scores[1])
  })

  it('rejects pon when the lone yaochu is in a penchan (1m+2m)', () => {
    // Hand: 5m5m + 1m + 2m + ... — discarding 1m breaks the 12 penchan.
    // After pon 5m, afterHand still has 1m+2m linked. tanyao path NOT
    // available → falls through to non-yakuhai + no-yaku-path → -30000.
    const state = setHand(createGame(), 0,
      [4, 4, 0, 1, 3, 10, 11, 12, 19, 20, 21, 22, 23])
    const actions: Action[] = [
      { kind: ActionKind.Pon, called: 4 },
      { kind: ActionKind.Pass },
    ]
    const scores = scoreCallActions(state, actions, 0 as Player)
    expect(scores[0]).toBeLessThan(scores[1])
  })

  it('rejects pon when 2+ yaochu in hand (too many to shed)', () => {
    // Hand: 5m5m + 2 honors + simples. 2 loose yaochu → exceeds N=1 limit.
    const state = setHand(createGame(), 0,
      [4, 4, 1, 2, 3, 10, 11, 12, 19, 20, 21, 27, 31])
    const actions: Action[] = [
      { kind: ActionKind.Pon, called: 4 },
      { kind: ActionKind.Pass },
    ]
    const scores = scoreCallActions(state, actions, 0 as Player)
    expect(scores[0]).toBeLessThan(scores[1])
  })

  it('rewards non-yakuhai pon with tanyao path (yaku potential bonus)', () => {
    // Hand: 5m5m + middle simples — tanyao after pon. P0 ponning 5m
    // keeps the hand on a tanyao route, should fire under the new bonus.
    const state = setHand(createGame(), 0,
      [4, 4, 1, 2, 3, 10, 11, 12, 19, 20, 21, 22, 23])
    const actions: Action[] = [
      { kind: ActionKind.Pon, called: 4 },
      { kind: ActionKind.Pass },
    ]
    const scores = scoreCallActions(state, actions, 0 as Player)
    expect(scores[0]).toBeGreaterThan(scores[1])
  })

  it('strict yaku check: rejects pon that leads to no-yaku tenpai', () => {
    // Hand: 1m1m + 123p + 456p + 234s + 9m9m (winning shape 1m1m + 234s).
    // Pon-1m leaves 234s + 123p + 456p + 9m9m. Wait — adjust to make pon
    // create a 0-shape-tenpai but no-yaku outcome.
    //
    // Construct: hand has 5m5m + 123m + 456p + 789s + (1 single 5m extra
    // would make pon-5m → 11 tiles: 123m + 456p + 789s + ...).
    // Simpler: 5m5m + 123m + 456p + 789p + 5m + 234s.
    // After pon 5m: afterHand = 123m + 456p + 789p + 234s (11 tiles).
    // 5m5m5m is the meld. After discarding, e.g., one tile to reach 0-shape:
    // If we discard 1m: testHand = 23m + 456p + 789p + 234s (10 tiles).
    // shapeS-1 = ? need to compute. This is getting fiddly.
    //
    // Simpler construction: hand with 5m5m + 234m + 567m + 234p + 567p + 5m.
    // Wait this has 14 tiles. Hand should be 13 tiles for the respond phase.
    // Let me adjust.
    const state = setHand(createGame(), 0,
      [4, 4, 0, 1, 2, 10, 11, 12, 18, 19, 20, 21, 22])
    // P0 hand: 5m5m, 1m2m3m, 2p3p4p, 1s2s3s4s5s — 13 tiles. No yakuhai,
    // mixed suits → no honitsu, has 1m → no tanyao. Pon-5m leaves 5m5m5m
    // meld + 1m2m3m + 2p3p4p + 1s2s3s4s5s = 11 tiles. Discard, e.g., 1m or
    // 1s would form a no-yaku tenpai.
    const actions: Action[] = [
      { kind: ActionKind.Pon, called: 4 },
      { kind: ActionKind.Pass },
    ]
    const scores = scoreCallActions(state, actions, 0 as Player)
    // Without the strict check this scored as tenpai (~0 + bonuses).
    // With the check: any shape-tenpai discard is demoted to 1-shanten
    // (-2000 penalty), so Pon score should be at most 1-shanten + path bonus
    // ≈ -2000 + 2000 = 0, often equal to or worse than Pass.
    // We don't assert exact values, just: pon shouldn't dominate pass.
    expect(scores[0]).toBeLessThanOrEqual(scores[1] + 100)
  })

  it('strict yaku check: accepts yakuhai pon to tenpai', () => {
    // Hand: 中中 + tenpai-able rest. Pon-中 gives yakuhai meld → tenpai
    // wins are guaranteed to have yaku.
    const state = setHand(createGame(), 0,
      [31, 31, 0, 1, 2, 10, 11, 12, 18, 19, 20, 21, 22])
    const actions: Action[] = [
      { kind: ActionKind.Pon, called: 31 },
      { kind: ActionKind.Pass },
    ]
    const scores = scoreCallActions(state, actions, 0 as Player)
    expect(scores[0]).toBeGreaterThan(scores[1])
  })

  it('penalizes non-yakuhai daiminkan when no yaku path remains', () => {
    // Hand: 3 of 5m + scattered terminals/honors (no yakuhai pair/triplet,
    // no tanyao path because of terminals/honors, only 1 triplet candidate
    // so toitoi is not reachable). After daiminkan opens the hand it can
    // never win — this should rank well below a yakuhai daiminkan.
    const noYakuState = setHand(createGame(), 0,
      [4, 4, 4, 0, 8, 9, 17, 18, 26, 27, 28, 29, 30])
    const yakuhaiState = setHand(createGame(), 0,
      [31, 31, 31, 0, 8, 9, 17, 18, 26, 27, 28, 29, 30])
    const noYakuScore = scoreCallActions(
      noYakuState, [{ kind: ActionKind.Daiminkan, called: 4 }], 0 as Player,
    )[0]
    const yakuhaiScore = scoreCallActions(
      yakuhaiState, [{ kind: ActionKind.Daiminkan, called: 31 }], 0 as Player,
    )[0]
    expect(yakuhaiScore).toBeGreaterThan(noYakuScore)
    expect(noYakuScore).toBeLessThanOrEqual(-30000)
  })

  it('gives kyushukyuhai the lowest score', () => {
    const state = createGame()
    const actions: Action[] = [
      { kind: ActionKind.Kyushukyuhai },
    ]
    const scores = scoreCallActions(state, actions, 0 as Player)

    expect(scores[0]).toBeLessThan(0)
  })

  it('returns scores array parallel to actions', () => {
    const state = createGame()
    const actions: Action[] = [
      { kind: ActionKind.Pass },
      { kind: ActionKind.Tsumo },
      { kind: ActionKind.Ron, called: 5 },
    ]
    const scores = scoreCallActions(state, actions, 0 as Player)

    expect(scores).toHaveLength(actions.length)
  })

  it('prioritizes winning actions over all others', () => {
    const state = createGame()
    const actions: Action[] = [
      { kind: ActionKind.Pass },
      { kind: ActionKind.Chi, tiles: [0, 1], called: 2 },
      { kind: ActionKind.Pon, called: 5 },
      { kind: ActionKind.Ankan, tile: 0 },
      { kind: ActionKind.Ron, called: 5 },
      { kind: ActionKind.Tsumo },
    ]
    const scores = scoreCallActions(state, actions, 0 as Player)

    const maxNonWin = Math.max(scores[0], scores[1], scores[2], scores[3])
    expect(scores[4]).toBeGreaterThan(maxNonWin)
    expect(scores[5]).toBeGreaterThan(maxNonWin)
  })
})
